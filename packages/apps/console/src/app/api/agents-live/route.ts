import { NextResponse } from "next/server";
import {
  asOf, num, openMind, parseAgentOutput, q, readMindEnv, resolveRange, round, safeClose, scalar, one,
} from "@/lib/server/lions-db";
import { IMPROVEMENT_TYPES, improvementTypeSql, scopeOfType } from "@/config/taskScopes";
import { parseCallTitle } from "@/lib/server/lions-db";
import { macsAdminKey } from "@/lib/server/macs-admin";

export const dynamic = "force-dynamic";

// GET /api/agents-live?range=24h
// Agent 活跃看板: 在线状态 (MACS + mind 注册表) / 当前在做什么任务 / 最近提交时间 / 最近产出质量 / 是否卡住
// 只读 + 容错: MACS 或 mind 不可用时降级为部分字段, 绝不 500。
const STUCK_TASK_MS = 30 * 60 * 1000;   // 任务 30 分钟无更新 → 卡住
const OFFLINE_MS = 24 * 3600 * 1000;     // 超过 24 小时没露面 → 离线

export async function GET(req: Request) {
  const url = new URL(req.url);
  const r = resolveRange(url.searchParams.get("range"));
  const only = url.searchParams.get("agent") || "";
  const now = Date.now();
  const nowSec = now;
  const mind = openMind();
  const warnings: string[] = [];
  if (!mind) warnings.push("mind 库不可用: 任务/产出维度已降级");
  // 2026-09-11: 能力守卫名单 (与 mind claim 路由同源) —— 用于区分"执行体"身份
  const toolCapableAgents = (
    process.env.CLAIM_TOOL_CAPABLE_AGENTS || readMindEnv("CLAIM_TOOL_CAPABLE_AGENTS") || "agent-d"
  ).split(",").map((s) => s.trim()).filter(Boolean);

  // ---------- 1. MACS 在线状态 ----------
  let macs: any[] = [];
  let macsOk = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
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
      macs = Array.isArray(d?.agents) ? d.agents : [];
      macsOk = true;
    }
  } catch {
    warnings.push("MACS (8765) 不可达: 在线状态仅取 mind 注册表");
  }

  // ---------- 2. mind 注册表 ----------
  const registry = await q(
    mind,
    "SELECT agent_id, display_name, channel, host, role, status, created_at, updated_at, last_seen_at FROM AgentRegistry ORDER BY status ASC, agent_id ASC"
  );

  // ---------- 3. 任务 / 执行 ----------
  const lastTasks = await q(
    mind,
    "SELECT t.id, t.title, t.status, t.assignedAgent, t.theme, t.priority, t.improvementType, t.updatedAt, t.completedAt FROM Task t " +
      "JOIN (SELECT assignedAgent, MAX(updatedAt) mx FROM Task WHERE assignedAgent IS NOT NULL GROUP BY assignedAgent) m " +
      "ON t.assignedAgent = m.assignedAgent AND t.updatedAt = m.mx"
  );
  const lastTaskByAgent = new Map<string, any>();
  for (const t of lastTasks) if (t.assignedAgent) lastTaskByAgent.set(t.assignedAgent, t);

  // 2026-09-11 修正: 在办(IN_PROGRESS/PROCESSING) 与 已派单待开始(PENDING+assignedAgent) 必须分开,
  // 否则"被派单但没开始"会被当成"正在干活", busy 判定失真。
  const inProgressTasks = await q(
    mind,
    "SELECT id, title, status, assignedAgent, theme, priority, improvementType, updatedAt, createdAt FROM Task WHERE status IN ('IN_PROGRESS','PROCESSING') ORDER BY updatedAt DESC LIMIT 200"
  );
  const assignedPendingTasks = await q(
    mind,
    "SELECT id, title, status, assignedAgent, theme, priority, improvementType, updatedAt, createdAt FROM Task WHERE status='PENDING' AND assignedAgent IS NOT NULL ORDER BY updatedAt DESC LIMIT 200"
  );

  // 2026-09-10 任务语义分层: "改进任务"口径 = 机制修复类 (GOAL_GAP + THEME_IMPROVE + PLATFORM_REVIEW),
  // 验证/裁决与对话/问答任务不计入完成率 (另用 taskScopeRows 提供各 scope 明细)。
  const mechFilter = ` AND improvementType IN (${improvementTypeSql()})`;
  const taskStats = await q(
    mind,
    "SELECT assignedAgent, " +
      "SUM(CASE WHEN status='DONE' AND completedAt > ? THEN 1 ELSE 0 END) done, " +
      "SUM(CASE WHEN status='FAILED' AND updatedAt > ? THEN 1 ELSE 0 END) failed, " +
      "SUM(CASE WHEN status IN ('IN_PROGRESS','PROCESSING') THEN 1 ELSE 0 END) running, " +
      "SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) pending " +
      "FROM Task WHERE assignedAgent IS NOT NULL" + mechFilter + " GROUP BY assignedAgent",
    r.since, r.since
  );

  // 各 agent 的对话/验证任务量 (明确"不计入改进任务", 供卡片补充说明)
  const taskScopeRows = await q(
    mind,
    "SELECT assignedAgent, improvementType, status, COUNT(*) c FROM Task " +
      "WHERE assignedAgent IS NOT NULL AND (COALESCE(completedAt, updatedAt) > ? OR createdAt > ?) GROUP BY assignedAgent, improvementType, status",
    r.since, r.since
  );

  // 每个 Agent 最近一次执行: 用窗口函数取 TOP1
  // (注: 原先的关联子查询写法单次耗时 ~9.9s, 换成 ROW_NUMBER() 后 ~8ms, 否则 10 秒轮询会拖垮页面)
  const lastExec = await q(
    mind,
    "SELECT e.id, e.taskId, e.agentId, e.agentRole, e.status, e.startedAt, e.completedAt, e.qualityPassed, e.retryCount, t.title taskTitle, t.status taskStatus " +
      "FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY agentId ORDER BY COALESCE(completedAt, startedAt, createdAt) DESC) rn FROM TaskExecution) e " +
      "LEFT JOIN Task t ON t.id = e.taskId WHERE e.rn = 1"
  );
  const lastExecByAgent = new Map<string, any>();
  for (const e of lastExec) if (e.agentId) lastExecByAgent.set(e.agentId, e);

  const execStats = await q(
    mind,
    "SELECT agentId, COUNT(*) n, " +
      "SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) completed, " +
      "SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) failed, " +
      "SUM(CASE WHEN qualityPassed=1 THEN 1 ELSE 0 END) passed, " +
      "MAX(COALESCE(completedAt, startedAt, createdAt)) lastAt " +
      "FROM TaskExecution WHERE COALESCE(completedAt, startedAt, createdAt) > ? GROUP BY agentId",
    r.since
  );
  const execStatByAgent = new Map<string, any>();
  for (const e of execStats) if (e.agentId) execStatByAgent.set(e.agentId, e);

  // ---------- 4. Agent 产出提交 (质量) ----------
  const submitRows = await q(
    mind,
    "SELECT sourceTitle, createdAt FROM FlywheelEvent WHERE stage='AGENT_OUTPUT_INGESTED' AND createdAt > ? ORDER BY createdAt DESC LIMIT 500",
    r.since
  );
  const submitByAgent = new Map<string, { n: number; qSum: number; qN: number; lastAt: number; lastQuality: number | null; lastTarget: string | null }>();
  for (const row of submitRows) {
    const p = parseAgentOutput(row.sourceTitle);
    const key = p.agentId || "(未知)";
    const agg = submitByAgent.get(key) || { n: 0, qSum: 0, qN: 0, lastAt: 0, lastQuality: null, lastTarget: null };
    agg.n += 1;
    if (typeof p.quality === "number") { agg.qSum += p.quality; agg.qN += 1; }
    if (num(row.createdAt) > agg.lastAt) {
      agg.lastAt = num(row.createdAt);
      agg.lastQuality = p.quality;
      agg.lastTarget = p.targetId;
    }
    submitByAgent.set(key, agg);
  }

  // ---------- 4.5 agent 自报 token 用量 (2026-09-10: sourceType='agent:<id>', sourceId=taskId) ----------
  const tokenRows = await q(
    mind,
    "SELECT sourceType, sourceTitle, sourceId, createdAt FROM FlywheelEvent " +
      "WHERE stage='CALL_LLM' AND sourceType LIKE 'agent:%' AND createdAt > ? ORDER BY createdAt DESC LIMIT 20000",
    r.since
  );
  const tokenByAgent = new Map<string, { agentId: string; tokens: number; calls: number; models: Record<string, number>; byTask: Record<string, number>; lastAt: number }>();
  for (const row of tokenRows) {
    const agentId = String(row.sourceType).slice(6);
    if (!agentId) continue;
    const p = parseCallTitle(row.sourceTitle);
    const agg = tokenByAgent.get(agentId) || { agentId, tokens: 0, calls: 0, models: {}, byTask: {}, lastAt: 0 };
    agg.calls += 1;
    agg.lastAt = Math.max(agg.lastAt, num(row.createdAt));
    if (p.tokens) {
      agg.tokens += p.tokens;
      const model = p.model || "unknown";
      agg.models[model] = (agg.models[model] || 0) + p.tokens;
      if (row.sourceId) agg.byTask[String(row.sourceId)] = (agg.byTask[String(row.sourceId)] || 0) + p.tokens;
    }
    tokenByAgent.set(agentId, agg);
  }

  // ---------- 5. 最近活动时间线 ----------
  const recentExec = await q(
    mind,
    "SELECT e.agentId, e.status, e.qualityPassed, e.completedAt, e.startedAt, t.title taskTitle, t.id taskId " +
      "FROM TaskExecution e LEFT JOIN Task t ON t.id = e.taskId " +
      "ORDER BY COALESCE(e.completedAt, e.startedAt, e.createdAt) DESC LIMIT 15"
  );

  // ---------- 6. 组装 ----------
  const macsById = new Map<string, any>();
  for (const a of macs) if (a?.agent_id) macsById.set(a.agent_id, a);

  const ids = new Set<string>();
  for (const a of registry) if (a.agent_id) ids.add(a.agent_id);
  for (const a of macs) if (a?.agent_id) ids.add(a.agent_id);
  lastTaskByAgent.forEach((_v, k) => ids.add(k));
  lastExecByAgent.forEach((_v, k) => ids.add(k));
  submitByAgent.forEach((_v, k) => { if (k !== "(未知)") ids.add(k); });
  // 2026-09-10: 只自报过 token 用量的 agent 也要出现在看板上 (可能还没进注册表)
  tokenByAgent.forEach((_v, k) => ids.add(k));
  if (only) {
    for (const id of Array.from(ids)) if (id !== only) ids.delete(id);
  }

  const agents = Array.from(ids).map((agentId) => {
    const reg = registry.find((a) => a.agent_id === agentId) || null;
    const mac = macsById.get(agentId) || null;
    const macLastSeen = mac?.last_seen ? Date.parse(String(mac.last_seen).replace(" ", "T") + "+08:00") : NaN;
    const regLastSeen = reg?.last_seen_at ? num(reg.last_seen_at) : NaN;
    const lastSeen = Math.max(Number.isFinite(macLastSeen) ? macLastSeen : 0, Number.isFinite(regLastSeen) ? regLastSeen : 0) || null;
    const macsOnline = mac?.status === "online";
    const registryActive = reg?.status === "ACTIVE";
    // 2026-09-11: 执行体身份(有工具、无常驻 worker) 不进 MACS 在线/离线判定
    const toolCapable = toolCapableAgents.includes(agentId);
    const role = toolCapable ? "executor" : reg || mac ? "agent" : "assignee-only";

    const cur = inProgressTasks.find((t) => t.assignedAgent === agentId) || null;
    const assignedPending = assignedPendingTasks.filter((t) => t.assignedAgent === agentId);
    const last = lastTaskByAgent.get(agentId) || null;
    const ts = taskStats.find((x) => x.assignedAgent === agentId) || null;
    const ex = lastExecByAgent.get(agentId) || null;
    const exs = execStatByAgent.get(agentId) || null;
    const sub = submitByAgent.get(agentId) || null;

    // 卡住判定
    let state: "online" | "busy" | "idle" | "offline" | "stuck" | "executor" = "idle";
    let stateLabel = "空闲";
    let stuckReason: string | null = null;
    if (role === "executor" && !cur) {
      // 执行体: 不判在线/离线 (它没有常驻执行器), 单独一态
      state = "executor";
      stateLabel = "执行体（无常驻执行器）";
      stuckReason = "执行体身份: 任务需人工/会话唤醒, 不会被自动认领";
    } else if (cur) {
      const idleMs = now - num(cur.updatedAt);
      if (idleMs > STUCK_TASK_MS) {
        state = "stuck";
        stateLabel = "疑似卡住";
        stuckReason = `任务《${String(cur.title).slice(0, 40)}》已 ${Math.round(idleMs / 60000)} 分钟无更新`;
      } else {
        state = "busy";
        stateLabel = "正在执行任务";
      }
    } else if (macsOnline) {
      state = "online";
      stateLabel = "在线待命";
    } else if (lastSeen && now - lastSeen > OFFLINE_MS) {
      state = "offline";
      stateLabel = "离线";
    } else if (registryActive || macsOnline) {
      state = "online";
      stateLabel = "在线待命";
    }
    // 执行体不参与"超过 24h 未露面 = 离线"的判定 (它本来就没有 MACS 心跳)
    if (role !== "executor" && state !== "offline" && lastSeen && now - lastSeen > OFFLINE_MS) {
      stuckReason = stuckReason || `最近露面 ${Math.round((now - lastSeen) / 3600000)} 小时前`;
      if (state === "online" || state === "idle") { state = "offline"; stateLabel = "离线"; }
    }

    const avgQuality = sub && sub.qN ? round(sub.qSum / sub.qN, 3) : null;
    return {
      agentId,
      displayName: reg?.display_name || mac?.display_name || agentId,
      channel: reg?.channel || mac?.channel || null,
      host: reg?.host || mac?.host || null,
      role,                                   // 2026-09-11: agent | executor | assignee-only
      registryRole: reg?.role || null,        // 注册表里的角色 (ADMIN/OWNER/...)
      roleLabel: role === "executor" ? "执行体（无通信服务通道）" : role === "assignee-only" ? "仅出现在任务字段(未接入)" : "智能体",
      toolCapable,
      registryStatus: reg?.status || null,
      macsStatus: mac?.status || (macsOk ? "offline" : "unknown"),
      macsMessages24h: num(mac?.messages_24h),
      lastSeenAt: lastSeen,
      lastSeenAgoMin: lastSeen ? Math.round((now - lastSeen) / 60000) : null,
      state,
      stateLabel,
      stuckReason,
      currentTask: cur ? { id: cur.id, title: cur.title, status: cur.status, theme: cur.theme, priority: cur.priority, improvementType: cur.improvementType ?? null, scope: scopeOfType(cur.improvementType), updatedAt: cur.updatedAt, idleMin: Math.round((now - num(cur.updatedAt)) / 60000) } : null,
      assignedPendingCount: assignedPending.length,
      assignedPending: assignedPending.slice(0, 5).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, improvementType: t.improvementType ?? null, scope: scopeOfType(t.improvementType), updatedAt: num(t.updatedAt) })),
      lastTask: last ? { id: last.id, title: last.title, status: last.status, theme: last.theme, improvementType: last.improvementType ?? null, scope: scopeOfType(last.improvementType), updatedAt: last.updatedAt, completedAt: last.completedAt } : null,
      taskStats: { done: num(ts?.done), failed: num(ts?.failed), running: num(ts?.running), pending: num(ts?.pending) },
      doneByScope: (() => {
        const out: Record<string, number> = {};
        for (const row of taskScopeRows) {
          if (row.assignedAgent !== agentId || row.status !== "DONE") continue;
          const k = scopeOfType(row.improvementType);
          out[k] = (out[k] || 0) + num(row.c);
        }
        return out;
      })(),
      tokenUsage: tokenByAgent.get(agentId)
        ? {
            tokens: tokenByAgent.get(agentId)!.tokens,
            calls: tokenByAgent.get(agentId)!.calls,
            lastAt: tokenByAgent.get(agentId)!.lastAt,
            byTask: tokenByAgent.get(agentId)!.byTask,
          }
        : null,
      taskScopeStats: (() => {
        const out: Record<string, number> = { MECHANISM: 0, VERIFY: 0, DISCUSSION: 0, OTHER: 0 };
        for (const row of taskScopeRows) {
          if (row.assignedAgent !== agentId) continue;
          out[scopeOfType(row.improvementType)] += num(row.c);
        }
        return out;
      })(),
      lastExecution: ex
        ? { id: ex.id, taskId: ex.taskId, taskTitle: ex.taskTitle, status: ex.status, qualityPassed: ex.qualityPassed, completedAt: ex.completedAt ?? ex.startedAt, retryCount: num(ex.retryCount) }
        : null,
      execStats: exs ? { n: num(exs.n), completed: num(exs.completed), failed: num(exs.failed), passed: num(exs.passed), lastAt: num(exs.lastAt) } : null,
      lastOutput: sub ? { at: sub.lastAt, quality: sub.lastQuality, targetId: sub.lastTarget, n: sub.n } : null,
      outputQuality: avgQuality,
    };
  });

  agents.sort((a, b) => {
    const rank: Record<string, number> = { stuck: 0, busy: 1, online: 2, idle: 3, offline: 4 };
    return rank[a.state] - rank[b.state] || num(b.lastSeenAt) - num(a.lastSeenAt);
  });

  // 2026-10-21 前端修复：summary 里 5 个 scalar 原来没有 await —— 存进对象的是 Promise，
  //   JSON 序列化后变成 {}，前端只好显示"—"（活跃看板"24h 任务完成 / 失败 / 全类型"三格一直是空的）。
  const [taskDone, taskFailed, taskDoneAll, taskDoneAgentType, taskDoneDialogue] = await Promise.all([
    scalar(mind, "SELECT COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ?" + mechFilter, r.since),
    scalar(mind, "SELECT COUNT(*) c FROM Task WHERE status='FAILED' AND updatedAt > ?" + mechFilter, r.since),
    scalar(mind, "SELECT COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ?", r.since),
    scalar(mind, "SELECT COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ? AND improvementType='VERIFY_AGENT_OUTPUT'", r.since),
    scalar(mind, "SELECT COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ? AND improvementType='DISCUSSION_QUESTION'", r.since),
  ]);

  const summary = {
    total: agents.length,
    online: agents.filter((a) => a.state === "online" || a.state === "busy").length,
    busy: agents.filter((a) => a.state === "busy").length,
    idle: agents.filter((a) => a.state === "idle").length,
    stuck: agents.filter((a) => a.state === "stuck").length,
    offline: agents.filter((a) => a.state === "offline").length,
    taskDone, taskFailed, taskDoneAll, taskDoneAgentType, taskDoneDialogue,
    taskDoneByType: (await q(mind, "SELECT COALESCE(improvementType,'(未分类)') type, COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ? GROUP BY improvementType ORDER BY c DESC", r.since))
      .map((x: any) => ({ type: x.type, count: num(x.c), scope: scopeOfType(x.type) })),
    taskScope: { key: "MECHANISM", label: "机制修复类", types: IMPROVEMENT_TYPES, note: "改进任务口径 = GOAL_GAP + THEME_IMPROVE + PLATFORM_REVIEW" },
    // 2026-09-11: 把 busy/idle/stuck 的判据显式返回, UI 悬浮可见
    stateRules: {
      busy: "有 status ∈ (IN_PROGRESS, PROCESSING) 且 assignedAgent=该 agent 的任务",
      idle: "没有在办任务 (被派单但未开始算 待开始, 不算 busy)",
      stuck: `在办任务距上次更新超过 ${Math.round(STUCK_TASK_MS / 60000)} 分钟 (与 claim 路由的回收阈值一致)`,
      offline: "MACS 离线 且 注册表非 ACTIVE, 或超过 24 小时未露面",
      executor: "执行体身份(有工具、无常驻执行器): 不进在线/离线判定, 任务需人工或会话唤醒",
      onDuty: "近 24h 完成数按 scope 拆分: 机制修复 / 智能体型(验证裁决) / 对话问答 / 其他",
    },
    capability: { toolCapableAgents },
    // 2026-09-10: agent 自报 token 用量 (sourceType='agent:<id>')
    tokenUsage: {
      agents: tokenByAgent.size,
      tokens: Array.from(tokenByAgent.values()).reduce((s, a) => s + a.tokens, 0),
      calls: tokenRows.length,
      note: "智能体提交任务时带用量上报；未上报的智能体侧消耗平台不可见",
      byAgent: Array.from(tokenByAgent.values())
        .map((a) => ({ agentId: a.agentId, tokens: a.tokens, calls: a.calls, lastAt: a.lastAt }))
        .sort((a, b) => b.tokens - a.tokens),
    },
    taskByScope: (() => {
      const out: Record<string, any> = {};
      for (const row of taskScopeRows) {
        const k = scopeOfType(row.improvementType);
        out[k] = out[k] || { key: k, all: 0, done: 0, failed: 0, running: 0 };
        out[k].all += num(row.c);
        if (row.status === "DONE") out[k].done += num(row.c);
        else if (row.status === "FAILED") out[k].failed += num(row.c);
        else if (row.status === "IN_PROGRESS" || row.status === "PROCESSING") out[k].running += num(row.c);
      }
      return out;
    })(),
    // 2026-10-21：和 summary 里那 5 个一样，这里原来也没 await → JSON 变 {} → 卡片显示 "-次"。
    executions: await scalar(mind, "SELECT COUNT(*) c FROM TaskExecution WHERE COALESCE(completedAt, startedAt, createdAt) > ?", r.since),
    submissions: submitRows.length,
    avgQuality: (() => {
      let s = 0, n = 0;
      submitByAgent.forEach((v) => { s += v.qSum; n += v.qN; });
      return n ? round(s / n, 3) : null;
    })(),
  };

  safeClose(mind);
  return NextResponse.json({
    asOf: asOf(),
    now: nowSec,
    range: { key: r.key, label: r.label, since: r.since },
    warnings,
    summary,
    agents,
    recent: recentExec.map((e) => ({
      agentId: e.agentId, status: e.status, qualityPassed: e.qualityPassed,
      at: e.completedAt ?? e.startedAt, taskTitle: e.taskTitle, taskId: e.taskId,
    })),
  });
}