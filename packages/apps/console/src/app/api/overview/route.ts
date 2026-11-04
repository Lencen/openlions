import { NextResponse } from "next/server";
import {
  agentMatchSql, asOf, bucketExpr, bucketIndex, makeBuckets, num, one, openMind, openSession, parseTokenTitle, q, queryFailures, resolveRange, round, safeClose, scalar,
} from "@/lib/server/lions-db";
import { IMPROVEMENT_TYPES, TASK_SCOPES, improvementTypeSql, scopeOfType } from "@/config/taskScopes";
import { macsAdminKey } from "@/lib/server/macs-admin";

export const dynamic = "force-dynamic";

// GET /api/overview?range=24h&agent=&theme=
// 概览首页数据: 今日(所选时间窗) 会话流入 / 提炼产物 / 任务完成失败 / 活跃 agent / token 消耗 / 质量分
// 全部只读; 任一库或表不可用时该指标降级为 0/-1 并返回 warnings, 不抛 500。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const r = resolveRange(url.searchParams.get("range"));
  const agent = url.searchParams.get("agent") || "";
  const theme = url.searchParams.get("theme") || "";
  const now = Date.now();
  const mind = openMind();
  const sess = openSession();
  const warnings: string[] = [];
  // 2026-10-21: 把最近失败的查询暴露出来，避免"方言/参数错 -> 指标全 0"被当成真数据
  for (const f of queryFailures.slice(-3)) warnings.push("query failed: " + String(f.sql).slice(0, 100));
  if (!mind) warnings.push("管理库不可用：认知类指标已降级");
  if (!sess) warnings.push("会话库不可用：会话类指标已降级");

  const buckets = makeBuckets(r, now);
  const bucketOf = (ts: number) => bucketIndex(r, buckets, ts, now);
  const trendFromRows = (rows: any[], key = "hb") => {
    const arr = new Array(buckets.length).fill(0);
    for (const row of rows) {
      const ts = num(row?.[key]);
      const idx = bucketOf(ts);
      if (idx >= 0) arr[idx] += num(row?.c);
    }
    return arr;
  };
  const groupByBucket = async (db: any, table: string, tsCol: string, where: string, params: any[]) => {
    const rows = await q(
      db,
      `SELECT ${bucketExpr(tsCol, r.bucketMs)} hb, COUNT(*) c FROM ${table} WHERE ${where} GROUP BY hb`,
      ...params
    );
    return trendFromRows(rows);
  };

  // ---------------- 1. 会话流入 ----------------
  const sessCommon = ["1=1"];
  const sessParams: any[] = [];
  if (agent) { sessCommon.push("agentId = ?"); sessParams.push(agent); }
  // 2026-10-21: 项目内所有日期比较都走 to_timestamp 形式（与 adaptSql 的 $n 改写一致），避免裸毫秒串
  const sessRange = [`createdAt > to_timestamp(${r.since}::double precision / 1000.0)`];

  const newSessions = await scalar(sess, `SELECT COUNT(*) c FROM Session WHERE ${sessRange[0]} AND ${sessCommon.join(" AND ")}`, ...sessParams);
  const inflowMessages = await scalar(
    sess,
    `SELECT COALESCE(SUM(messageCount),0) c FROM Session WHERE createdAt > ? AND ${sessCommon.join(" AND ")}`,
    r.since, ...sessParams
  );
  const activeSessions = await scalar(
    sess,
    `SELECT COUNT(*) c FROM Session WHERE COALESCE(lastMessageAt, updatedAt) > ? AND ${sessCommon.join(" AND ")}`,
    r.since, ...sessParams
  );
  const extractedSessions = await scalar(
    sess,
    `SELECT COUNT(*) c FROM Session WHERE extractStatus='DONE' AND COALESCE(extractedAt, updatedAt) > ? AND ${sessCommon.join(" AND ")}`,
    r.since, ...sessParams
  );
  const sessionTrend = sess
    ? trendFromRows(await
        q(
          sess,
          `SELECT ${bucketExpr("createdAt", r.bucketMs)} hb, COUNT(*) c FROM Session WHERE createdAt > ? AND ${sessCommon.join(" AND ")} GROUP BY hb`,
          r.since, ...sessParams
        )
      )
    : new Array(buckets.length).fill(0);
  const messageTrend = sess
    ? trendFromRows(await
        q(
          sess,
          `SELECT ${bucketExpr("createdAt", r.bucketMs)} hb, COALESCE(SUM(messageCount),0) c FROM Session WHERE createdAt > ? AND ${sessCommon.join(" AND ")} GROUP BY hb`,
          r.since, ...sessParams
        )
      )
    : new Array(buckets.length).fill(0);

  // 未提炼积压 (全量口径, 不受时间窗限制 —— 这是"欠债"体量)
  const backlog = {
    skippedSessions: await scalar(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus='SKIPPED'"),
    skippedMessages: await scalar(sess, "SELECT COALESCE(SUM(messageCount),0) c FROM Session WHERE extractStatus='SKIPPED'"),
    pendingSessions: await scalar(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus IS NULL OR extractStatus='PENDING'"),
    pendingMessages: await scalar(sess, "SELECT COALESCE(SUM(messageCount),0) c FROM Session WHERE extractStatus IS NULL OR extractStatus='PENDING'"),
    processingSessions: await scalar(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus='PROCESSING'"),
    failedSessions: await scalar(sess, "SELECT COUNT(*) c FROM Session WHERE extractStatus='FAILED'"),
    skippedRecent: await scalar(
      sess,
      `SELECT COUNT(*) c FROM Session WHERE extractStatus='SKIPPED' AND COALESCE(updatedAt, createdAt) > ?`,
      r.since
    ),
  };

  // ---------------- 2. 提炼产物 ----------------
  const artTables: { table: string; tsCol: string; qCol: string; agentCol: string | null; themeCol: string; noAgentSource?: boolean }[] = [
    { table: "Memory", tsCol: "createdAt", qCol: "qualityScore", agentCol: "agentSource", themeCol: "theme" },
    { table: "Knowledge", tsCol: "createdAt", qCol: "qualityScore", agentCol: "agentSource", themeCol: "theme" },
    { table: "Practice", tsCol: "createdAt", qCol: "qualityScore", agentCol: "agentSource", themeCol: "theme" },
    // 技能表既无 sourceType 也无 agentSource: 智能体筛选对其不生效 (用标记位代替表名字符串比较)
    { table: "Skill", tsCol: "createdAt", qCol: "qualityScore", agentCol: null, themeCol: "theme", noAgentSource: true },
    // 2026-10-21（人类要求"需要 reflection 的数据"）：反思也是飞轮产物，此前被漏在"24h 新增 / 趋势"之外。
    //   注意它的质量列叫 score（不是 qualityScore），语义相同。
    { table: "Reflection", tsCol: "createdAt", qCol: "score", agentCol: "agentSource", themeCol: "theme" },
  ];
  const productsByTable: Record<string, any> = {};
  const qualityByTable: Record<string, any> = {};
  const productTrend = new Array(buckets.length).fill(0);
  let productTotal = 0; // 近 24h 新增（口径）
  let productsAll = 0; // 五表总量（全量），2026-10-21 与 total 区分
  let qSum = 0;
  let qN = 0;
  for (const t of artTables) {
    const conds = [`${t.tsCol} > ?`];
    const params: any[] = [r.since];
    if (theme) { conds.push(`${t.themeCol} = ?`); params.push(theme); }
    if (agent) {
      // 产物表没有 agent 外键: 按 sourceType / agentSource 模式尽力归因 (技能表两者皆无, 跳过)
      if (t.noAgentSource) {
        warnings.push("技能表无来源字段，智能体筛选对该表不生效");
      } else {
        const am = agentMatchSql(agent, ["sourceType", "agentSource"]);
        conds.push(am.sql);
        params.push(...am.params);
      }
    }
    const where = conds.join(" AND ");
    const n = await scalar(mind, `SELECT COUNT(*) c FROM ${t.table} WHERE ${where}`, ...params);
    const trend = t.noAgentSource && !mind
      ? new Array(buckets.length).fill(0)
      : await groupByBucket(mind, t.table, t.tsCol, where, params);
    productsByTable[t.table] = { n, trend };
    for (let i = 0; i < trend.length; i++) productTrend[i] += trend[i];
    productTotal += n;
    productsAll += await scalar(mind, `SELECT COUNT(*) c FROM ${t.table}`);

    const st = await one(
      mind,
      `SELECT COUNT(*) n, SUM(CASE WHEN ${t.qCol} IS NULL OR ${t.qCol} <= 0 THEN 1 ELSE 0 END) unscored, ` +
        `AVG(CASE WHEN ${t.qCol} > 0 THEN ${t.qCol} END) AS "avgQ", ` +
        `SUM(CASE WHEN ${t.qCol} >= 0.7 THEN 1 ELSE 0 END) high, ` +
        `SUM(CASE WHEN ${t.qCol} > 0 AND ${t.qCol} < 0.4 THEN 1 ELSE 0 END) low ` +
        `FROM ${t.table} WHERE ${where}`,
      ...params
    );
    const scored = num(st?.n) - num(st?.unscored);
    qualityByTable[t.table] = {
      n: num(st?.n),
      scored,
      unscored: num(st?.unscored),
      avg: round(st?.avgQ, 3),
      high: num(st?.high),
      low: num(st?.low),
    };
    if (scored > 0 && num(st?.avgQ) > 0) { qSum += num(st?.avgQ) * scored; qN += scored; }
  }

  // ---------------- 3. 任务完成 / 失败 ----------------
  const taskConds: string[] = [];
  const taskParams: any[] = [];
  if (agent) { taskConds.push("assignedAgent = ?"); taskParams.push(agent); }
  if (theme) { taskConds.push("theme = ?"); taskParams.push(theme); }
  const taskExtra = taskConds.length ? " AND " + taskConds.join(" AND ") : "";
  // 2026-09-10 任务语义分层: "改进任务"口径 = 机制修复类 (GOAL_GAP + THEME_IMPROVE + PLATFORM_REVIEW),
  // 验证/对话任务不再混入改进任务完成率。
  const mechFilter = ` AND improvementType IN (${improvementTypeSql()})`;
  const taskDone = await scalar(mind, `SELECT COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ?${mechFilter}${taskExtra}`, r.since, ...taskParams);
  const taskFailed = await scalar(mind, `SELECT COUNT(*) c FROM Task WHERE status='FAILED' AND updatedAt > ?${mechFilter}${taskExtra}`, r.since, ...taskParams);
  const taskRunning = await scalar(mind, `SELECT COUNT(*) c FROM Task WHERE status IN ('IN_PROGRESS','PROCESSING')${mechFilter}${taskExtra}`, ...taskParams);
  const taskPending = await scalar(mind, `SELECT COUNT(*) c FROM Task WHERE status='PENDING'${mechFilter}${taskExtra}`, ...taskParams);

  // 各 scope 的任务量 (同一时间窗/筛选), 让页面能诚实说明"还有多少没计入改进任务"
  const taskScopeRows = await q(
    mind,
    `SELECT COALESCE(improvementType,'') type, status, COUNT(*) c FROM Task WHERE ` +
      `(COALESCE(completedAt, updatedAt) > ? OR createdAt > ?)${taskExtra} GROUP BY type, status`,
    r.since, r.since, ...taskParams
  );
  const byScope: Record<string, any> = {};
  for (const s of TASK_SCOPES) {
    if (s.key === "ALL") continue;
    byScope[s.key] = { key: s.key, label: s.label, color: s.color, desc: s.desc, inImprovementMetric: s.inImprovementMetric, all: 0, done: 0, failed: 0, running: 0, pending: 0 };
  }
  for (const row of taskScopeRows) {
    const key = scopeOfType(row.type);
    const agg = byScope[key];
    if (!agg) continue;
    const c = num(row.c);
    agg.all += c;
    if (row.status === "DONE") agg.done += c;
    else if (row.status === "FAILED") agg.failed += c;
    else if (row.status === "IN_PROGRESS" || row.status === "PROCESSING") agg.running += c;
    else if (row.status === "PENDING") agg.pending += c;
  }
  const taskDoneTrend = mind
    ? trendFromRows(await
        q(
          mind,
          `SELECT ${bucketExpr("completedAt", r.bucketMs)} hb, COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ?${mechFilter}${taskExtra} GROUP BY hb`,
          r.since, ...taskParams
        )
      )
    : new Array(buckets.length).fill(0);
  const taskFailedTrend = mind
    ? trendFromRows(await
        q(
          mind,
          `SELECT ${bucketExpr("updatedAt", r.bucketMs)} hb, COUNT(*) c FROM Task WHERE status='FAILED' AND updatedAt > ?${mechFilter}${taskExtra} GROUP BY hb`,
          r.since, ...taskParams
        )
      )
    : new Array(buckets.length).fill(0);

  const recentTasks = await q(
    mind,
    `SELECT id, title, status, assignedAgent, theme, priority, improvementType, updatedAt, completedAt FROM Task ` +
      `WHERE updatedAt > ?${taskExtra} ORDER BY updatedAt DESC LIMIT 12`,
    r.since, ...taskParams
  );

  // ---------------- 4. Agent 活跃 ----------------
  const agentTotal = await scalar(mind, "SELECT COUNT(*) c FROM AgentRegistry");
  const agentActive = await scalar(mind, "SELECT COUNT(*) c FROM AgentRegistry WHERE status='ACTIVE'");
  const agentWorked = await scalar(
    mind,
    `SELECT COUNT(DISTINCT assignedAgent) c FROM Task WHERE assignedAgent IS NOT NULL AND updatedAt > ?`,
    r.since
  );
  const agentExecutions = await scalar(mind, `SELECT COUNT(DISTINCT agentId) c FROM TaskExecution WHERE COALESCE(completedAt, startedAt, createdAt) > ?`, r.since);
  const agentTrend = mind
    ? trendFromRows(await
        q(
          mind,
          `SELECT ${bucketExpr("COALESCE(completedAt, startedAt, createdAt)", r.bucketMs)} hb, COUNT(DISTINCT agentId) c FROM TaskExecution WHERE COALESCE(completedAt, startedAt, createdAt) > ? GROUP BY hb`,
          r.since
        )
      )
    : new Array(buckets.length).fill(0);
  let macsOnline = -1;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    // 2026-10-27(macs-backend-2): MACS_SECURITY_ENFORCE=1 下 /api/agents 需要 x-api-key；
    // 裸 fetch 会被 401（实测 33 次 MISSING_KEY），页面静默降级成"没有 agent"。
    const res = await fetch("http://localhost:8765/api/agents", {
      cache: "no-store",
      signal: ctrl.signal,
      headers: { "x-api-key": macsAdminKey() },
    });
    clearTimeout(timer);
    if (res.ok) {
      const d = await res.json();
      const list: any[] = Array.isArray(d?.agents) ? d.agents : [];
      macsOnline = list.filter((a) => a?.status === "online").length;
    }
  } catch { /* MACS 不可达 */ }

  // ---------------- 5. Token 消耗 (只统计 token 数, 不做金额折算) ----------------
  const llmRows = await q(
    mind,
    "SELECT sourceType, sourceTitle, targetStage, sourceId, createdAt FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt > ? ORDER BY createdAt DESC LIMIT 20000",
    r.since
  );
  const tokenTrend = new Array(buckets.length).fill(0);
  const callTrend = new Array(buckets.length).fill(0);
  const byEntry = new Map<string, { entry: string; calls: number; ok: number; tokens: number; unmeasured: number; estimatedTokens: number; durationMsSum: number }>();
  let tokensMeasured = 0;
  let tokensEstimated = 0;
  let callsMeasured = 0;
  let callsEstimated = 0;
  let callsUnmeasured = 0;
  let charsUnmeasured = 0;
  for (const row of llmRows) {
    const p = parseTokenTitle(row.sourceTitle);
    const idx = bucketOf(num(row.createdAt));
    if (idx >= 0) callTrend[idx] += 1;
    const e = byEntry.get(row.sourceType || "unknown") || {
      entry: row.sourceType || "unknown", calls: 0, ok: 0, tokens: 0, unmeasured: 0, estimatedTokens: 0, durationMsSum: 0,
    };
    e.calls += 1;
    if (row.targetStage === "OK") e.ok += 1;
    e.durationMsSum += num(row.sourceId);
    if (p.kind === "measured" && p.tokens) {
      tokensMeasured += p.tokens; callsMeasured += 1; e.tokens += p.tokens;
      if (idx >= 0) tokenTrend[idx] += p.tokens;
    } else if (p.kind === "estimated" && p.tokens) {
      tokensEstimated += p.tokens; callsEstimated += 1; e.estimatedTokens += p.tokens;
      if (idx >= 0) tokenTrend[idx] += p.tokens;
    } else {
      callsUnmeasured += 1; e.unmeasured += 1;
      if (p.chars) charsUnmeasured += p.chars;
    }
    byEntry.set(e.entry, e);
  }
  const tokenTotalAll = await scalar(mind, "SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CALL_LLM'");
  const lastCall = await one(mind, "SELECT createdAt, sourceType, sourceTitle FROM FlywheelEvent WHERE stage='CALL_LLM' ORDER BY createdAt DESC LIMIT 1");

  // ---------------- 6. 最近活动 ----------------
  const recentEvents = await q(
    mind,
    "SELECT stage, sourceType, sourceTitle, targetStage, createdAt FROM FlywheelEvent ORDER BY createdAt DESC LIMIT 12"
  );
  const themesTop = await q(
    mind,
    "SELECT theme, COUNT(*) c FROM Memory WHERE theme IS NOT NULL AND theme <> '' GROUP BY theme ORDER BY c DESC LIMIT 8"
  );

  safeClose(mind, sess);

  return NextResponse.json({
    asOf: asOf(),
    range: {
      key: r.key, label: r.label, since: r.since, bucketKind: r.bucketKind, bucketMs: r.bucketMs,
      points: buckets.map((b) => ({ label: b.label, ts: b.ts })),
    },
    filters: { agent: agent || null, theme: theme || null },
    warnings,
    sessions: {
      newSessions, inflowMessages, activeSessions, extractedSessions,
      trend: sessionTrend, messageTrend,
    },
    backlog,
    products: { total: productTotal, totalAll: productsAll, byTable: productsByTable, trend: productTrend },
    tasks: {
      done: taskDone, failed: taskFailed, running: taskRunning, pending: taskPending,
      trend: taskDoneTrend, failTrend: taskFailedTrend,
      recent: recentTasks.map((t: any) => ({ ...t, scope: scopeOfType(t.improvementType) })),
      scope: { key: "MECHANISM", label: "机制修复类", types: IMPROVEMENT_TYPES, note: "GOAL_GAP(机制修复) + THEME_IMPROVE(反思衍生) + PLATFORM_REVIEW(平台复审)" },
      byScope,
    },
    agents: { total: agentTotal, active: agentActive, withTasks: agentWorked, executed: agentExecutions, macsOnline, trend: agentTrend },
    tokens: {
      // 2026-09-11 P2「估算 token 单列(不进总量)」: total 与 /api/token-usage 的 summary.totalTokens 对齐 = 纯实测;
      //   估算(tok≈) 单列 estimatedTokens, combinedTokens 仅作参考展示。
      total: tokensMeasured,
      combinedTokens: tokensMeasured + tokensEstimated,
      measuredTokens: tokensMeasured,
      estimatedTokens: tokensEstimated,
      callsMeasured, callsEstimated, callsUnmeasured, charsUnmeasured,
      totalCalls: llmRows.length,
      allTimeCalls: tokenTotalAll,
      lastCallAt: lastCall?.createdAt ?? null,
      trend: tokenTrend,
      callTrend,
      byEntry: Array.from(byEntry.values())
        .map((e) => ({ ...e, avgMs: e.calls ? Math.round(e.durationMsSum / e.calls) : 0 }))
        .sort((a, b) => b.tokens + b.estimatedTokens - (a.tokens + a.estimatedTokens) || b.calls - a.calls),
    },
    quality: {
      byTable: qualityByTable,
      overall: qN ? round(qSum / qN, 3) : 0,
      scoredTotal: qN,
    },
    themesTop,
    recentEvents,
  });
}