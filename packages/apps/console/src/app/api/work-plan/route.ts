import { NextResponse } from "next/server";
import { asOf, num, one, openMind, q, readMindEnv, safeClose, scalar } from "@/lib/server/lions-db";
import { scopeOfType } from "@/config/taskScopes";
import { macsAdminKey } from "@/lib/server/macs-admin";

export const dynamic = "force-dynamic";

// GET /api/work-plan?range=24h
// 2026-09-11 用户反馈: 活跃看板"看不出工作安排"。本接口回答四个问题:
//   ① 队列里有什么 (可认领 / 执行体专属 / 进行中 / 近24h 完成)
//   ② 谁在办什么 (每 agent 在办任务 + 最近提交)
//   ③ 为什么某些 agent 现在没活 (空闲原因: 队列空 / 被能力守卫拦截 / 未接入 / 执行体身份)
//   ④ 生成器状态 (AGENT_TASK_GENERATED 事件 + 下次生成时间)
// 只读 + 容错: 库不可用时返回空结构, 绝不 500。
const STALE_CLAIM_MIN = 30;          // 与 claim 路由一致: >30min 的 IN_PROGRESS 会被回收
const GENERATOR_CRON = "*/30 * * * *"; // scripts/generate-agent-tasks.cjs (crontab)

export async function GET(req: Request) {
  const url = new URL(req.url);
  const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") || "24", 10) || 24, 1), 168);
  const now = Date.now();
  const since = now - hours * 3600e3;
  const mind = openMind();
  const warnings: string[] = [];
  if (!mind) warnings.push("mind 库不可用: 工作安排已降级");

  // 能力守卫名单 (与 mind claim 路由同源: 环境变量优先, 其次 mind/.env.local, 默认 agent-d)
  const envCapable = process.env.CLAIM_TOOL_CAPABLE_AGENTS || "";
  const fileCapable = envCapable ? "" : (readMindEnv("CLAIM_TOOL_CAPABLE_AGENTS") || "");
  const capableEnv = envCapable || fileCapable || "agent-d";
  const toolCapableAgents = capableEnv.split(",").map((s) => s.trim()).filter(Boolean);
  const capabilitySource = envCapable ? "env" : fileCapable ? "mind/.env.local" : "default(未显式配置, 与 mind claim 路由同默认值)";

  // ---------- ① 队列 ----------
  // 2026-09-11 修正(用户实测缺陷): 旧口径把"已定向派单给执行体"的任务也算进 claimable,
  //   而 claim 路由要求 assignedAgent 为空(或等于自己) → 文本 agent 实际领不到, 属口径错误。
  // 定义(三者互斥关系见 response.queues.invariants):
  //   claimable       = PENDING 且 assignedAgent 为空 且 标题不以 [机制修复] 开头   ← 文本 agent 真的能领到
  //   executorOnly    = PENDING 且 (标题以 [机制修复] 或 [落地] 开头 或 assignedAgent ∈ 执行体名单)
  //   assignedPending = PENDING 且 assignedAgent 非空 (允许与 executorOnly 重叠, 标注"已定向派单")
  const capList = toolCapableAgents.map((x) => "'" + String(x).replace(/'/g, "") + "'").join(",");
  const capClause = capList ? `assignedAgent IN (${capList})` : "1=0";
  const claimableWhere =
    "status='PENDING' AND (assignedAgent IS NULL OR assignedAgent = '') AND title NOT LIKE '[机制修复]%'";
  // claim 路由还会额外要求: manualReview!=true 且 (反思衍生 或 类型白名单) —— 单列为"claim 路由可返回"的子集
  const claimableRouteWhere =
    claimableWhere + " AND (manualReview IS NOT TRUE) AND ((sourceReflectionIds IS NOT NULL AND sourceReflectionIds != '[]') " +
    "OR improvementType IN ('GOAL_GAP','PLATFORM_REVIEW','VERIFY_AGENT_OUTPUT','DISCUSSION_QUESTION'))";
  const executorWhere = `status='PENDING' AND (title LIKE '[机制修复]%' OR title LIKE '[落地]%' OR ${capClause})`;
  const assignedPendingWhere = "status='PENDING' AND assignedAgent IS NOT NULL AND assignedAgent != ''";

  const queueCols = "id, title, improvementType, priority, theme, createdAt, assignedAgent";
  const claimableRows = await q(
    mind,
    `SELECT ${queueCols} FROM Task WHERE ${claimableWhere} ORDER BY (CASE WHEN priority='P0' THEN 0 WHEN priority='P1' THEN 1 ELSE 2 END), createdAt ASC LIMIT 200`
  );
  const claimableRouteRows = await q(
    mind,
    `SELECT ${queueCols} FROM Task WHERE ${claimableRouteWhere} ORDER BY createdAt ASC LIMIT 200`
  );
  const executorRows = await q(
    mind,
    `SELECT ${queueCols} FROM Task WHERE ${executorWhere} ORDER BY (CASE WHEN priority='P0' THEN 0 WHEN priority='P1' THEN 1 ELSE 2 END), createdAt ASC LIMIT 200`
  );

  const shapeTask = (t: any) => ({
    id: t.id,
    title: t.title,
    improvementType: t.improvementType || null,
    scope: scopeOfType(t.improvementType),
    priority: t.priority || null,
    theme: t.theme || null,
    createdAt: num(t.createdAt),
    assignedAgent: t.assignedAgent || null,
    ageMin: Math.round((now - num(t.createdAt)) / 60000),
  });
  const byType = (rows: any[]) => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.improvementType || "(未分类)"] = (m[r.improvementType || "(未分类)"] || 0) + 1;
    return Object.entries(m).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  };

  // 进行中 (按 agent)
  const inProgressRows = await q(
    mind,
    "SELECT id, title, improvementType, priority, theme, assignedAgent, updatedAt, createdAt FROM Task " +
      "WHERE status IN ('IN_PROGRESS','PROCESSING') ORDER BY updatedAt DESC LIMIT 200"
  );
  const inProgressByAgent = new Map<string, any[]>();
  for (const t of inProgressRows) {
    const key = t.assignedAgent || "(未指派)";
    const arr = inProgressByAgent.get(key) || [];
    arr.push({ ...shapeTask(t), updatedAt: num(t.updatedAt), idleMin: Math.round((now - num(t.updatedAt)) / 60000) });
    inProgressByAgent.set(key, arr);
  }

  // 近 N 小时完成 / 失败 (按 improvementType)
  const doneRows = await q(
    mind,
    "SELECT COALESCE(improvementType,'(未分类)') type, COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ? GROUP BY improvementType",
    since
  );
  const failedRows = await q(
    mind,
    "SELECT COALESCE(improvementType,'(未分类)') type, COUNT(*) c FROM Task WHERE status='FAILED' AND updatedAt > ? GROUP BY improvementType",
    since
  );
  const doneByType = doneRows.map((r) => ({ type: r.type, count: num(r.c), scope: scopeOfType(r.type) })).sort((a, b) => b.count - a.count);
  const doneTotal = doneByType.reduce((s, x) => s + x.count, 0);
  const doneByScope: Record<string, number> = {};
  for (const r of doneByType) doneByScope[r.scope] = (doneByScope[r.scope] || 0) + r.count;

  // 认领过但未完成的 (assignedAgent 有值且 PENDING) —— 被派单/占位
  const assignedPendingRows = await q(
    mind,
    `SELECT ${queueCols} FROM Task WHERE ${assignedPendingWhere} ORDER BY createdAt ASC LIMIT 200`
  );

  // ---------- ② 每 agent: 在办 / 完成 / 最近提交 ----------
  const lastSubmitRows = await q(
    mind,
    "SELECT e.agentId, MAX(COALESCE(e.completedAt, e.startedAt, e.createdAt)) lastAt, COUNT(*) n " +
      "FROM TaskExecution e WHERE COALESCE(e.completedAt, e.startedAt, e.createdAt) > ? GROUP BY e.agentId",
    since
  );
  const lastSubmit = new Map<string, { at: number; n: number }>();
  for (const r of lastSubmitRows) if (r.agentId) lastSubmit.set(r.agentId, { at: num(r.lastAt), n: num(r.n) });
  const lastSubmitEver = await q(
    mind,
    "SELECT e.agentId, MAX(COALESCE(e.completedAt, e.startedAt, e.createdAt)) lastAt FROM TaskExecution e GROUP BY e.agentId"
  );
  const lastSubmitAll = new Map<string, number>();
  for (const r of lastSubmitEver) if (r.agentId) lastSubmitAll.set(r.agentId, num(r.lastAt));

  const doneByAgentRows = await q(
    mind,
    "SELECT assignedAgent, COUNT(*) c FROM Task WHERE status='DONE' AND completedAt > ? AND assignedAgent IS NOT NULL GROUP BY assignedAgent",
    since
  );
  const doneByAgent = new Map<string, number>();
  for (const r of doneByAgentRows) doneByAgent.set(r.assignedAgent, num(r.c));
  // 分 scope 的完成数 (让"agent 型任务"不被隐藏)
  const doneScopeByAgentRows = await q(
    mind,
    "SELECT assignedAgent, COALESCE(improvementType,'(未分类)') type, COUNT(*) c FROM Task " +
      "WHERE status='DONE' AND completedAt > ? AND assignedAgent IS NOT NULL GROUP BY assignedAgent, improvementType",
    since
  );
  const doneScopeByAgent = new Map<string, Record<string, number>>();
  for (const r of doneScopeByAgentRows) {
    const m = doneScopeByAgent.get(r.assignedAgent) || {};
    m[scopeOfType(r.type)] = (m[scopeOfType(r.type)] || 0) + num(r.c);
    doneScopeByAgent.set(r.assignedAgent, m);
  }

  // ---------- 消费端健康(与 mind claim 路由的闸门同判据, 2026-09-11) ----------
  // 判据: 近 60 分钟认领 >= 6 且提交 = 0 => 僵尸消费者(认领不产出), 平台已停止派单。
  // 为什么放进工作安排: 实测 agent-f 大脑挂掉后仍在认领, 看板上却显示"正在消费", 属于误导。
  const HEALTH_MIN = 60;
  const healthSince = now - HEALTH_MIN * 60000;
  const claimsMap = new Map<string, number>();
  for (const r of await q(mind, "SELECT REPLACE(actor,'agent:','') a, COUNT(*) n FROM TaskStateTransition WHERE toStatus='IN_PROGRESS' AND createdAt >= ? GROUP BY a", healthSince)) {
    claimsMap.set(String(r.a), num(r.n));
  }
  const submitsMap = new Map<string, number>();
  for (const r of await q(mind, "SELECT agentId a, COUNT(*) n FROM TaskExecution WHERE completedAt >= ? GROUP BY a", healthSince)) {
    submitsMap.set(String(r.a), num(r.n));
  }

  // ---------- 注册表 + MACS ----------
  const registry = await q(mind, "SELECT agent_id, display_name, channel, host, status, last_seen_at FROM AgentRegistry");
  const regById = new Map<string, any>();
  for (const r of registry) regById.set(r.agent_id, r);
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
  const macsById = new Map<string, any>();
  for (const m of macs) if (m?.agent_id) macsById.set(m.agent_id, m);

  const ids = new Set<string>();
  for (const r of registry) ids.add(r.agent_id);
  for (const m of macs) if (m?.agent_id) ids.add(m.agent_id);
  inProgressByAgent.forEach((_v, k) => { if (k !== "(未指派)") ids.add(k); });
  doneByAgent.forEach((_v, k) => ids.add(k));
  lastSubmitAll.forEach((_v, k) => ids.add(k));
  for (const t of executorRows) if (t.assignedAgent) ids.add(t.assignedAgent);

  const claimableTotal = claimableRows.length;
  const executorTotal = executorRows.length;
  const executorAssignedTotal = executorRows.filter((t) => t.assignedAgent).length;

  const agents = Array.from(ids).map((agentId) => {
    const reg = regById.get(agentId) || null;
    const mac = macsById.get(agentId) || null;
    const toolCapable = toolCapableAgents.includes(agentId);
    const roles: string[] = [];
    if (toolCapable) roles.push("executor");
    if (reg) roles.push("registered");
    else if (mac) roles.push("macs-only");
    // 2026-09-11 修正(实测缺陷): AgentRegistry 里 channel='human' 的是**人类账号**(如 operator/运营者),
    //   旧逻辑把它当 agent, 于是看板上出现"等待该 agent 下次轮询认领"—— 人根本不会轮询, 这是错误陈述。
    const isHuman = String(reg?.channel || "").toLowerCase() === "human";
    const role = isHuman ? "human" : toolCapable ? "executor" : reg ? "agent" : mac ? "agent" : "assignee-only";
    const cur = inProgressByAgent.get(agentId) || [];
    const done = doneByAgent.get(agentId) || 0;
    const sub = lastSubmit.get(agentId) || null;
    const lastEver = lastSubmitAll.get(agentId) || null;
    const macsOnline = mac?.status === "online";
    const registryActive = reg?.status === "ACTIVE";
    const lastSeen = Math.max(num(reg?.last_seen_at), mac?.last_seen ? Date.parse(String(mac.last_seen).replace(" ", "T") + "+08:00") : 0) || null;
    // 2026-09-11 修正(实测缺陷): 旧 online = macsOnline || registryActive, 于是"注册表 ACTIVE 但 4 天没露面"
    //   的 agent(如 agent-i) 被显示成在线。改为要求**近期露面证据**(24h)。
    const lastSeenRecent = lastSeen != null && now - lastSeen < 24 * 3600e3;
    const claimsLastHour = claimsMap.get(agentId) || 0;
    const submitsLastHour = submitsMap.get(agentId) || 0;
    const zombie = !isHuman && !toolCapable && claimsLastHour >= 6 && submitsLastHour === 0;
    const liveness = isHuman ? "human" : toolCapable ? "executor" : zombie ? "unhealthy"
      : macsOnline || lastSeenRecent ? "consuming" : registryActive || reg ? "quiet" : "offline";
    const livenessText = liveness === "human" ? "人类账号(不参与任务认领; 其待办走 ownerType=human)"
      : liveness === "executor" ? "执行体身份（有工具）：不进通信服务在线 / 离线判定，任务需人工或会话唤醒"
      : liveness === "unhealthy" ? `僵尸消费者: 近 ${HEALTH_MIN} 分钟认领 ${claimsLastHour} 次但提交 0 次 -> 平台已按健康闸门暂停派单(claim 返回 AGENT_UNHEALTHY), 在办 ${cur.length} 条需等 30 分钟回收`
      : liveness === "consuming" ? (macsOnline ? "通信服务在线且近期有露面，正在消费队列" : "通信服务未见但 24 小时内有露面证据")
      : liveness === "quiet" ? "注册表为 ACTIVE 但 24h 内无露面证据(不当作在线)"
      : "无注册记录 / 通信服务离线";

    // 空闲原因 (回答"为什么现在没活")
    let idleReason: string | null = null;
    let idleReasonText = "";
    if (cur.length > 0) {
      const maxIdle = Math.max(...cur.map((t) => t.idleMin));
      idleReason = maxIdle > STALE_CLAIM_MIN ? "stale_in_progress" : "has_work";
      idleReasonText = maxIdle > STALE_CLAIM_MIN
        ? `有 ${cur.length} 条在办但已 ${maxIdle} 分钟未更新(超过 ${STALE_CLAIM_MIN} 分钟会被回收重派)`
        : `正在办 ${cur.length} 条任务`;
    } else if (isHuman) {
      idleReason = "human_owner";
      idleReasonText = "人类账号: 不参与任务认领(其名下待办的 ownerType=human, 由人处理)";
    } else if (role === "executor") {
      idleReason = "executor_identity";
      idleReasonText = "执行体身份: 无常驻执行器, 任务需人工/会话唤醒 (不会被自动认领)";
    } else if (!macsOnline && !registryActive) {
      // 未接入/掉线的 agent 优先归因"未接入", 而不是"能力守卫"(它本来就没在轮询)
      idleReason = "not_integrated";
      idleReasonText = macsOk && mac ? "通信服务离线：未接入 / 已掉线，无法认领任务" : "未在通信服务注册或名册非活跃";
    } else if (role === "agent" && !toolCapable && executorTotal > 0 && claimableTotal === 0) {
      idleReason = "capability_guard";
      idleReasonText = `被能力守卫拦截: ${executorTotal} 条执行体专属任务(其中 ${executorAssignedTotal} 条已定向派单给 ${toolCapableAgents.join("/")}), 而可认领队列为 0 —— 文本 agent 当前确实没有能领的活`;
    } else if (claimableTotal === 0) {
      idleReason = "queue_empty";
      idleReasonText = `可认领队列为空(0 条"无负责人且非 [机制修复]"的任务)`;
    } else {
      idleReason = "waiting";
      idleReasonText = `队列有 ${claimableTotal} 条可认领任务, 等待该 agent 下次轮询认领`;
    }

    // 僵尸消费者的根因比"在办超时"更重要: 在办超时是**结果**, 认领不产出才是原因
    if (zombie) {
      idleReason = "zombie_consumer";
      idleReasonText = livenessText;
    }

    return {
      agentId,
      displayName: reg?.display_name || mac?.display_name || agentId,
      role,
      roleLabel: role === "executor" ? "执行体（无通信服务通道）" : role === "human" ? "人（非智能体）" : role === "assignee-only" ? "仅出现在任务字段(未注册)" : "智能体",
      toolCapable,
      channel: reg?.channel || mac?.channel || null,
      host: reg?.host || mac?.host || null,
      registryStatus: reg?.status || null,
      macsStatus: mac?.status || (macsOk ? "offline" : "unknown"),
      // online 保持布尔向后兼容, 但语义收紧为"有近期露面证据"; 细粒度见 liveness
      online: liveness === "consuming" || liveness === "executor",
      liveness,
      livenessText,
      consumer: { claimsLastHour, submitsLastHour, zombie, windowMin: HEALTH_MIN },
      lastSeenAt: lastSeen,
      currentTasks: cur,
      assignedPending: assignedPendingRows.filter((t) => t.assignedAgent === agentId).map(shapeTask),
      doneSince: done,
      doneByScope: doneScopeByAgent.get(agentId) || {},
      lastSubmitAt: sub ? sub.at : null,
      lastSubmitCount: sub ? sub.n : 0,
      lastSubmitEverAt: lastEver,
      idleReason,
      idleReasonText,
    };
  });

  agents.sort((a, b) => {
    const rank: Record<string, number> = { executor: 1, agent: 2, "assignee-only": 3, human: 4 };
    const r = (rank[a.role] || 9) - (rank[b.role] || 9);
    if (r) return r;
    if (a.currentTasks.length !== b.currentTasks.length) return b.currentTasks.length - a.currentTasks.length;
    return b.doneSince - a.doneSince;
  });

  // ---------- ④ 生成器 ----------
  const genLast = await one(
    mind,
    "SELECT id, sourceType, sourceTitle, createdAt FROM FlywheelEvent WHERE stage='AGENT_TASK_GENERATED' ORDER BY createdAt DESC LIMIT 1"
  );
  const genCount = await scalar(mind, "SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='AGENT_TASK_GENERATED' AND createdAt > ?", since);
  const genCreatedSum = (async () => {
    const rows = await q(mind, "SELECT sourceTitle FROM FlywheelEvent WHERE stage='AGENT_TASK_GENERATED' AND createdAt > ? LIMIT 200", since);
    let sum = 0;
    for (const r of rows) {
      const m = /created=(\d+)/.exec(String(r.sourceTitle || ""));
      if (m) sum += Number(m[1]);
    }
    return sum;
  })();
  const parseGen = (title: string) => {
    const g = (k: string) => { const m = new RegExp(k + "=(\\d+)").exec(title); return m ? Number(m[1]) : null; };
    return { created: g("created"), candidatesClaims: g("candidates_claims"), failedTask: g("failed_task"), extractError: g("extract_error") };
  };
  const everyMin = 30;
  const d = new Date(now);
  const next = new Date(now);
  const mins = d.getMinutes();
  const nextMinute = mins < 30 ? 30 : 60;
  next.setMinutes(nextMinute === 60 ? 0 : nextMinute, 0, 0);
  if (nextMinute === 60) next.setHours(next.getHours() + 1);

  const generator = {
    cron: GENERATOR_CRON,
    everyMinutes: everyMin,
    nextRunAt: next.getTime(),
    nextRunInMin: Math.round((next.getTime() - now) / 60000),
    last: genLast
      ? {
          at: num(genLast.createdAt),
          ageMin: Math.round((now - num(genLast.createdAt)) / 60000),
          raw: String(genLast.sourceTitle || ""),
          ...parseGen(String(genLast.sourceTitle || "")),
        }
      : null,
    runsSince: genCount,
    createdSince: genCreatedSum,
    script: "scripts/generate-agent-tasks.cjs",
    note: "每 30 分钟生成智能体型任务（挑战问题 / 诊断链路异常 / 复盘机制修复），单轮上限 4 条",
  };

  safeClose(mind);
  return NextResponse.json({
    asOf: asOf(),
    now,
    windowHours: hours,
    warnings,
    capability: { toolCapableAgents, source: capabilitySource },
    queues: {
      // 三者定义与互斥关系 (2026-09-11 修正后口径)
      claimable: {
        count: claimableTotal,
        byType: byType(claimableRows),
        samples: claimableRows.slice(0, 10).map(shapeTask),
        definition: "PENDING 且 assignedAgent 为空 且 标题不以 [机制修复] 开头 —— 文本 agent 真的能领到",
        routeEligible: { count: claimableRouteRows.length, note: "其中还满足 claim 路由的附加条件(manualReview!=true 且 反思衍生或类型白名单)" },
      },
      executorOnly: {
        count: executorTotal,
        byType: byType(executorRows),
        samples: executorRows.slice(0, 10).map(shapeTask),
        assignedToExecutor: executorRows.filter((t) => t.assignedAgent).length,
        awaitingExecutorClaim: executorRows.filter((t) => !t.assignedAgent).length,
        definition: "PENDING 且 (标题以 [机制修复] 或 [落地] 开头, 或 assignedAgent ∈ 执行体名单) —— 需改代码/查库/部署, 文本 agent 领不到",
      },
      assignedPending: {
        count: assignedPendingRows.length,
        samples: assignedPendingRows.slice(0, 10).map(shapeTask),
        definition: "PENDING 且 assignedAgent 非空 —— 已定向派单, 在等对方开始(不算在办)",
        note: "与 executorOnly 允许重叠(定向派给执行体的那部分)",
      },
      inProgress: { count: inProgressRows.length, byAgent: Array.from(inProgressByAgent.entries()).map(([agentId, tasks]) => ({ agentId, count: tasks.length, tasks })) },
      // 窗口标注: 完成/失败都是"近 N 小时"口径, 字段形状在此显式写出
      doneSince: {
        total: doneTotal,
        byType: doneByType,                                 // [{ type, count, scope }]
        byScope: doneByScope,                               // { MECHANISM, VERIFY, DISCUSSION, OTHER }
        windowHours: hours,
        windowLabel: `近 ${hours} 小时`,
        since,
        basis: "Task.status='DONE' AND completedAt > since",
      },
      failedSince: {
        total: failedRows.reduce((s, r) => s + num(r.c), 0),
        byType: failedRows.map((r) => ({ type: r.type, count: num(r.c) })),
        windowHours: hours,
        windowLabel: `近 ${hours} 小时`,
        since,
        basis: "Task.status='FAILED' AND updatedAt > since",
      },
      // 互斥断言 (供前端/对账直接校验)
      invariants: (() => {
        const idsOf = (rows: any[]) => rows.map((r) => r.id);
        const c = new Set(idsOf(claimableRows));
        const overlapCE = idsOf(executorRows).filter((id) => c.has(id));
        const overlapCA = idsOf(assignedPendingRows).filter((id) => c.has(id));
        return {
          claimable_x_executorOnly: overlapCE,
          claimable_x_assignedPending: overlapCA,
          ok: overlapCE.length === 0 && overlapCA.length === 0,
          rule: "claimable ∩ executorOnly = ∅ 且 claimable ∩ assignedPending = ∅",
        };
      })(),
    },
    agents,
    generator,
    stateRules: {
      busy: `有 status ∈ (IN_PROGRESS, PROCESSING) 且 assignedAgent=该 agent 的任务`,
      idle: "没有在办任务(未被派单), 具体原因见 idleReason",
      stuck: `在办任务距上次更新超过 ${STALE_CLAIM_MIN} 分钟(与 claim 路由的回收阈值一致, 会被自动重置回 PENDING)`,
      offline: "MACS 离线 且 注册表非 ACTIVE 且 24h 内无露面证据",
      quiet: "注册表为 ACTIVE 但 24h 内无露面证据 —— 不当作在线(2026-09-11 修正: 旧口径把 4 天没露面的智能体显示为在线)",
      human: "channel='human' 的人类账号: 不是智能体, 不参与任务认领(2026-09-11 修正)",
      unhealthy: "僵尸消费者: 近 60 分钟认领>=6 且提交=0(与 claim 路由的健康闸门同判据, 2026-09-11)",
      executor: "执行体身份(有工具): 无常驻执行器, 不进 MACS 在线/离线判定, 任务需人工或会话唤醒",
      counts: `"近 ${hours}h 完成" 按 Task.status='DONE' AND completedAt 归集, 并按 improvementType 分 scope`,
    },
  });
}