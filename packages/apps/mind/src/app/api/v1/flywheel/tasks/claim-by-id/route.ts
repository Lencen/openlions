import { prisma } from "@/lib/prisma";
import { searchContext, renderContextSeed } from "@/server/pipeline/context-seed"
import { buildInjectedTitle } from "@/server/pipeline/injected-ids";
import { getAgentCapability, canClaimTask } from "@/server/pipeline/agent-capability";
import { prerequisiteBlocked, PREREQUISITE_SKIP } from "@/server/pipeline/task-prerequisite";
import { claimWithLease, defaultLeaseMsFor } from "@/server/pipeline/task-lease";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/flywheel/tasks/claim-by-id — 定向认领指定任务 (2026-09-10)
 * 背景(实测): 既有 /tasks/claim 只能取"最旧的 PENDING", 执行体想认领自己那条时会领到别的任务
 *   (我在闭环"部署自检闸"时就误领了"执行者能力路由")。
 * Body: { taskId, agentId }  ->  与 claim 同样的守卫: PENDING + manualReview!=true + 未指派或指派给本人
 * 返回: { ok, task, contextSeed } ; 失败: { ok:false, error }
 * 2026-09-14 能力守卫补齐: 此前本路由**只**校验类型/指派, 不校验能力 —— 是 [机制修复] 守卫的
 *   定向认领绕过口(文本通道只要知道 taskId 就能领走机制修复任务, 再交一份提案)。现与 claim 同口径:
 *   标题 [机制修复] 开头 -> 需 tier>=3 且四维(tools/db/file/network)齐全, 否则 403 CAPABILITY_REQUIRED
 *   并如实列出"缺什么"(不静默、不假装能接)。
 */
export async function POST(req: Request) {
  let body: { taskId?: string; agentId?: string; types?: string[]; excludeTypes?: string[]; leaseMs?: number } = {};
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "INVALID_JSON" }, { status: 400 }); }
  const taskId = String(body.taskId || "").trim();
  const agentId = String(body.agentId || "").trim();
  if (!taskId || !agentId) return Response.json({ ok: false, error: "MISSING_FIELDS" }, { status: 400 });
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT id, title, status, assignedAgent, expectedOwner, version, leaseExpiresAt, improvementType, improvementPayload FROM Task WHERE id = ? LIMIT 1", taskId);
    if (!rows.length) return Response.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    const t = rows[0];
    if (String(t.status) !== "PENDING") return Response.json({ ok: false, error: "NOT_PENDING", status: t.status }, { status: 409 });
    if (t.assignedAgent && String(t.assignedAgent) !== agentId) return Response.json({ ok: false, error: "ASSIGNED_TO_OTHER", assignedAgent: t.assignedAgent }, { status: 403 });
    // 2026-09-14 能力守卫(与 claim 路由同口径, 堵住定向认领绕过)
    // 2026-09-15 派单路由修复: 原硬闸只对 MECHANISM_FIX 生效 —— 于是文本通道只要知道 taskId, 就能绕过 claim
    //   队列把 [落地]/VERIFICATION/payload.kind=VERIFY_AGENT_OUTPUT 的取证必需型任务定向领走(实测这正是
    //   165 条 evidence-attached FAIL 的来源之一)。现在改为: classifyTaskRequirement 判出所需能力, 缺任一即 403。
    //   不需取证的结论型任务(GENERAL, minTier 0/dimensions []) missing 恒为空 -> 文本通道不受影响。
    const cap = await getAgentCapability(agentId);
    const canClaim = canClaimTask(cap, { title: t.title, improvementType: t.improvementType, improvementPayload: t.improvementPayload });
    const req_ = canClaim.requirement;
    const missing = canClaim.missing;
    if (missing.length > 0) {
      return Response.json({
        ok: false,
        error: "CAPABILITY_REQUIRED",
        skipped: "CAPABILITY_INSUFFICIENT",
        taskKind: req_.kind,
        taskKindLabel: req_.label,
        evidenceRequired: req_.evidenceRequired,
        agentTier: cap.tier,
        agentDimensions: cap.dimensions,
        missing,
        detail: `任务「${String(t.title || "").slice(0, 40)}」属${req_.label}; agent ${agentId} 为 T${cap.tier}(${cap.source}), 缺: ${missing.join("、")} —— 这类任务不派给无工具/无执行权限的通道。`,
        hint: "文本通道只承接不需取证的结论型任务(问答/讨论/纯分析); 取证必需型(机制修复/落地/复核/补证)请交给有 db/file 工具的执行体(注册表 capabilityTier=T3)。",
      }, { status: 403 });
    }
    // 2026-09-18 [粒度规范 §4/G5] 前置依赖闸门: 按 id 认领也必须尊重 prerequisiteTaskIds,
    //   否则按 id 直领(自动执行体/指派路径)会绕过 claim 队列的前置闸门 —— 那正是"闸门只装在一条路径上"
    //   的老病(同款教训见 service-check 的 spec:todo-close-single-entry / spec:revive-single-entry)。
    //   判定实现单一来源: @/server/pipeline/task-prerequisite(容错: 空/脏依赖放行, 已删除的前置视为作废)。
    const preMiss = await prerequisiteBlocked(prisma as any, t);
    if (preMiss.length > 0) {
      return Response.json({
        ok: false,
        error: PREREQUISITE_SKIP.skipped,
        ...PREREQUISITE_SKIP,
        taskId,
        prerequisiteTaskIds: preMiss,
        detail: "任务「" + String(t.title || "").slice(0, 40) + "」的前置尚未 DONE: " + preMiss.map((x) => x.slice(0, 8)).join(", ") + " —— 依赖未满足不派单(粒度规范 §4/G5)。",
      }, { status: 409 });
    }
    // 2026-10-25: 外部故障冷却期（PENDING + leaseExpiresAt > now）不可定向认领，避免通道故障时的紧循环。
    {
      const cd = Number((t as any).leaseExpiresAt || 0);
      if (cd > Date.now()) {
        return Response.json({ ok: false, error: "COOLDOWN", until: new Date(cd).toISOString(),
          detail: "该任务刚因外部通道故障被释放，冷却中；恢复后可再领。" }, { status: 409 });
      }
    }
    // 2026-09-10 复核整改: 补类型守卫(与 claim 口径一致) — 此前只校验 PENDING/指派, 不校验类型
    const DEFAULT_TYPES = ["GOAL_GAP", "THEME_IMPROVE", "PLATFORM_REVIEW", "VERIFY_AGENT_OUTPUT", "DISCUSSION_QUESTION"];
    const allowedTypes = Array.isArray(body.types) && body.types.length ? body.types.map(String) : DEFAULT_TYPES;
    const excludedTypes = Array.isArray(body.excludeTypes) ? body.excludeTypes.map(String) : [];
    const ty = String(t.improvementType || "");
    if (ty && !allowedTypes.includes(ty)) return Response.json({ ok: false, error: "TYPE_NOT_ALLOWED", improvementType: ty, allowed: allowedTypes }, { status: 403 });
    if (ty && excludedTypes.includes(ty)) return Response.json({ ok: false, error: "TYPE_EXCLUDED", improvementType: ty }, { status: 403 });
    // 2026-09-14 认领并发控制: 单语句 version CAS + 写租约 + expectedOwner(见 task-lease.claimWithLease)。
    //   原实现只 CAS status='PENDING', 读候选与写认领之间的归属变化(被回收/被接管)检测不到。
    const claim = await claimWithLease({
      taskId, agentId,
      expectedVersion: Number(t.version ?? 0),
      leaseMs: body.leaseMs ?? defaultLeaseMsFor(ty),
      reason: "定向认领 claim-by-id",
    });
    if (!claim.ok) return Response.json({ ok: false, error: "CLAIM_RACE", detail: claim.reason }, { status: 409 });
    const task: any = await prisma.task.findUnique({ where: { id: taskId } });
    let contextSeed = "";
    try {
      const hits = await searchContext({ query: (String(task?.title || "") + " " + String(task?.theme || "")).slice(0, 120), theme: task?.theme || undefined, limit: 5, source: "task-claim" });
      contextSeed = renderContextSeed(hits); // 2026-09-23 agent-x #1: 容量 1200 字符 -> MEMORY_SEED_MAX_TOKENS(默认 50K+)
      if (hits.length) {
        // 2026-09-11 P0 记忆->使用闭环: 原写 "ids=a,b,c"(非 JSON), submit 侧 JSON.parse 必然失败,
        //   该路径注入的产物永远不计入使用。改为与 claim 路径一致的 JSON 形态(buildInjectedTitle)。
        await prisma.flywheelEvent.create({ data: { stage: "CONTEXT_INJECTED", sourceType: "claim-by-id", sourceId: taskId, sourceTitle: buildInjectedTitle({ agentId, source: "claim-by-id", count: hits.length, kinds: Array.from(new Set(hits.map((h) => h.kind))), ids: hits.map((h) => h.id) }), targetStage: "OK" } });
      }
    } catch { /* 上下文注入失败不影响认领 */ }
    return Response.json({ ok: true, task, contextSeed });
  } catch (e: any) {
    return Response.json({ ok: false, error: (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  }
}
