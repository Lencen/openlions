import { NextResponse } from "next/server";
import {
  asOf, num, openMind, parseInjection, q, resolveRange, round, safeClose,
} from "@/lib/server/lions-db";
import { scopeOfType } from "@/config/taskScopes";

export const dynamic = "force-dynamic";

// GET /api/collaboration?range=24h&agent=&type=ALL&bridge=0&limit=40
// 平台协作时间线 (任务式对话): 把平台 ↔ Agent 的异步协作按任务线程还原成"聊天记录"。
//   线程 = 一个 Task
//   事件 = 平台发布 (Task.createdAt) → 认领 (TaskStateTransition actor) → 提交产出 (TaskExecution.output)
//          → 平台裁定 (Knowledge.verification + KNOWLEDGE_VERIFIED/REJECTED/PROPOSAL_ACCEPTED/VERDICT_MISSING)
//          → 人类干预 (HUMAN_INTERVENTION)
//          旁证: CONTEXT_INJECTED / AGENT_OUTPUT_INGESTED / KNOWLEDGE_VERIFY_TASK
// 只读 + 容错: 任一表缺失只影响对应事件, 绝不 500。
const VERDICT_STAGES = [
  "KNOWLEDGE_VERIFIED",
  "KNOWLEDGE_REJECTED",
  "KNOWLEDGE_PROPOSAL_ACCEPTED",
  "KNOWLEDGE_VERDICT_MISSING",
  "HUMAN_INTERVENTION",
];

// 2026-09-10 任务语义分层: 类型名与 scope 对齐 (机制修复 / 验证 / 对话)
const TYPE_LABEL: Record<string, string> = {
  GOAL_GAP: "机制修复",
  THEME_IMPROVE: "反思衍生改进",
  VERIFY_AGENT_OUTPUT: "验证/裁决",
  DISCUSSION_QUESTION: "对话/问答",
  PLATFORM_REVIEW: "平台复审",
  FIX_CONFLICT: "修冲突",
  FIX_THEME: "修主题",
  RE_RUN: "重跑",
  MIGRATE_DATA: "数据迁移",
  BRIDGE: "自动桥接(结构化回填)",
  "": "未分类",
};

const VERDICT_LABEL: Record<string, string> = {
  KNOWLEDGE_VERIFIED: "平台裁定: 已验证通过",
  KNOWLEDGE_PROPOSAL_ACCEPTED: "平台裁定: 提案接受",
  KNOWLEDGE_REJECTED: "平台裁定: 驳回",
  KNOWLEDGE_VERDICT_MISSING: "平台裁定: 缺少裁定依据",
  HUMAN_INTERVENTION: "人类介入",
};

function actorKind(actor: string): "agent" | "human" | "platform" | "unknown" {
  const a = String(actor || "");
  if (a.startsWith("agent:") || a.startsWith("agent-")) return "agent";
  if (a.startsWith("human:") || a === "human") return "human";
  if (a.startsWith("cron:") || a.startsWith("system:") || a.startsWith("api:") || a.startsWith("backfill:") || a === "platform" || a.startsWith("test:") || a.startsWith("debug")) return "platform";
  return a ? "unknown" : "platform";
}

function cleanAgent(actor: string): string {
  return String(actor || "").replace(/^agent:/, "");
}

function parseKV(title: string, key: string): string | null {
  const m = new RegExp(key + "=([\\w.\\-]+)").exec(String(title || ""));
  return m ? m[1] : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const r = resolveRange(url.searchParams.get("range"));
  const agent = url.searchParams.get("agent") || "";
  const type = url.searchParams.get("type") || "ALL";
  const includeBridge = url.searchParams.get("bridge") === "1";
  const keyword = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "40", 10) || 40, 1), 100);
  const now = Date.now();
  const mind = openMind();
  const warnings: string[] = [];
  if (!mind) warnings.push("mind 库不可用: 协作时间线已降级");

  // ---------- 1. 选线程 (Task) ----------
  const where: string[] = ["(t.updatedAt > ? OR t.createdAt > ?)"];
  const params: any[] = [r.since, r.since];
  if (type === "UNCLASSIFIED") {
    where.push("(t.improvementType IS NULL OR t.improvementType = '')");
  } else if (type && type !== "ALL") {
    where.push("t.improvementType = ?");
    params.push(type);
  } else if (!includeBridge) {
    where.push("(t.improvementType IS NULL OR t.improvementType <> 'BRIDGE')");
  }
  if (agent) {
    where.push(
      "(t.assignedAgent = ? OR t.completedBy = ? OR t.id IN (" +
        "SELECT taskId FROM TaskStateTransition WHERE actor IN (?, ?) AND createdAt > ?))"
    );
    params.push(agent, agent, agent, "agent:" + agent, r.since);
  }
  if (keyword) {
    where.push("(t.title LIKE ? OR t.description LIKE ? OR t.theme LIKE ?)");
    const like = "%" + keyword + "%";
    params.push(like, like, like);
  }

  const taskRows = await q(
    mind,
    "SELECT t.id, t.title, t.status, t.theme, t.improvementType, t.priority, t.assignedAgent, t.completedBy, " +
      "t.createdAt, t.updatedAt, t.completedAt, t.retryCount, " +
      "substr(t.description,1,4000) description, substr(t.requirements,1,1200) requirements, " +
      "substr(t.acceptanceCriteria,1,1200) acceptanceCriteria, substr(t.improvementPayload,1,1200) improvementPayload " +
      "FROM Task t WHERE " + where.join(" AND ") + " ORDER BY t.updatedAt DESC LIMIT ?",
    ...params, limit
  );

  const ids = taskRows.map((t) => t.id);
  const ph = ids.map(() => "?").join(",");

  // ---------- 2. 状态流转 (认领/提交/废弃) ----------
  const transitions = ids.length
    ? (await q(mind, "SELECT id, taskId, fromStatus, toStatus, actor, reason, metadata, createdAt FROM TaskStateTransition WHERE taskId IN (" + ph + ") ORDER BY createdAt ASC LIMIT 3000", ...ids))
    : [];
  // ---------- 3. Agent 回复 (TaskExecution) ----------
  const executions = ids.length
    ? (await q(
        mind,
        "SELECT id, taskId, agentId, agentRole, status, qualityPassed, retryCount, startedAt, completedAt, createdAt, " +
          "length(output) outputLength, substr(output,1,6000) output, substr(thoughtProcess,1,1500) thoughtProcess, " +
          "substr(problemsEncountered,1,800) problemsEncountered, substr(solutionsApplied,1,800) solutionsApplied, substr(nextSteps,1,800) nextSteps " +
          "FROM TaskExecution WHERE taskId IN (" + ph + ") ORDER BY COALESCE(completedAt, startedAt, createdAt) ASC LIMIT 3000",
        ...ids
      ))
    : [];
  // ---------- 4. Agent 产出 / 知识候选 (sourceId = taskId) ----------
  const candidates = ids.length
    ? (await q(
        mind,
        "SELECT id, title, qualityScore, verification, humanConfirmed, agentSource, theme, usageCount, createdAt, sourceType, length(content) contentLength " +
          "FROM Knowledge WHERE sourceId IN (" + ph + ") ORDER BY createdAt ASC LIMIT 500",
        ...ids
      ))
    : [];
  const candidateIds = candidates.map((c) => c.id);

  // ---------- 5. 裁定 / 人类干预事件 (窗口内, 小结果集) ----------
  const verdictRows = await q(
    mind,
    "SELECT id, stage, sourceType, sourceId, sourceTitle, targetStage, taskId, createdAt FROM FlywheelEvent " +
      "WHERE stage IN ('KNOWLEDGE_VERIFIED','KNOWLEDGE_REJECTED','KNOWLEDGE_PROPOSAL_ACCEPTED','KNOWLEDGE_VERDICT_MISSING','HUMAN_INTERVENTION') " +
      "AND createdAt > ? ORDER BY createdAt ASC LIMIT 500",
    r.since
  );

  // ---------- 6. 旁证: 上下文注入 / agent 产出入库 / 验证任务 ----------
  const evidenceRows = ids.length
    ? (await q(
        mind,
        "SELECT id, stage, sourceType, sourceId, substr(sourceTitle,1,400) sourceTitle, targetStage, createdAt FROM FlywheelEvent " +
          "WHERE stage IN ('CONTEXT_INJECTED','AGENT_OUTPUT_INGESTED','KNOWLEDGE_VERIFY_TASK','REFLECTION_TO_TASK') " +
          "AND (sourceId IN (" + ph + ") OR sourceTitle LIKE '%task=%') AND createdAt > ? ORDER BY createdAt ASC LIMIT 800",
        ...ids, r.since
      ))
    : [];

  // ---------- 7. 组装线程 ----------
  const taskIdSet = new Set(ids);
  const candidateTask = new Map<string, string>(); // knowledgeId -> taskId
  for (const c of candidates) candidateTask.set(c.id, String((c as any).taskId || ""));

  type Ev = {
    id: string; kind: string; at: number; actor: string; actorKind: string;
    title: string; detail?: string | null; output?: string | null; outputLength?: number | null;
    quality?: number | null; qualityPassed?: boolean | null; status?: string | null;
    knowledgeId?: string | null; stage?: string | null; tone: string;
  };

  const byTask = new Map<string, Ev[]>();
  const push = (taskId: string, ev: Ev) => {
    if (!taskIdSet.has(taskId)) return;
    const arr = byTask.get(taskId) || [];
    arr.push(ev);
    byTask.set(taskId, arr);
  };

  // 5.x 裁定事件: 通过 sourceTitle 里的 task= 或候选 id 反查线程
  for (const e of verdictRows) {
    const tid = parseKV(e.sourceTitle, "task") || candidateTask.get(e.sourceId) || (taskIdSet.has(e.sourceId) ? e.sourceId : null);
    if (!tid) continue;
    const by = parseKV(e.sourceTitle, "by");
    const isHuman = e.stage === "HUMAN_INTERVENTION" || e.sourceType === "knowledge-review" || e.sourceTitle?.startsWith("human:");
    push(tid, {
      id: e.id,
      kind: isHuman ? "human" : "verdict",
      at: num(e.createdAt),
      actor: isHuman ? (e.sourceTitle?.startsWith("human:") ? e.sourceTitle.split(" ")[0] : "human:operator") : by || "platform",
      actorKind: isHuman ? "human" : by ? "agent" : "platform",
      title: VERDICT_LABEL[e.stage] || e.stage,
      detail: e.sourceTitle,
      knowledgeId: e.sourceId && candidateTask.has(e.sourceId) ? e.sourceId : null,
      stage: e.stage,
      tone: e.stage === "KNOWLEDGE_REJECTED" ? "crit" : isHuman ? "warn" : e.stage === "KNOWLEDGE_VERDICT_MISSING" ? "warn" : "ok",
    });
  }

  // 6.x 旁证事件
  for (const e of evidenceRows) {
    let tid: string | null = null;
    if (taskIdSet.has(e.sourceId)) tid = e.sourceId;
    else tid = parseKV(e.sourceTitle, "task") || candidateTask.get(e.sourceId) || null;
    if (!tid || !taskIdSet.has(tid)) continue;
    if (e.stage === "CONTEXT_INJECTED") {
      const info = parseInjection(e.sourceTitle);
      push(tid, {
        id: e.id, kind: "context", at: num(e.createdAt), actor: info.agentId || "platform",
        actorKind: info.agentId ? "agent" : "platform",
        title: "平台注入上下文",
        detail: info.ids.length ? "注入 " + info.ids.length + " 条认知产物 (" + (info.kinds || []).join("/") + ")" : "已注入",
        tone: "mute",
      });
    } else if (e.stage === "AGENT_OUTPUT_INGESTED") {
      push(tid, {
        id: e.id, kind: "ingest", at: num(e.createdAt),
        actor: parseKV(e.sourceTitle, "agent") || "agent", actorKind: "agent",
        title: "智能体产出被平台收下", detail: e.sourceTitle, tone: "info",
      });
    } else if (e.stage === "KNOWLEDGE_VERIFY_TASK") {
      push(tid, {
        id: e.id, kind: "verify-task", at: num(e.createdAt), actor: "platform", actorKind: "platform",
        title: "平台派发独立复核任务", detail: e.sourceTitle, tone: "mute",
      });
    }
  }

  // 3.x agent 回复
  for (const e of executions) {
    push(e.taskId, {
      id: e.id, kind: "reply", at: num(e.completedAt ?? e.startedAt ?? e.createdAt),
      actor: e.agentId, actorKind: "agent",
      title: e.status === "COMPLETED" ? "智能体提交产出" : "智能体执行失败",
      detail: e.taskTitle || null,
      output: e.output, outputLength: num(e.outputLength),
      qualityPassed: e.qualityPassed === null || e.qualityPassed === undefined ? null : !!e.qualityPassed,
      status: e.status, tone: e.status === "COMPLETED" ? "info" : "crit",
    });
  }

  // 2.x 状态流转 (认领/废弃/重试); DONE 已在 reply 里体现, 无 reply 时保留
  const tasksWithReply = new Set(executions.map((e) => e.taskId));
  for (const s of transitions) {
    const to = String(s.toStatus || "");
    if (to === "DONE" && tasksWithReply.has(s.taskId)) continue;
    const kind = actorKind(s.actor);
    const isClaim = to === "IN_PROGRESS" || to === "PROCESSING";
    const isRetire = to === "DEPRECATED";
    const isFail = to === "FAILED";
    let title = "状态变更: " + (s.fromStatus || "-") + " → " + to;
    let tone = "mute";
    if (isClaim && kind === "agent") { title = "智能体认领任务"; tone = "info"; }
    else if (isClaim) { title = "平台调度接管"; }
    else if (isRetire) { title = "平台废弃该任务"; tone = "mute"; }
    else if (isFail) { title = "执行失败"; tone = "crit"; }
    else if (to === "DONE") { title = isRetire ? title : "标记完成"; tone = "ok"; }
    else if (to === "PENDING") { title = "任务回到待办"; tone = "warn"; }
    push(s.taskId, {
      id: s.id, kind: isClaim ? "claim" : isFail ? "fail" : isRetire ? "retire" : "state",
      at: num(s.createdAt), actor: kind === "agent" ? cleanAgent(s.actor || "") : s.actor || "platform", actorKind: kind,
      title, detail: s.reason || null, status: to, tone,
    });
  }

  // 4.x 知识候选 (agent 产出)
  for (const c of candidates) {
    push(String((c as any).taskId || ""), {
      id: "cand:" + c.id, kind: "candidate", at: num(c.createdAt),
      actor: cleanAgent(c.agentSource || "") || "unknown", actorKind: "agent",
      title: c.verification ? "智能体结论候选 · " + c.verification : "智能体结论候选",
      detail: c.title, quality: c.qualityScore, knowledgeId: c.id,
      tone: c.verification === "REJECTED" ? "crit" : c.verification === "PENDING_REVIEW" ? "warn" : "ok",
    });
  }

  const threads = taskRows.map((t) => {
    const events = (byTask.get(t.id) || []).slice().sort((a, b) => a.at - b.at);
    const publishAt = num(t.createdAt);
    const lastActivityAt = Math.max(publishAt, ...events.map((e) => e.at), num(t.updatedAt));
    const participants = Array.from(
      new Set(
        events
          .filter((e) => e.actorKind === "agent")
          .map((e) => cleanAgent(e.actor))
          .concat(t.assignedAgent ? [t.assignedAgent] : [])
          .filter((x) => x && x !== "agent")
      )
    );
    const type = t.improvementType || "";
    return {
      taskId: t.id,
      title: t.title,
      status: t.status,
      theme: t.theme,
      improvementType: type,
      improvementTypeLabel: TYPE_LABEL[type] || type || "未分类",
      scope: scopeOfType(type),
      priority: t.priority,
      createdAt: publishAt,
      updatedAt: num(t.updatedAt),
      completedAt: t.completedAt ? num(t.completedAt) : null,
      completedBy: t.completedBy,
      assignedAgent: t.assignedAgent,
      retryCount: num(t.retryCount),
      participants,
      lastActivityAt,
      auto: type === "BRIDGE" || (events.length > 0 && events.every((e) => e.actorKind === "platform")),
      publish: {
        at: publishAt,
        title: t.title,
        description: t.description,
        requirements: t.requirements,
        acceptanceCriteria: t.acceptanceCriteria,
        improvementPayload: t.improvementPayload,
        theme: t.theme,
        improvementType: type,
        priority: t.priority,
      },
      events,
      counts: {
        claims: events.filter((e) => e.kind === "claim").length,
        replies: events.filter((e) => e.kind === "reply").length,
        verdicts: events.filter((e) => e.kind === "verdict").length,
        human: events.filter((e) => e.kind === "human").length,
        evidence: events.filter((e) => ["context", "ingest", "verify-task"].includes(e.kind)).length,
      },
    };
  });

  threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  // ---------- 8. 汇总 ----------
  const typeCounts = await q(
    mind,
    "SELECT COALESCE(improvementType,'') type, COUNT(*) c FROM Task WHERE (updatedAt > ? OR createdAt > ?) GROUP BY improvementType ORDER BY c DESC LIMIT 20",
    r.since, r.since
  );

  const agentActivity = new Map<string, number>();
  for (const th of threads) for (const p of th.participants) agentActivity.set(p, (agentActivity.get(p) || 0) + 1);

  const summary = {
    byScope: threads.reduce((acc: Record<string, number>, t) => {
      acc[t.scope] = (acc[t.scope] || 0) + 1;
      return acc;
    }, {}),
    threads: threads.length,
    humanThreads: threads.filter((t) => !t.auto).length,
    autoThreads: threads.filter((t) => t.auto).length,
    replied: threads.filter((t) => t.counts.replies > 0).length,
    verdicts: threads.reduce((s, t) => s + t.counts.verdicts, 0),
    humanInterventions: threads.reduce((s, t) => s + t.counts.human, 0),
    claims: threads.reduce((s, t) => s + t.counts.claims, 0),
    participants: Array.from(agentActivity.entries()).map(([agentId, n]) => ({ agentId, threads: n })).sort((a, b) => b.threads - a.threads),
    verdictBreakdown: (["KNOWLEDGE_VERIFIED", "KNOWLEDGE_PROPOSAL_ACCEPTED", "KNOWLEDGE_REJECTED", "KNOWLEDGE_VERDICT_MISSING", "HUMAN_INTERVENTION"] as string[]).map((st) => ({
      stage: st, label: VERDICT_LABEL[st], count: verdictRows.filter((v) => v.stage === st).length,
    })),
    avgReplyLength: (() => {
      const lens = executions.map((e) => num(e.outputLength)).filter((n) => n > 0);
      return lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0;
    })(),
    replyQualityPassed: executions.filter((e) => e.qualityPassed).length,
    replies: executions.length,
  };

  const typeTotal = typeCounts.reduce((s, x) => s + num(x.c), 0);
  const types = Array.from(new Set(["ALL", ...typeCounts.map((t) => t.type || "")]))
    .filter((t) => t !== undefined)
    .map((t) => ({
      value: t === "" ? "UNCLASSIFIED" : t,
      label: t === "ALL" ? "全部类型" : TYPE_LABEL[t] || t || "未分类",
      count: t === "ALL" ? typeTotal : typeCounts.find((x) => (x.type || "") === t)?.c ?? 0,
    }));

  safeClose(mind);
  return NextResponse.json({
    asOf: asOf(),
    now,
    range: { key: r.key, label: r.label, since: r.since },
    filters: { agent: agent || null, type, includeBridge, keyword: keyword || null, limit },
    warnings,
    summary,
    types,
    threads,
  });
}
