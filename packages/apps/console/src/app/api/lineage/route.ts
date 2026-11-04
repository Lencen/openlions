import { NextResponse } from "next/server";
import { entityLabel } from "@/config/artifactTypes";
import {
  agentMatchSql, asOf, num, one, openMind, openSession, parseAgentOutput, parseInjection, q, resolveRange, round, safeClose, scalar,
} from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// GET /api/lineage?range=24h&agent=&theme=
// 数据血脉: 数据怎么入的 (会话) → 怎么变的 (提炼/结构化) → 怎么存的 (四类产物) → 怎么被用的 (认领注入)
// 只读 + 容错: 库/表缺失时对应区块返回空数组或 0, 绝不 500。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const r = resolveRange(url.searchParams.get("range"));
  const agent = url.searchParams.get("agent") || "";
  const theme = url.searchParams.get("theme") || "";
  const mind = openMind();
  const sess = openSession();
  const warnings: string[] = [];
  if (!mind) warnings.push("管理库不可用：产物 / 使用链路指标已降级");
  if (!sess) warnings.push("会话库不可用：会话入口指标已降级");

  // ---------- 1. 入: 会话 ----------
  const sessConds = ["createdAt > ?"];
  const sessParams: any[] = [r.since];
  if (agent) { sessConds.push("agentId = ?"); sessParams.push(agent); }
  const sessWhere = sessConds.join(" AND ");
  const inflowSessions = await scalar(sess, `SELECT COUNT(*) c FROM Session WHERE ${sessWhere}`, ...sessParams);
  const inflowMessages = await scalar(sess, `SELECT COALESCE(SUM(messageCount),0) c FROM Session WHERE ${sessWhere}`, ...sessParams);
  const extractedSessions = await scalar(
    sess,
    `SELECT COUNT(*) c FROM Session WHERE extractStatus='DONE' AND COALESCE(extractedAt, updatedAt) > ?${agent ? " AND agentId = ?" : ""}`,
    ...(agent ? [r.since, agent] : [r.since])
  );
  const droppedSessions = await scalar(
    sess,
    `SELECT COUNT(*) c FROM Session WHERE extractStatus IN ('FAILED','SKIPPED') AND COALESCE(extractedAt, updatedAt) > ?${agent ? " AND agentId = ?" : ""}`,
    ...(agent ? [r.since, agent] : [r.since])
  );

  // 未提炼积压 (全量口径)
  const backlog = {
    skippedSessions: scalar(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus='SKIPPED'"),
    skippedMessages: scalar(sess, "SELECT COALESCE(SUM(messageCount),0) c FROM Session WHERE extractStatus='SKIPPED'"),
    pendingSessions: scalar(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus IS NULL OR extractStatus='PENDING'"),
    pendingMessages: scalar(sess, "SELECT COALESCE(SUM(messageCount),0) c FROM Session WHERE extractStatus IS NULL OR extractStatus='PENDING'"),
    failedSessions: scalar(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus='FAILED'"),
    processingSessions: scalar(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus='PROCESSING'"),
    skippedInRange: scalar(sess, `SELECT COUNT(*) c FROM Session WHERE extractStatus='SKIPPED' AND COALESCE(updatedAt, createdAt) > ?`, r.since),
    skippedByAgent: q(
      sess,
      "SELECT agentId, COUNT(*) sessions, COALESCE(SUM(messageCount),0) messages FROM Session WHERE extractStatus='SKIPPED' GROUP BY agentId ORDER BY sessions DESC LIMIT 12"
    ),
    reasonHint: "SKIPPED 多为消息数过少(如单条消息会话)或按策略跳过的会话, 该部分数据不会进入认知产物。",
  };

  // ---------- 2. 变/存: 四类产物 ----------
  const tables: { table: string; idCol: string; titleCol: string; agentCol: string | null; extra: string[] }[] = [
    { table: "Memory", idCol: "id", titleCol: "COALESCE(title, substr(content,1,60))", agentCol: "agentSource", extra: ["theme", "sourceType", "sourceId", "qualityScore"] },
    { table: "Knowledge", idCol: "id", titleCol: "title", agentCol: "agentSource", extra: ["theme", "sourceType", "sourceId", "qualityScore", "verification", "humanConfirmed", "usageCount", "lastUsedAt"] },
    { table: "Practice", idCol: "id", titleCol: "title", agentCol: "agentSource", extra: ["theme", "sourceType", "sourceId", "qualityScore"] },
    { table: "Skill", idCol: "id", titleCol: "name", agentCol: null, extra: ["theme", "category", "source", "qualityScore"] },
  ];

  const byTable: Record<string, any> = {};
  const sourceMix: Record<string, { sourceType: string; total: number; byTable: Record<string, number> }> = {};
  const artifacts: any[] = [];
  let productTotal = 0;

  for (const t of tables) {
    const conds = ["createdAt > ?"];
    const params: any[] = [r.since];
    if (theme) { conds.push("theme = ?"); params.push(theme); }
    if (agent && t.agentCol) {
      const am = agentMatchSql(agent, ["sourceType", "agentSource"]);
      conds.push(am.sql);
      params.push(...am.params);
    }
    const where = conds.join(" AND ");
    const n = await scalar(mind, `SELECT COUNT(*) c FROM ${t.table} WHERE ${where}`, ...params);
    productTotal += n;
    const stat = await one(
      mind,
      `SELECT COUNT(*) n, AVG(CASE WHEN qualityScore > 0 THEN qualityScore END) avgQ, ` +
        `SUM(CASE WHEN qualityScore IS NULL OR qualityScore <= 0 THEN 1 ELSE 0 END) unscored ` +
        `FROM ${t.table} WHERE ${where}`,
      ...params
    );
    byTable[t.table] = {
      n,
      avg: round(stat?.avgQ, 3),
      unscored: num(stat?.unscored),
      total: scalar(mind, `SELECT COUNT(*) c FROM ${t.table}`),
    };

    // 来源构成
    const srcRows = await q(
      mind,
      `SELECT COALESCE(sourceType,'(未标注)') sourceType, COUNT(*) c FROM ${t.table} WHERE ${where} GROUP BY sourceType ORDER BY c DESC LIMIT 12`,
      ...params
    );
    for (const s of srcRows) {
      const key = s.sourceType || "(未标注)";
      if (!sourceMix[key]) sourceMix[key] = { sourceType: key, total: 0, byTable: {} };
      sourceMix[key].total += num(s.c);
      sourceMix[key].byTable[t.table] = num(s.c);
    }

    // 最近产物样本 (供点击追溯)
    const cols = [`${t.idCol} id`, `${t.titleCol} title`, "createdAt", ...t.extra];
    const rows = await q(
      mind,
      `SELECT ${cols.join(", ")} FROM ${t.table} WHERE ${where} ORDER BY createdAt DESC LIMIT 12`,
      ...params
    );
    for (const row of rows) {
      artifacts.push({
        table: t.table,
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
        theme: row.theme ?? null,
        sourceType: row.sourceType ?? row.source ?? t.table,
        sourceId: row.sourceId ?? null,
        qualityScore: row.qualityScore ?? null,
        verification: row.verification ?? null,
        humanConfirmed: row.humanConfirmed ?? null,
        usageCount: row.usageCount ?? row.totalUsageCount ?? null,
        lastUsedAt: row.lastUsedAt ?? null,
      });
    }
  }
  artifacts.sort((a, b) => num(b.createdAt) - num(a.createdAt));

  // Knowledge 验证态
  const verification = {
    pending: scalar(mind, "SELECT COUNT(*) c FROM Knowledge WHERE verification='PENDING_REVIEW'"),
    verified: scalar(mind, "SELECT COUNT(*) c FROM Knowledge WHERE verification IN ('VERIFIED','PROPOSAL_ACCEPTED')"),
    rejected: scalar(mind, "SELECT COUNT(*) c FROM Knowledge WHERE verification='REJECTED'"),
    humanConfirmed: scalar(mind, "SELECT COUNT(*) c FROM Knowledge WHERE humanConfirmed=1"),
    unverified: scalar(mind, "SELECT COUNT(*) c FROM Knowledge WHERE verification IS NULL"),
  };

  // ---------- 3. 用: 认领 / 注入 ----------
  const injEvents = await q(
    mind,
    "SELECT sourceType, sourceId, sourceTitle, createdAt FROM FlywheelEvent WHERE stage='CONTEXT_INJECTED' AND createdAt > ? ORDER BY createdAt DESC LIMIT 500",
    r.since
  );
  const injByAgent = new Map<string, { agentId: string; events: number; artifacts: number }>();
  const injectedIds = new Set<string>();
  const consumedByTask = new Map<string, { taskId: string; agentId: string; count: number; at: number; kinds: string[] }>();
  for (const e of injEvents) {
    const info = parseInjection(e.sourceTitle);
    for (const id of info.ids) injectedIds.add(id);
    const key = info.agentId || "(未知智能体)";
    const agg = injByAgent.get(key) || { agentId: key, events: 0, artifacts: 0 };
    agg.events += 1;
    agg.artifacts += info.ids.length || info.count;
    injByAgent.set(key, agg);
    if (e.sourceId) {
      const cur = consumedByTask.get(e.sourceId);
      if (cur) { cur.count += info.ids.length || info.count; cur.at = Math.max(cur.at, num(e.createdAt)); }
      else consumedByTask.set(e.sourceId, { taskId: e.sourceId, agentId: info.agentId || "", count: info.ids.length || info.count, at: num(e.createdAt), kinds: info.kinds });
    }
  }
  const consumedTasks = Array.from(consumedByTask.values()).sort((a, b) => b.at - a.at).slice(0, 15);
  for (const t of consumedTasks) {
    if (t.taskId) {
      const task = await one(mind, "SELECT id, title, status, assignedAgent, theme FROM Task WHERE id = ? LIMIT 1", t.taskId);
      (t as any).task = task ? { id: task.id, title: task.title, status: task.status, assignedAgent: task.assignedAgent, theme: task.theme } : null;
    }
  }

  const knowledgeUsage = {
    usedRows: scalar(mind, "SELECT COUNT(*) c FROM Knowledge WHERE usageCount > 0"),
    usageTotal: scalar(mind, "SELECT COALESCE(SUM(usageCount),0) c FROM Knowledge"),
    lastUsedAt: (await one(mind, "SELECT MAX(lastUsedAt) m FROM Knowledge") || {}).m ?? null,
    staleRows: scalar(mind, "SELECT COUNT(*) c FROM Knowledge WHERE stale=1"),
  };

  const agentSubmissions = await q(
    mind,
    "SELECT sourceTitle, createdAt FROM FlywheelEvent WHERE stage='AGENT_OUTPUT_INGESTED' AND createdAt > ? ORDER BY createdAt DESC LIMIT 200",
    r.since
  );
  const submissions = agentSubmissions.map((e) => {
    const p = parseAgentOutput(e.sourceTitle);
    return { agentId: p.agentId, targetKind: p.targetKind, targetId: p.targetId, quality: p.quality, candidate: p.candidate, createdAt: e.createdAt };
  });
  const submissionsByAgent = new Map<string, { agentId: string; n: number; qSum: number; qN: number }>();
  for (const s of submissions) {
    const key = s.agentId || "(未知)";
    const agg = submissionsByAgent.get(key) || { agentId: key, n: 0, qSum: 0, qN: 0 };
    agg.n += 1;
    if (typeof s.quality === "number") { agg.qSum += s.quality; agg.qN += 1; }
    submissionsByAgent.set(key, agg);
  }

  // 端到端链路 (lane 视图)
  const stages = [
    { id: "ingest", label: "① 会话入湖", value: inflowSessions, unit: "个会话", note: `${inflowMessages.toLocaleString("zh-CN")} 条消息 · 窗口内新建会话`, color: "#2563eb" },
    { id: "extract", label: "② 提炼/结构化", value: extractedSessions, unit: "个会话已完成", note: `窗口内 extractStatus=DONE; 另有 ${droppedSessions} 个失败/跳过`, color: "#7c3aed" },
    { id: "store", label: "③ 产物落库", value: productTotal, unit: "条产物", note: `${entityLabel("Memory")} ${byTable.Memory.n} · ${entityLabel("Knowledge")} ${byTable.Knowledge.n} · ${entityLabel("Practice")} ${byTable.Practice.n} · ${entityLabel("Skill")} ${byTable.Skill.n}`, color: "#0d9488" },
    { id: "use", label: "④ 认领/注入使用", value: injEvents.length, unit: "次注入", note: `涉及 ${injectedIds.size} 条产物 · ${consumedByTask.size} 个任务认领`, color: "#d97706" },
    { id: "submit", label: "⑤ 智能体产出回流", value: submissions.length, unit: "次提交", note: "智能体提交后进入验证队列，通过后回写知识库", color: "#db2777" },
  ];

  safeClose(mind, sess);
  return NextResponse.json({
    asOf: asOf(),
    range: { key: r.key, label: r.label, since: r.since },
    filters: { agent: agent || null, theme: theme || null },
    warnings,
    stages,
    intake: {
      inflowSessions, inflowMessages, extractedSessions, droppedSessions,
      byAgent: q(
        sess,
        `SELECT agentId, COUNT(*) sessions, COALESCE(SUM(messageCount),0) messages ` +
          `FROM Session WHERE ${sessWhere} GROUP BY agentId ORDER BY sessions DESC LIMIT 12`,
        ...sessParams
      ),
    },
    backlog,
    products: { total: productTotal, byTable },
    sourceMix: Object.values(sourceMix).sort((a, b) => b.total - a.total).slice(0, 15),
    artifacts: artifacts.slice(0, 24),
    verification,
    consumption: {
      injectionEvents: injEvents.length,
      injectedArtifacts: injectedIds.size,
      consumedTasks: consumedByTask.size,
      byAgent: Array.from(injByAgent.values()).sort((a, b) => b.events - a.events),
      recent: consumedTasks,
      knowledgeUsage,
      submissions: submissions.slice(0, 20),
      submissionsByAgent: Array.from(submissionsByAgent.values())
        .map((a) => ({ ...a, avgQuality: a.qN ? round(a.qSum / a.qN, 3) : null }))
        .sort((a, b) => b.n - a.n),
    },
    recentEvents: q(
      mind,
      "SELECT stage, sourceType, sourceTitle, targetStage, createdAt FROM FlywheelEvent WHERE createdAt > ? ORDER BY createdAt DESC LIMIT 20",
      r.since
    ),
  });
}
