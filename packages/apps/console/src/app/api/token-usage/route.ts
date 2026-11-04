import { NextResponse } from "next/server";
import { requireFeature } from "@/lib/server/license-gate";
import {
  asOf, attributeCall, bucketIndex, makeBuckets, modelForEntry, num, openMind, parseAgentOutput, parseCallTitle, q,
  resolveRange, round, safeClose, scalar, tableColumns,
} from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// GET /api/token-usage?range=24h&agent=
// Token 消耗 (只统计 token 数量, 不做金额折算)。
//
// 2026-09-10 mind 侧治本后的口径 (向后兼容, 解析规则不变):
//   stage = 'CALL_LLM'
//   sourceType = 'platform:<entry>'  → 平台侧调用 (reflect / main-extract / structured / improving-tasks ...)
//   sourceType = 'agent:<agentId>'   → agent 自报用量 (responder 在 /tasks/submit 带 usage 上报), sourceId = taskId
//   sourceTitle = 'tok=N model=M entry=E [calls=K]'  (tok≈N 估算 / chars≈N 未计量 前缀规则不变)
//   → 因此 token 现在可以真实按 agent 归因: 归因来源就是 sourceType LIKE 'agent:%'
// 未计量调用 (chars≈N / 空) 单列, 不混进总量。
export async function GET(req: Request) {
  // 2026-10-27（S2 门禁）：/cost 属 console.analytics；**不能只隐藏 UI 而 API 放行**，这里返回 402。
  const denied = await requireFeature("console.analytics");
  if (denied) return denied;
  const url = new URL(req.url);
  const r = resolveRange(url.searchParams.get("range"));
  const agentFilter = url.searchParams.get("agent") || "";
  const now = Date.now();
  const mind = openMind();
  const warnings: string[] = [];
  if (!mind) warnings.push("管理库不可用：用量指标已降级");

  const eventCols = await tableColumns(mind, "FlywheelEvent");
  const hasModelCol = eventCols.includes("model");
  const rows = await q(
    mind,
    "SELECT sourceType, sourceTitle, targetStage, sourceId, createdAt" + (hasModelCol ? ", model" : "") + " FROM FlywheelEvent " +
      "WHERE stage='CALL_LLM' AND createdAt > ? ORDER BY createdAt DESC LIMIT 50000",
    r.since
  );

  const buckets = makeBuckets(r, now);
  const tokenTrend = new Array(buckets.length).fill(0);
  const agentTokenTrend = new Array(buckets.length).fill(0);
  // 2026-09-11 P2: 估算 token 单列 —— 趋势里也分开, 不混进总量序列
  const estimatedTokenTrend = new Array(buckets.length).fill(0);
  const agentEstimatedTokenTrend = new Array(buckets.length).fill(0);
  const callTrend = new Array(buckets.length).fill(0);
  const failTrend = new Array(buckets.length).fill(0);
  const bucketOf = (ts: number) => bucketIndex(r, buckets, ts, now);

  interface EntryAgg {
    entry: string; calls: number; ok: number; fail: number;
    tokens: number; estimatedTokens: number; unmeasured: number; chars: number;
    durationMs: number; lastAt: number; model: string; legacy: boolean;
  }
  interface AgentAgg {
    agentId: string; calls: number; tokens: number; estimatedTokens: number; unmeasured: number; chars: number;
    models: Record<string, number>; estimatedModels: Record<string, number>;
    tasks: Record<string, number>; estimatedTasks: Record<string, number>;
    lastAt: number; firstAt: number;
  }

  const entryMap = new Map<string, EntryAgg>();
  const agentMap = new Map<string, AgentAgg>();
  const modelMap = new Map<string, { model: string; calls: number; tokens: number; estimatedTokens: number; recorded: number; inferred: number; agents: Record<string, number>; estimatedAgents: Record<string, number>; entries: Set<string> }>();
  const dayMap = new Map<string, { date: string; calls: number; tokens: number; estimatedTokens: number; unmeasured: number; agentTokens: number; agentEstimatedTokens: number }>();

  let measuredTokens = 0, estimatedTokens = 0;
  let measuredCalls = 0, estimatedCalls = 0, unmeasuredCalls = 0, charsUnmeasured = 0;
  let okCalls = 0, failCalls = 0, durationSum = 0;
  let agentTokens = 0, agentEstimatedTokens = 0, agentCalls = 0, agentUnmeasured = 0;
  let platformTokens = 0, platformCalls = 0;
  let modelRecorded = 0;
  const topCalls: any[] = [];
  const unmeasuredList: any[] = [];
  const agentsSeen = new Set<string>();

  for (const row of rows) {
    const p = parseCallTitle(row.sourceTitle);
    const attr = attributeCall(row.sourceType, p.entry);
    const recordedModel = p.model || (hasModelCol && row.model ? String(row.model) : "");
    if (recordedModel) modelRecorded += 1;
    const entry = attr.entry || "unknown";
    const model = recordedModel || modelForEntry(entry);
    const ok = row.targetStage === "OK";
    const ms = num(row.sourceId);
    const ts = num(row.createdAt);
    const idx = bucketOf(ts);
    if (idx >= 0) callTrend[idx] += 1;
    if (!ok && idx >= 0) failTrend[idx] += 1;
    if (ok) okCalls += 1; else failCalls += 1;
    durationSum += ms;

    // ---- 入口 (平台侧) 聚合 ----
    const e = entryMap.get(entry) || {
      entry, calls: 0, ok: 0, fail: 0, tokens: 0, estimatedTokens: 0, unmeasured: 0, chars: 0, durationMs: 0, lastAt: 0, model, legacy: attr.legacy,
    };
    e.calls += 1;
    if (ok) e.ok += 1; else e.fail += 1;
    e.durationMs += ms;
    e.lastAt = Math.max(e.lastAt, ts);

    // ---- agent 聚合 (sourceType = agent:<id>) ----
    let a: AgentAgg | null = null;
    if (attr.kind === "agent" && attr.agentId) {
      agentsSeen.add(attr.agentId);
      a = agentMap.get(attr.agentId) || {
        agentId: attr.agentId, calls: 0, tokens: 0, estimatedTokens: 0, unmeasured: 0, chars: 0,
        models: {}, estimatedModels: {}, tasks: {}, estimatedTasks: {}, lastAt: 0, firstAt: ts,
      };
      a.calls += 1;
      a.firstAt = Math.min(a.firstAt || ts, ts);
      a.lastAt = Math.max(a.lastAt, ts);
      if (row.sourceId) a.tasks[String(row.sourceId)] = (a.tasks[String(row.sourceId)] || 0);
    }

    // ---- 模型聚合 ----
    const m = modelMap.get(model) || { model, calls: 0, tokens: 0, estimatedTokens: 0, recorded: 0, inferred: 0, agents: {}, estimatedAgents: {}, entries: new Set<string>() };
    m.calls += 1;
    if (recordedModel) m.recorded += 1; else m.inferred += 1;
    m.entries.add(entry);


    // ---- 日聚合 ----
    const d = new Date(ts);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const day = dayMap.get(dateKey) || { date: dateKey, calls: 0, tokens: 0, estimatedTokens: 0, unmeasured: 0, agentTokens: 0, agentEstimatedTokens: 0 };
    day.calls += 1;

    const measured = p.kind === "measured" || p.kind === "estimated";
    if (measured && p.tokens) {
      const isEst = p.kind === "estimated";
      if (isEst) { estimatedTokens += p.tokens; estimatedCalls += 1; } else { measuredTokens += p.tokens; measuredCalls += 1; }
      e.tokens += isEst ? 0 : p.tokens;
      e.estimatedTokens += isEst ? p.tokens : 0;
      m.tokens += isEst ? 0 : p.tokens;
      m.estimatedTokens += isEst ? p.tokens : 0;
      // 2026-09-11 P2「估算 token 单列(不进总量)」: 日聚合与趋势序列都按 实测/估算 分列。
      //   修复前: day.tokens / tokenTrend / agentTokens / agentTokenTrend / 嵌套 models/tasks 全部 += p.tokens,
      //   估算值被加进"token 总量", 使总量看起来比真实用量大。现在实测进 *_tokens, 估算进 *_estimatedTokens。
      if (isEst) {
        day.estimatedTokens += p.tokens;
        if (idx >= 0) estimatedTokenTrend[idx] += p.tokens;
      } else {
        day.tokens += p.tokens;
        if (idx >= 0) tokenTrend[idx] += p.tokens;
      }
      if (attr.kind === "agent") {
        agentCalls += 1;
        const aid = attr.agentId as string;
        if (isEst) {
          agentEstimatedTokens += p.tokens;
          day.agentEstimatedTokens += p.tokens;
          if (idx >= 0) agentEstimatedTokenTrend[idx] += p.tokens;
          m.estimatedAgents[aid] = (m.estimatedAgents[aid] || 0) + p.tokens;
        } else {
          agentTokens += p.tokens;
          day.agentTokens += p.tokens;
          if (idx >= 0) agentTokenTrend[idx] += p.tokens;
          m.agents[aid] = (m.agents[aid] || 0) + p.tokens;
        }
        if (a) {
          if (isEst) a.estimatedTokens += p.tokens; else a.tokens += p.tokens;
          const key = row.sourceId ? String(row.sourceId) : "";
          if (isEst) {
            a.estimatedModels[model] = (a.estimatedModels[model] || 0) + p.tokens;
            if (key) a.estimatedTasks[key] = (a.estimatedTasks[key] || 0) + p.tokens;
          } else {
            a.models[model] = (a.models[model] || 0) + p.tokens;
            if (key) a.tasks[key] = (a.tasks[key] || 0) + p.tokens;
          }
        }
      } else {
        platformTokens += p.tokens; platformCalls += 1;
      }
      // 2026-09-11 P2「估算 token 单列」: 给 topCalls 带上口径标记 (页面据此把 实测/估算 分列展示)
      topCalls.push({ at: ts, entry, model, tokens: p.tokens, durationMs: ms, ok, agentId: attr.agentId, kind: attr.kind, attribution: recordedModel ? "recorded" : "inferred", estimated: isEst });
    } else {
      unmeasuredCalls += 1;
      e.unmeasured += 1;
      day.unmeasured += 1;
      if (p.chars) { charsUnmeasured += p.chars; e.chars += p.chars; }
      if (attr.kind === "agent") { agentUnmeasured += 1; if (a) a.unmeasured += 1; }
      if (unmeasuredList.length < 50) {
        unmeasuredList.push({ at: ts, entry, chars: p.chars, raw: row.sourceTitle || "(空)", agentId: attr.agentId, kind: attr.kind });
      }
    }

    entryMap.set(entry, e);
    if (a) agentMap.set(attr.agentId as string, a);
    modelMap.set(model, m);
    dayMap.set(dateKey, day);
  }

  const byEntry = Array.from(entryMap.values())
    .map((e) => ({
      entry: e.entry, model: e.model, calls: e.calls, ok: e.ok, fail: e.fail,
      successRate: e.calls ? round(e.ok / e.calls, 3) : 0,
      tokens: e.tokens, estimatedTokens: e.estimatedTokens, unmeasured: e.unmeasured, chars: e.chars,
      avgMs: e.calls ? Math.round(e.durationMs / e.calls) : 0,
      lastAt: e.lastAt, legacy: e.legacy,
      avgTokensPerCall: e.tokens ? Math.round(e.tokens / Math.max(e.ok + e.fail, 1)) : 0,
    }))
    .sort((a, b) => b.tokens + b.estimatedTokens - (a.tokens + a.estimatedTokens) || b.calls - a.calls);

  // 按 agent 真实聚合 (2026-09-10: sourceType = agent:<id>, agent 自报 usage)
  const byAgent = Array.from(agentMap.values())
    .map((a) => {
      const models = Object.entries(a.models).sort((x, y) => y[1] - x[1]).map(([model, tokens]) => ({ model, tokens }));
      const tasks = Object.entries(a.tasks)
        .map(([taskId, tokens]) => ({ taskId, tokens }))
        .sort((x, y) => y.tokens - x.tokens)
        .slice(0, 20);
      const estimatedModels = Object.entries(a.estimatedModels).sort((x, y) => y[1] - x[1]).map(([model, tokens]) => ({ model, tokens }));
      const estimatedTasks = Object.entries(a.estimatedTasks)
        .map(([taskId, tokens]) => ({ taskId, tokens }))
        .sort((x, y) => y.tokens - x.tokens)
        .slice(0, 20);
      return {
        agentId: a.agentId,
        calls: a.calls,
        tokens: a.tokens,
        estimatedTokens: a.estimatedTokens,
        // 2026-09-11 P2: totalTokens = 实测口径(估算已单列, 不再并入总量)
        totalTokens: a.tokens,
        combinedTokens: a.tokens + a.estimatedTokens,   // 仅参考, 明示含估算
        unmeasured: a.unmeasured,
        models,
        estimatedModels,
        primaryModel: models[0]?.model || null,
        tasks,
        estimatedTasks,
        taskCount: Object.keys(a.tasks).length,
        firstAt: a.firstAt || null,
        lastAt: a.lastAt || null,
        avgTokensPerCall: a.calls ? Math.round(a.tokens / a.calls) : 0,
      };
    })
    .sort((a, b) => b.combinedTokens - a.combinedTokens);

  const byModel = Array.from(modelMap.values())
    .map((m) => ({
      model: m.model, calls: m.calls, tokens: m.tokens, estimatedTokens: m.estimatedTokens,
      recorded: m.recorded, inferred: m.inferred,
      agents: Object.entries(m.agents).map(([agentId, tokens]) => ({ agentId, tokens })).sort((a, b) => b.tokens - a.tokens),
      estimatedAgents: Object.entries(m.estimatedAgents).map(([agentId, tokens]) => ({ agentId, tokens })).sort((a, b) => b.tokens - a.tokens),
      entries: Array.from(m.entries),
    }))
    .sort((a, b) => b.tokens + b.estimatedTokens - (a.tokens + a.estimatedTokens));

  // 产出侧对照 (token 之外: 各 agent 的执行/提交量)
  const execByAgent = await q(
    mind,
    "SELECT agentId, COUNT(*) n, SUM(CASE WHEN qualityPassed=1 THEN 1 ELSE 0 END) passed, MAX(COALESCE(completedAt, startedAt, createdAt)) lastAt " +
      "FROM TaskExecution WHERE COALESCE(completedAt, startedAt, createdAt) > ? GROUP BY agentId ORDER BY n DESC LIMIT 20",
    r.since
  );
  const submitRows = await q(
    mind,
    "SELECT sourceTitle, createdAt FROM FlywheelEvent WHERE stage='AGENT_OUTPUT_INGESTED' AND createdAt > ? LIMIT 500",
    r.since
  );
  const submitAgg = new Map<string, { n: number; qSum: number; qN: number }>();
  for (const s of submitRows) {
    const p = parseAgentOutput(s.sourceTitle);
    const key = p.agentId || "(未知)";
    const agg = submitAgg.get(key) || { n: 0, qSum: 0, qN: 0 };
    agg.n += 1;
    if (typeof p.quality === "number") { agg.qSum += p.quality; agg.qN += 1; }
    submitAgg.set(key, agg);
  }
  const agentSide = execByAgent.map((e) => {
    const s = submitAgg.get(e.agentId) || { n: 0, qSum: 0, qN: 0 };
    const tk = agentMap.get(e.agentId);
    return {
      agentId: e.agentId,
      executions: num(e.n),
      qualityPassed: num(e.passed),
      submissions: s.n,
      avgQuality: s.qN ? round(s.qSum / s.qN, 3) : null,
      lastAt: num(e.lastAt),
      reportedTokens: tk ? tk.tokens : 0,
      reportedEstimatedTokens: tk ? tk.estimatedTokens : 0,
      reportedCalls: tk ? tk.calls : 0,
    };
  });

  // 历史全量
  const allTime = await q(mind, "SELECT sourceType, sourceTitle, createdAt FROM FlywheelEvent WHERE stage='CALL_LLM' ORDER BY createdAt ASC LIMIT 50000");
  let allTimeTokens = 0, allTimeMeasured = 0, allTimeUnmeasured = 0, allTimeEstimated = 0, allTimeEstimatedTokens = 0, allTimeAgentTokens = 0, allTimeAgentEstimatedTokens = 0, allTimeAgentCalls = 0;
  let firstAt: number | null = null;
  for (const row of allTime) {
    const p = parseCallTitle(row.sourceTitle);
    const attr = attributeCall(row.sourceType, p.entry);
    if (firstAt === null || num(row.createdAt) < firstAt) firstAt = num(row.createdAt);
    // 2026-09-11 P2: 全量历史同样分列(原先 allTimeTokens 把估算也加了进去)
    if (p.kind === "measured" && p.tokens) { allTimeTokens += p.tokens; allTimeMeasured += 1; }
    else if (p.kind === "estimated" && p.tokens) { allTimeEstimatedTokens += p.tokens; allTimeEstimated += 1; }
    else allTimeUnmeasured += 1;
    if (attr.kind === "agent" && p.tokens) {
      allTimeAgentCalls += 1;
      if (p.kind === "estimated") allTimeAgentEstimatedTokens += p.tokens; else allTimeAgentTokens += p.tokens;
    }
  }

  // agent 筛选 (按 agent:<id> 归因生效)
  if (agentFilter) {
    warnings.push(`已按 agent=${agentFilter} 过滤 token 归因 (仅统计 sourceType='agent:${agentFilter}' 的自报用量)`);
  }
  if (byAgent.length === 0) {
    warnings.push("窗口内还没有智能体自报用量：智能体提交任务时带用量上报后才会落对应调用事件；因此「按智能体聚合」暂为空，平台侧调用见入口/模型聚合。");
  }
  const filteredByAgent = agentFilter ? byAgent.filter((a) => a.agentId === agentFilter) : byAgent;
  const filteredByEntry = agentFilter
    ? byEntry.filter((e) => false)
    : byEntry;
  const selectedAgentTokens = agentFilter
    ? filteredByAgent.reduce((s, a) => s + a.totalTokens, 0)
    : agentTokens;

  safeClose(mind);
  return NextResponse.json({
    asOf: asOf(),
    range: { key: r.key, label: r.label, since: r.since, points: buckets.map((b) => ({ label: b.label, ts: b.ts })) },
    warnings,
    filters: { agent: agentFilter || null },
    summary: {
      calls: rows.length,
      okCalls, failCalls,
      successRate: rows.length ? round(okCalls / rows.length, 3) : 0,
      measuredTokens, estimatedTokens,
      // 2026-09-11 P2: totalTokens 改为纯实测口径; 含估算的合并数单独给出并明确命名
      totalTokens: measuredTokens,
      combinedTokens: measuredTokens + estimatedTokens,
      measuredCalls, estimatedCalls, unmeasuredCalls, charsUnmeasured,
      avgDurationMs: rows.length ? Math.round(durationSum / rows.length) : 0,
      avgTokensPerMeasuredCall: measuredCalls ? Math.round(measuredTokens / measuredCalls) : 0,
      lastAt: rows.length ? num(rows[0].createdAt) : null,
      // 归因拆分 (2026-09-10)
      agentTokens: selectedAgentTokens,
      agentEstimatedTokens,
      agentCalls,
      agentUnmeasured,
      agentCount: agentFilter ? filteredByAgent.length : agentsSeen.size,
      platformTokens,
      platformCalls,
      // agent 占比可能极小 (平台侧调用量远大于 agent 自报), 保留 4 位避免显示成 0
      agentShare: measuredTokens > 0 ? round(agentTokens / measuredTokens, 4) : 0,
      agentEstimatedShare: measuredTokens > 0 ? round(agentEstimatedTokens / measuredTokens, 4) : 0,
    },
    allTime: {
      calls: allTime.length, tokens: allTimeTokens, estimatedTokens: allTimeEstimatedTokens,
      combinedTokens: allTimeTokens + allTimeEstimatedTokens,
      measured: allTimeMeasured, estimated: allTimeEstimated,
      unmeasured: allTimeUnmeasured, agentTokens: allTimeAgentTokens,
      agentEstimatedTokens: allTimeAgentEstimatedTokens, agentCalls: allTimeAgentCalls, firstAt,
    },
    modelAttribution: modelRecorded > 0 ? (modelRecorded >= rows.length ? "recorded" : "mixed") : "inferred",
    modelRecordedCalls: modelRecorded,
    attribution: {
      agentRule: "sourceType LIKE 'agent:%' → agent 自报用量 (submit 带 usage, sourceId=taskId)",
      platformRule: "sourceType = 'platform:<entry>' → 平台侧调用, 按 model= 字段聚合 (无则按入口路由推定)",
    },
    byEntry: filteredByEntry,
    byAgent: filteredByAgent,
    byModel,
    trend: {
      points: buckets.map((b) => ({ label: b.label, ts: b.ts })),
      tokens: tokenTrend,
      estimatedTokens: estimatedTokenTrend,
      agentTokens: agentTokenTrend,
      agentEstimatedTokens: agentEstimatedTokenTrend,
      calls: callTrend,
      fails: failTrend,
      bucketKind: r.bucketKind,
    },
    daily: Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    topCalls: topCalls.sort((a, b) => b.tokens - a.tokens).slice(0, 12),
    unmeasured: unmeasuredList.slice(0, 20),
    agentView: {
      attributable: true,
      reason: "token 按 agent 归因已生效: agent 在提交任务时用 usage 上报自己的用量, 平台落 sourceType='agent:<id>' 的 CALL_LLM 事件; 未上报的 agent 侧消耗平台不可见。",
      sideStats: agentSide,
    },
  });
}
