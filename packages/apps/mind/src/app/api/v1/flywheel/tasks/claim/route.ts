import { prisma } from "@/lib/prisma";
import { claimSeatAtomic } from "@/server/pipeline/max-agents";
import {
  getAgentCapability,
  missingCapabilities,
  canClaimTask,
  VERIFY_REQUIREMENT,
  EVIDENCE_TITLE_PREFIXES,
  EVIDENCE_TITLE_MARKERS,
  EVIDENCE_IMPROVEMENT_TYPES,
  claimableImprovementTypesSqlList,
} from "@/server/pipeline/agent-capability";
import { resolveQuota } from "@/server/pipeline/agent-quota";
import { claimWithLease, recycleExpiredLeases, getLease, defaultLeaseMsFor } from "@/server/pipeline/task-lease";
import { circuitState } from "@/server/pipeline/claim-circuit";
import { missingPrerequisites, PREREQUISITE_SKIP } from "@/server/pipeline/task-prerequisite";

// POST /api/v1/flywheel/tasks/claim — agent 原子认领一条可执行的改进任务(2026-09-08 Phase2)
// Body: { agentId: string, types?: string[], excludeTypes?: string[] }
// claimable: PENDING 且 manualReview!=true 且 (improvementType IS NULL OR improvementType IN types 默认 ['THEME_IMPROVE'])
//           且 sourceReflectionIds 非空(反思衍生, 需 LLM 判断); BRIDGE 由 L1 自动执行, 不在此列
// excludeTypes: 排除指定 type(responder 文本通道无 DB 工具, 排除 THEME_IMPROVE 这类需真实执行的 payload 任务)
export async function POST(req: Request) {
  let body: { agentId?: string; types?: string[]; excludeTypes?: string[]; leaseMs?: number };
  try { body = await req.json(); } catch { return Response.json({ error: "INVALID_JSON" }, { status: 400 }); }
  const agentId = (body.agentId || "").trim();
  if (!agentId) return Response.json({ error: "MISSING_AGENT_ID" }, { status: 400 });

  // 2026-10-27 S2 授权: maxAgents 上限（近 24h 活跃口径）。
  //   已在活跃集合内的 agent 不受影响（避免满额后现有 agent 互相踢下线）；
  //   超限返回 402 + {active, limit}，**不静默降级**。
  {
    // 2026-10-27: 改用**原子占席**（平台数据线批准的修法 b）。
    //   原 checkMaxAgents 只读不写，并发新 agent 会同时读到 active=0 → 全部放行（实测 2/2 都 200）。
    //   现在事务内 advisory lock 串行化"判活+占席"，并在占席时写 last_seen_at。
    const cap = await claimSeatAtomic(agentId);
    if (!cap.ok) {
      return Response.json({
        error: cap.code, reason: cap.reason, active: cap.active, limit: cap.limit,
      }, { status: 402 });
    }
  }
  // 2026-10-25: 按 agent 熔断 —— 该 agent 最近外部故障过多时暂停派单（不连累健康 agent）
  {
    const st = circuitState(agentId);
    if (st.paused) {
      // 2026-10-25: 把"被熔断挡下"记成事件 —— 否则节流是否生效完全不可见
      prisma.flywheelEvent.create({ data: { stage: "CLAIM_SKIPPED", sourceType: "claim", sourceId: agentId,
        sourceTitle: ("circuit_open by=" + agentId + " faults=" + st.faults + " retryAfterMs=" + st.retryAfterMs).slice(0, 240), targetStage: "OK" } }).catch(() => null);
      return Response.json({
        ok: false, error: "CIRCUIT_OPEN", retryAfterMs: st.retryAfterMs, faults: st.faults,
        detail: "该 agent 最近 " + st.faults + " 次外部通道故障（401/超时/空输出），暂停认领 " + Math.ceil(st.retryAfterMs / 60000) + " 分钟；通道恢复后自动解除。",
      }, { status: 429 });
    }
  }
  const types = body.types && body.types.length ? body.types : ["THEME_IMPROVE"];
  const excludeTypes = (body.excludeTypes || []).filter(Boolean).map((t: string) => t.replace(/[^A-Z_]/g, ""));
  // 2026-09-11 能力路由收尾: 删除"GOAL_GAP 顺带返回 VERIFY/DISCUSSION"的兼容垫片。
  //   前置条件已满足(实测): 全部 5 个消费者 + uos20 的 .env 均已显式声明
  //   CLAIM_TYPES=THEME_IMPROVE,PLATFORM_REVIEW,GOAL_GAP,VERIFY_AGENT_OUTPUT,DISCUSSION_QUESTION,
  //   并已重启生效 —— 即"能领什么"由消费端**显式声明**, 不再由服务端隐式扩族。
  //   影响: 若某个旧客户端仍只传 GOAL_GAP, 它将**不再**收到 VERIFY_AGENT_OUTPUT/DISCUSSION_QUESTION 任务。
  //   这是刻意的: 隐式扩族会让"认领类型"与"配置声明"不一致, 排查困难(实测踩过)。
  const expandedTypes = Array.from(new Set(types));
  // 2026-09-11 能力路由守卫: 机制修复类任务(标题前缀 [机制修复], 需改代码/查库/部署)只能由"有工具的执行体"认领;
  //   文本通道 agent 认领后会只能交提案/UNVERIFIABLE(实测), 属于错误分工。名单由 CLAIM_TOOL_CAPABLE_AGENTS 配置。
  // 2026-09-11 能力分级落地(用户批准): 改为读 **AgentRegistry.profile.capabilityTier**(单一权威源)。
  //   此前这里读环境变量 CLAIM_TOOL_CAPABLE_AGENTS, 而 agents-live / work-plan / 消费端 .env / cron 白名单
  //   各自也有一份判断 —— 5 处漂移导致过"复核任务静默不可认领"的事故。现统一走 agent-capability.ts。
  //   兼容: 注册表未登记该 agent 时回退到环境变量(视为 T3), 再回退 T0 最小权限 —— 行为与改动前一致。
  const cap = await getAgentCapability(agentId);
  const toolCapable = cap.toolCapable;
  // 2026-10-27 P0: 新 cohort 优先（只对最近 24h 新建任务），否则新单永远排在 1000+ 旧 P2 后面，
  //   新单一次交对永远没有 DONE 样本。默认开，CLAIM_FRESH_FIRST=0 可回退。
  const FRESH_FIRST = String(process.env.CLAIM_FRESH_FIRST ?? "1") !== "0";
  const FRESH_HOURS = Math.max(1, Math.min(48, Number(process.env.CLAIM_FRESH_HOURS ?? 12)));
  const freshOrderSql = FRESH_FIRST
    ? "(CASE WHEN \"createdAt\" >= (now() at time zone 'UTC') - interval '" + FRESH_HOURS + " hours' THEN 0 ELSE 1 END), "
    : "";
  // 2026-09-11 消费端健康闸门(不空转): 实测 agent-f 的大脑(hermes)挂掉后仍在每 2 分钟认领一条,
  //   认领后交不出结论 -> 任务卡 IN_PROGRESS 30 分钟被回收 -> 再认领, 队列被"僵尸消费者"反复占用。
  //   判据: 近 60 分钟认领数 ≥ 6 且成功提交数 = 0 => 判定消费端不健康, 暂不派单(队列留给健康的消费者)。
  //   可用 CLAIM_HEALTH_GUARD=0 关闭。恢复方式: 该 agent 恢复提交后判据自动失效(无需人工解锁)。
  // 2026-09-14 服务端额度(用户要求"后台可配置 + 可自适应"): 额度不再是消费端 .env 的自律值 ——
  //   这里统一读注册表(AgentRegistry.profile.quota)并按"任务余量 + 接口消耗 + 队列老化"自适应,
  //   超限直接不派单并把构成一并回传, 让"谁被限住、被什么限住"在看板上可见。
  //   此前额度散在 7 台机器的 .env 里, 打满即静默停摆且无人知晓(实测 09-14 四个 agent 同日 60/60 全部停机)。
  //   每次认领都回传 quota, 消费端据此显示与提示, 服务端是权威。
  let quota: Awaited<ReturnType<typeof resolveQuota>> | null = null;
  try { quota = await resolveQuota(agentId); } catch { quota = null; }
  const HEALTH_GUARD = String(process.env.CLAIM_HEALTH_GUARD ?? "1") !== "0";
  let unhealthy: { claims: number; submits: number } | null = null;
  if (HEALTH_GUARD) {
    try {
      // 2026-10-25 修真 bug: 原来把 JS 毫秒数绑到 timestamp 列上(createdAt >= ?)，PG 直接报
      //   "operator does not exist: timestamp >= bigint"，异常被下面的 catch 吞掉 -> 健康闸门**从未生效**。
      //   这正是 10-24 出现"同一任务被领 496 次"时它没拦住的原因。改成用 DB 时钟比较。
      const c: any[] = await prisma.$queryRawUnsafe(
        // 会话时区默认 Asia/Shanghai，而 Prisma 把 DateTime 以 UTC 写进 timestamp 列 ->
        //   now() 直接比较会偏 8 小时。统一用 (now() at time zone 'UTC')。
        // 2026-10-26: 支持"通道修好后立即重评"——若该 agent 有过 AGENT_HEALTH_RESET 事件，
        //   只统计该事件之后的认领，避免修好的 agent 被旧记录挡满 60 分钟（配合 probation 更稳）。
        "SELECT COUNT(*) n FROM \"TaskStateTransition\" t WHERE t.\"toStatus\"='IN_PROGRESS' AND t.actor=? " +
          "AND t.\"createdAt\" >= GREATEST((now() at time zone 'UTC') - interval '1 hour', " +
          "COALESCE((SELECT MAX(e.\"createdAt\") FROM \"FlywheelEvent\" e WHERE e.stage='AGENT_HEALTH_RESET' AND e.\"sourceTitle\" LIKE ?), (now() at time zone 'UTC') - interval '1 hour'))",
        "agent:" + agentId, "reset by=" + agentId + "%");
      const s: any[] = await prisma.$queryRawUnsafe(
        "SELECT COUNT(*) n FROM \"TaskExecution\" WHERE \"agentId\"=? AND status='COMPLETED' AND \"completedAt\" >= (now() at time zone 'UTC') - interval '1 hour'",
        agentId);
      const claims = Number(c?.[0]?.n ?? 0);
      const submits = Number(s?.[0]?.n ?? 0);
      // 2026-10-26: 健康判据改为"**agent 自身原因**的放回"，不再数原始认领。
      //   实测问题: 平台通道故障（429/超时/EAI_AGAIN）也算进 claims，于是 agent 明明是被平台拖垮，
      //   却被判 AGENT_UNHEALTHY 停派单；而解除条件又要求"成功提交"，形成死锁。
      //   现在只数**非外部故障**的放回（reason 不以 [external-fault] 开头、也不是隔离自动放回）。
      const bad: any[] = await prisma.$queryRawUnsafe(
        "SELECT COUNT(*) n FROM \"TaskStateTransition\" WHERE \"toStatus\"='PENDING' AND actor=? " +
          "AND \"createdAt\" >= GREATEST((now() at time zone 'UTC') - interval '1 hour', " +
          "COALESCE((SELECT MAX(e.\"createdAt\") FROM \"FlywheelEvent\" e WHERE e.stage='AGENT_HEALTH_RESET' AND e.\"sourceTitle\" LIKE ?), (now() at time zone 'UTC') - interval '1 hour')) " +
          "AND COALESCE(reason,'') NOT LIKE '[external-fault]%' AND COALESCE(reason,'') NOT LIKE '%隔离自动放回%'",
        "agent:" + agentId, "reset by=" + agentId + "%");
      const badReleases = Number(bad?.[0]?.n ?? 0);
      if (badReleases >= 5 && submits === 0) unhealthy = { claims: badReleases, submits };
    } catch { /* 健康判据失败不阻断认领 */ }
  }
  // 2026-09-14 leader 修**死锁**: 健康闸门判 unhealthy 后**一律不派单**, 而闸门只在"有成功提交"时才解除 ——
  //   于是"刚被修好的 agent"最长要干等 60 分钟(等旧认领滚出窗口)才能自证。实测: agent-b 的大脑
  //   误杀缺陷修好后, 仍被"6 认领/0 提交"的旧记录挡在门外, 无法证明自己已经能干活。
  //   现改为**试探性认领(probation)**: unhealthy 的 agent 若距上次认领已超过 CLAIM_PROBATION_MIN(默认 20 分钟),
  //   放行**一条**用于自证; 成功提交即解除, 再次失败则继续被挡。既保留"僵尸消费者不占队列"的初衷,
  //   又不制造"修好了也进不来"的死锁。
  let probation = false;
  if (unhealthy) {
    const PROBATION_MIN = Number(process.env.CLAIM_PROBATION_MIN ?? 20);
    let lastClaimAt = 0;
    try {
      const rows: any[] = await prisma.$queryRawUnsafe(
        "SELECT MAX(\"createdAt\") t FROM \"TaskStateTransition\" WHERE \"toStatus\"='IN_PROGRESS' AND actor=?",
        "agent:" + agentId);
      lastClaimAt = Number(rows?.[0]?.t ?? 0);
    } catch { lastClaimAt = Date.now(); }
    const waitMs = PROBATION_MIN * 60000;
    if (!lastClaimAt || Date.now() - lastClaimAt >= waitMs) probation = true;
    else {
      prisma.flywheelEvent.create({ data: { stage: "CLAIM_SKIPPED", sourceType: "claim", sourceId: agentId,
        sourceTitle: ("unhealthy by=" + agentId + " claims=" + unhealthy.claims + " submits=" + unhealthy.submits).slice(0, 240), targetStage: "OK" } }).catch(() => null);
      return Response.json({
        ok: true, task: null, skipped: "AGENT_UNHEALTHY", detail: unhealthy, quota, probationInMin: Math.max(1, Math.ceil((waitMs - (Date.now() - lastClaimAt)) / 60000)),
        detail2: "近 60 分钟认领多而零提交; 距上次认领满 " + PROBATION_MIN + " 分钟后会放行一条试探性任务用于自证。",
      });
    }
  }
  if (quota && quota.remaining <= 0) {
    return Response.json({
      ok: true, task: null, skipped: "QUOTA_EXCEEDED", quota,
      detail: "今日额度已用尽(" + quota.used + "/" + quota.limit + "); " + quota.reason,
    });
  }

  try {
    // 2026-09-15 派单路由修复(任务 cmu24ffju084dki4a5khu22g8): "取证必需型任务"的 SQL 粗判据。
    //   用于 ① 非 T3 认领时在 SQL 层排除; ② PENDING 归属纠偏; ③ 诚实 SKIP 的计数。
    //   精确判定仍以 canClaimTask()/classifyTaskRequirement() 为准(纯函数, 见下方)。
    const EVIDENCE_REQUIRED_SQL =
      "(" + EVIDENCE_TITLE_PREFIXES.map((p) => "title LIKE '" + p + "%'").join(" OR ") +
      " OR " + EVIDENCE_TITLE_MARKERS.map((m) => "title LIKE '%" + m + "%'").join(" OR ") +
      " OR improvementType IN (" + EVIDENCE_IMPROVEMENT_TYPES.map((t) => "'" + t + "'").join(",") + ")" +
      " OR improvementPayload LIKE '%\"kind\":\"VERIFY_AGENT_OUTPUT\"%'" +
      " OR improvementPayload LIKE '%\"kind\":\"PROPOSAL_VERIFY\"%')";
    // 0) 回收过期 IN_PROGRESS 回 PENDING(agent 掉线兜底)
    // 2026-09-14 认领并发控制落地(提案 cmtwb7z1o00l11j76e6tx65um / 复核 cmu0stufv00nuki4ag8rzt5ur):
    //   改为**租约感知**回收 —— leaseExpiresAt 到期(有心跳的新数据) 或 无租约且 updatedAt 超时(历史兼容)
    //   才回收; 统一走 task-lease.recycleExpiredLeases, 每条都写对称审计(metadata 带 beforeOwner/afterOwner +
    //   version 前后值)。修复复核复测6 指出的"认领可审计、释放不可审计"。
    try {
      const recycled = await recycleExpiredLeases({ timeoutMs: 30 * 60_000, limit: 200 });
      if (recycled.length) {
        console.log("[claim] 租约/超时回收 " + recycled.length + " 条: " + JSON.stringify(recycled.slice(0, 5)));
      }
    } catch (e: any) {
      console.warn("[claim] 回收失败(非致命): " + String(e?.message || "").slice(0, 120));
    }
    // 0.5) 归属失效回收(2026-09-14 实测缺陷): PENDING 且 assignedAgent 指向"已停用/未登记"的 agent。
    //   认领 SQL 有归属约束 (assignedAgent IS NULL OR assignedAgent = 本agent), 所以一旦任务被指派给一个
    //   已经不存在(或非 ACTIVE)的 agent, 它对**所有**健康 agent 都永久不可见 —— 上面的 stale 回收器只管
    //   IN_PROGRESS>30min, 对"PENDING 但归属已失效"完全没有覆盖。
    //   实测: 15 条 P1([落地] 提案落地)锁在 INACTIVE/未登记的 agent-d-exec 名下, 停留在公开队列里却无人能领。
    //   判据(二选一即为失效): 注册表无此 agent / status != 'ACTIVE'。
    //   ★ 2026-09-14 复测修正(需求 3 "不误伤: ACTIVE 一律不动"): 原实现把"last_seen_at 为空 / 心跳 >7 天"
    //     也当成释放条件 —— 这会**误伤** status=ACTIVE 的 agent(实测注册表 operator 为 ACTIVE 但从未有心跳,
    //     其名下指派会被错误释放)。ACTIVE 即"在岗", 归属一律不动; 心跳陈旧属于注册表数据质量问题,
    //     应由管理员改注册表状态来裁决, 而不是让回收器越权改 ACTIVE 的归属。
    let orphan: any[] = [];
    try {
      orphan = await prisma.$queryRawUnsafe<any[]>(
        "SELECT t.id, t.assignedAgent FROM Task t LEFT JOIN AgentRegistry r ON r.agent_id = t.assignedAgent " +
        "WHERE t.status='PENDING' AND t.assignedAgent IS NOT NULL AND (" +
        "  r.agent_id IS NULL OR r.status <> 'ACTIVE'" +
        ") LIMIT 200"
      );
    } catch { orphan = []; }
    if (orphan && orphan.length) {
      await prisma.$executeRawUnsafe(
        "UPDATE Task SET assignedAgent=NULL, updatedAt=? WHERE status='PENDING' AND assignedAgent IS NOT NULL AND id IN (" +
        orphan.map(() => "?").join(",") + ")",
        new Date(), ...orphan.map((o) => String(o.id))
      );
      for (const o of orphan) {
        await prisma.taskStateTransition.create({
          data: { taskId: String(o.id), fromStatus: "PENDING", toStatus: "PENDING",
            actor: "system:claim-recycler",
            reason: ("归属失效释放: assignedAgent=" + String(o.assignedAgent || "-") + " 未登记或 status != ACTIVE, 释放回公开队列").slice(0, 240) },
        }).catch(() => null);
      }
    }
    // 0.6) 2026-09-15 取证必需型的**归属纠偏**(路由修复的配套, 防止"改了守卫却把任务锁死"):
    //   新守卫(claim / claim-by-id / POST /tasks)拦住了"新账", 但历史或旁路写入的指派仍可能把
    //   取证必需型任务挂在文本通道名下 —— 文本通道领不了(缺能力), T3 又因 assignedAgent 约束看不到,
    //   任务会永久卡在 PENDING。这里用与守卫同一口径(agent-capability.canClaimTask)把这类指派释放回公开队列,
    //   并写对称审计(actor=system:claim-recycler)。有注册表才判(隔离测试库无注册表时不动)。
    try {
      const coarse: any[] = await prisma.$queryRawUnsafe(
        "SELECT id, title, assignedAgent, improvementType, improvementPayload FROM Task " +
        "WHERE status='PENDING' AND assignedAgent IS NOT NULL AND " + EVIDENCE_REQUIRED_SQL + " LIMIT 200");
      const byAgent = new Map<string, any[]>();
      for (const r of coarse || []) {
        const a = String(r.assignedAgent);
        if (!byAgent.has(a)) byAgent.set(a, []);
        byAgent.get(a)!.push(r);
      }
      for (const [a, list] of byAgent) {
        const c2 = await getAgentCapability(a);
        const stuck = list.filter((t) => !canClaimTask(c2, t).ok);
        if (!stuck.length) continue;
        await prisma.$executeRawUnsafe(
          "UPDATE Task SET assignedAgent=NULL, expectedOwner=NULL, updatedAt=? WHERE status='PENDING' AND assignedAgent=? AND id IN (" +
          stuck.map(() => "?").join(",") + ")",
          new Date(), a, ...stuck.map((t) => String(t.id))
        );
        for (const t of stuck) {
          await prisma.taskStateTransition.create({
            data: { taskId: String(t.id), fromStatus: "PENDING", toStatus: "PENDING", actor: "system:claim-recycler",
              reason: ("取证必需型路由纠偏: assignedAgent=" + a + " T" + c2.tier + " 缺 " + canClaimTask(c2, t).missing.join("、") + " -> 释放回公开队列, 只由有工具的执行体认领").slice(0, 240) },
          }).catch(() => null);
        }
        console.log("[claim] 路由纠偏释放 " + stuck.length + " 条(原指派 " + a + " T" + c2.tier + ")");
      }
    } catch (e: any) {
      console.warn("[claim] 路由纠偏失败(非致命): " + String(e?.message || "").slice(0, 120));
    }
    // 1) 找一条可领: PENDING + manualReview!=true + 反思衍生 + type 匹配(或 null)
    // 2026-09-14: 同时取 version / expectedOwner / leaseExpiresAt, 供后续 version CAS 使用。
    // 2026-09-15 派单路由修复(任务 cmu24ffju084dki4a5khu22g8):
    //   原硬闸只挡 "[机制修复]" 一个前缀 —— 于是 improvementType=VERIFICATION / payload.kind=VERIFY_AGENT_OUTPUT /
    //   标题含 [落地] 的**取证必需型**任务照旧被派给无 db/file 能力的文本通道。验收台账实测:
    //   165 条 evidence-attached FAIL 的执行者全是 T1/T2/未登记通道, T3 执行体 0 条 —— 这些通道的产出原文是
    //   "本通道无工具, 不包含任何已执行变更", 结构上交不出锚点。
    //   现在两层过滤:
    //     ① SQL 层(EVIDENCE_REQUIRED_SQL): 非 T3 先排除取证必需型, 省流量;
    //     ② JS 层(canClaimTask, 纯函数): 用与 classifyTaskRequirement 同一口径逐条复核, 兜住 SQL 表达不了的新形态。
    // 2026-09-18 [粒度规范配套·前置依赖闸门] docs/platform-logic/task-decomposition-spec-2026-09-18.md §4/G5。
    //   实测: prerequisiteTaskIds 自建表起**全库无人写、也无人读**(只在 improving-tasks DTO 里被回显),
    //   于是"前置没做完就可以抢着做" —— 并发下等于让人在别人未完成的改动上继续施工。
    //   判定实现**单一来源**: @/server/pipeline/task-prerequisite(claim 与 claim-by-id 共用一份, 不各写一套)。
    const cands: any[] = await prisma.$queryRawUnsafe(
      // 2026-10-25: PENDING 状态下的 leaseExpiresAt 表示"外部故障冷却到"，冷却期内不可再被认领 ——
      //   否则通道坏的瞬间会形成"认领->故障释放->立刻再认领"的紧密循环（实测 12 个任务被领 1,316 次）。
      "SELECT id, title, version, assignedAgent, expectedOwner, leaseExpiresAt, improvementType, improvementPayload, prerequisiteTaskIds FROM Task WHERE status='PENDING' AND (manualReview IS NOT TRUE) " +
      // 用 DB 时钟比较，避免把 JS 毫秒数绑到 timestamp 列上（类型不匹配会让候选查询整体失败、静默返回空）
      "AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= (now() at time zone 'UTC')) " +
      // 2026-09-10: 除"反思衍生"任务外, 平台目标/审查类任务(GOAL_GAP/PLATFORM_REVIEW)也应可被 agent 认领
      // 2026-09-11 第 35 轮修(实测缺陷): 白名单漏了 **VERIFICATION** —— 该类型任务由 POST /api/v1/flywheel/tasks
      //   手工创建, sourceReflectionIds 为空, 于是**两个条件都不满足 -> 永远不可认领**。
      //   复核任务因此长期卡 PENDING; 加上前两处闸门(v16 cron 抢走后判 FAILED / 消费端 CLAIM_TYPES 未声明),
      //   "机制改动后开独立复核"实际上是完全失效的。三处都已补。
      // 2026-09-17 补 VERIFY: 实测存在 improvementType='VERIFY' 的任务(提案复核生成侧), 而白名单里只有
      //   'VERIFICATION' —— 该任务因此**对所有人都不可认领**(体检由 scripts/lib/task-revive.cjs 的
      //   auditUnclaimable 发现)。认领白名单必须覆盖生成侧实际产出的类型, 否则"活摆在那里没人能领"。
      // 2026-09-17 单一来源: 白名单不再写死在这里, 改读 agent-capability.ts 的 CLAIMABLE_IMPROVEMENT_TYPES
      //   (数据源 claimable-task-types.json), 与生成侧/体检/指标侧共用同一份 —— 口径分叉本身就是这次要根治的病。
      "AND ((sourceReflectionIds IS NOT NULL AND sourceReflectionIds != '[]') OR improvementType IN (" + claimableImprovementTypesSqlList() + ")) " +
      "AND (improvementType IS NULL OR improvementType IN (" + expandedTypes.map((t: string) => "'" + t.replace(/[^A-Z_]/g, "") + "'").join(",") + ")) " +
      (excludeTypes.length > 0 ? "AND (improvementType IS NULL OR improvementType NOT IN (" + excludeTypes.map((t: string) => "'" + t + "'").join(",") + ")) " : "") +
      (toolCapable ? "" : "AND NOT " + EVIDENCE_REQUIRED_SQL + " ") +
      "AND (assignedAgent IS NULL OR assignedAgent = ?) " +
      // 2026-09-14 expectedOwner 显式归属断言: 若库里写了 expectedOwner, 认领者必须与之匹配, 否则视为"归属已变"。
      "AND (expectedOwner IS NULL OR expectedOwner = ?) " +
      // 2026-09-11 agent协同修复(指派可达): 原排序只看 P1/创建时间, "指派给我的"任务排在 44 条公开积压之后,
      //   实测 20+ 分钟无人领。改为: 指派给我的绝对优先 -> P0/P1/P2 -> 先创建的优先。
      "ORDER BY (CASE WHEN assignedAgent = ? THEN 0 ELSE 1 END), " +
      freshOrderSql +
      "(CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END), createdAt ASC LIMIT 20",
      agentId,
      agentId,
      agentId
    );
    // 能力复核(纯函数): 只有真正不缺能力的候选才算可领; 被能力挡下的如实记账。
    const capChecked = (cands || []).map((c: any) => ({ c, check: canClaimTask(cap, c) }));
    // 前置闸门(见上方 prereqMissing 说明): 能力通过但前置未完成的不派 -> 记账, 不静默。
    const preMiss = await missingPrerequisites(prisma as any, (cands || []).filter((c: any) => canClaimTask(cap, c).ok));
    const picked = capChecked.find((x) => x.check.ok && !preMiss.has(String(x.c.id)))?.c || null;
    const blockedByCap = capChecked.filter((x) => !x.check.ok);
    const blockedByPrereq = capChecked.filter((x) => x.check.ok && preMiss.has(String(x.c.id)));
    if (!picked) {
      // 2026-09-14 诚实 SKIP(需求 3): 无能力接单时不再静默返回 task:null。
      // 2026-09-15 扩到全部取证必需型: 队列里压着该 agent 因能力不足领不了的取证任务时, 明确回报: 缺什么 + 压了多少条。
      //   这样"文本通道空转"是可观测的, 而不是消失在日志里。
      if (!toolCapable) {
        try {
          const blocked: any[] = await prisma.$queryRawUnsafe(
            "SELECT COUNT(*) n FROM Task WHERE status='PENDING' AND (manualReview IS NOT TRUE) " +
            "AND " + EVIDENCE_REQUIRED_SQL + " AND (assignedAgent IS NULL OR assignedAgent = ?)", agentId);
          const n = Math.max(Number(blocked?.[0]?.n ?? 0), blockedByCap.length);
          if (n > 0) {
            const repReq = VERIFY_REQUIREMENT;
            return Response.json({
              ok: true, task: null,
              skipped: "CAPABILITY_INSUFFICIENT",
              taskKind: "EVIDENCE_REQUIRED",
              taskKindLabel: "取证必需型(机制修复/落地/复核/补证)",
              agentTier: cap.tier,
              agentDimensions: cap.dimensions,
              missing: missingCapabilities(cap, repReq),
              blockedCount: n,
              detail: `队列中有 ${n} 条取证必需型任务(机制修复/落地/复核/补证)需要真实工具能力(查库/查文件/跑命令留锚点); agent ${agentId} 为 T${cap.tier}(${cap.source}), 缺: ${missingCapabilities(cap, repReq).join("、")} —— 按能力路由不派给你, 这是诚实 SKIP 而非无活可干。`,
              hint: "文本通道只承接不需要取证的结论型任务(如问答/讨论/纯分析); 取证必需型请由有 db/file 工具的执行体(注册表 capabilityTier=T3)认领。",
              quota,
            });
          }
        } catch { /* SKIP 说明失败不阻断正常返回 */ }
      }
      if (blockedByPrereq.length > 0) {
        const first = blockedByPrereq[0];
        const miss = preMiss.get(String(first.c.id)) || [];
        return Response.json({
          ok: true, task: null, quota,
          ...PREREQUISITE_SKIP, // 单一来源(措辞与 claim-by-id 一致, 避免两个入口两套说法)
          blockedCount: blockedByPrereq.length,
          prerequisiteTaskIds: miss,
          detail: "队列里有 " + blockedByPrereq.length + " 条任务的前置尚未 DONE(如 " + String(first.c.title || "").slice(0, 40) + " 缺 " + miss.map((x) => x.slice(0, 8)).join(",") + "); 按粒度规范 §4/G5 不派给你 —— 这是依赖闸门而非无活可干。",
        });
      }
      return Response.json({ ok: true, task: null, quota });
    }
    const tid = String(picked.id);
    const expectedVersion = Number(picked.version ?? 0);
    // 2) 原子认领: 单语句 version CAS + 写租约(leaseExpiresAt) + expectedOwner, 影响行=1 才算成功。
    //    2026-09-14: 相比旧实现(只 CAS status='PENDING'), 这里额外把 version 纳入 WHERE,
    //    使"读候选 -> 写认领"之间发生的任何归属变化(被回收/被接管/被提交)都能被检出 -> 不静默双领。
    // 2026-10-23 P1: 未显式指定租约时按任务类型给默认 TTL（机制类任务比交互类耗时长）
    const claim = await claimWithLease({ taskId: tid, agentId, expectedVersion, leaseMs: body.leaseMs ?? defaultLeaseMsFor(picked.improvementType) });
    if (!claim.ok) {
      // 竞争失败: 如实回报冲突原因(不假装领到、也不静默吞掉)
      return Response.json({ ok: true, task: null, quota, conflict: claim.reason });
    }
    const task: any = await prisma.task.findUnique({
      where: { id: tid },
      select: { id: true, title: true, description: true, requirements: true, acceptanceCriteria: true,
                theme: true, priority: true, sourceReflectionIds: true, improvementType: true, createdAt: true,
                background: true, materials: true, improvementPayload: true, structuredContext: true },
    });
    // 2026-09-14 租约并发控制: 回传版本与租约, 消费端可据此续约(heartbeat)/检测归属漂移。
    //   用 getLease(原始 SQL) 附加, 避免依赖"本进程已重新生成 Prisma client"(hot-reload 时可能是旧的)。
    if (task) {
      try { Object.assign(task, await getLease(tid)); } catch { /* 附加失败不影响认领 */ }
    }
    // 2026-09-10 记忆前置注入: 认领即带上与任务相关的平台记忆/知识/技能(避免"平台存过却没人用")
    let contextSeed = "";
    try {
      const { searchContext, renderContextSeed } = await import("@/server/pipeline/context-seed");
      const hits = await searchContext({
        theme: (task as any)?.theme || undefined,
        query: (((task as any)?.title || "") + " " + ((task as any)?.requirements || "").slice(0, 100)).trim(),
        limit: 5,
      source: "task-claim",   // round 72-AF: 声明调用者身份
      });
      contextSeed = renderContextSeed(hits);
      // 记录本次注入了哪些记忆/知识/技能(提交时据此计使用 -> 供冷却与"越用越强"度量)
      if (hits.length) {
        await prisma.flywheelEvent.create({
          data: {
            stage: "CONTEXT_INJECTED",
            sourceType: "claim",
            sourceId: tid,
            sourceTitle: JSON.stringify({ agentId, count: hits.length, kinds: Array.from(new Set(hits.map((h) => h.kind))), ids: hits.map((h) => h.id) }).slice(0, 900),
            targetStage: "OK",
          },
        }).catch(() => null);
      }
    } catch (e: any) {
      console.warn("[claim] contextSeed 构建失败(非致命): " + (e?.message || "").slice(0, 80));
    }
    return Response.json({ ok: true, task, contextSeed, quota, ...(probation ? { probation: true, probationNote: "试探性认领: 你此前被判不健康, 成功提交本条即自动解除" } : {}) });
  } catch (e: any) {
    return Response.json({ error: "CLAIM_FAILED", message: String((e && e.message) || e) }, { status: 500 });
  }
}
