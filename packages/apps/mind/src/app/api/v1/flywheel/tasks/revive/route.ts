import { NextRequest, NextResponse } from "next/server";
import { auditUnclaimable, reviveTasks } from "@/server/pipeline/task-revive";
import { CLAIMABLE_IMPROVEMENT_TYPES } from "@/server/pipeline/agent-capability";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/flywheel/tasks/revive — 任务复活的**平台侧单一入口** (2026-09-17)
 *
 * 为什么上移到平台(待办 todo_d563d97665df49428c45):
 *   原先"复活"散落在各脚本里各写各的 UPDATE, 没有规范/没有后置校验。实测两次事故:
 *   ① 隔离件复活只改 status/retryCount, 漏清 manualReview(=1) -> 15 条复活件对**所有人**不可领,
 *      认领接口静默返回 task:null, 表现为"没有产能";
 *   ② improvementType='VERIFY' 不在认领白名单 -> 该任务同样对所有人都领不到。
 *   现在归一化 + 闸门断言 + 留痕 + 幂等都在服务端, 客户端脚本只调用本端点。
 *
 * Body: { taskIds?: string[] | id?: string, reason?: string, actor?: string, keepOwner?: boolean, dryRun?: boolean }
 *   归一化: status=PENDING, retryCount=0, manualReview=false(NOT NULL!), expectedOwner=NULL,
 *           leaseExpiresAt=NULL, assignedAgent=NULL(keepOwner=true 时保留原归属)
 *   闸门断言: 复活后必须"对某个健康 agent 可领"; 不满足 -> 422 + missing 明细(整批不变更)
 *   留痕: TaskStateTransition(from->PENDING) + FlywheelEvent(stage=TASK_REVIVED)
 *   幂等: 已在规范态 -> skipped(ALREADY_REVIVED), 不重复写事件
 *
 * 返回:
 *   200 { ok:true, revived:[{id,from,transitionId,flywheelEventId}], skipped:[...], audit:{count,items} }
 *   422 { ok:false, error:"REVIVE_GATE_FAILED", missing:[{id,missing:[...]}], claimableImprovementTypes:[...] }
 *   400 { ok:false, error:"MISSING_TASK_IDS"|"INVALID_JSON" }
 *   409 { ok:false, error:"REVIVE_CAS_LOST" }  读候选与写复活之间任务被并发改动(version CAS 未命中)
 *
 * GET /api/v1/flywheel/tasks/revive — 全库体检(auditUnclaimable) + 白名单来源说明。
 */
export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }
  const rawIds = Array.isArray(body.taskIds) ? body.taskIds : body.id ? [body.id] : [];
  const ids = rawIds.map((x: any) => String(x || "").trim()).filter(Boolean);
  if (!ids.length) {
    return NextResponse.json(
      { ok: false, error: "MISSING_TASK_IDS", detail: "body 需提供 taskIds:[...] 或 id:\"...\"" },
      { status: 400 },
    );
  }
  try {
    const { status, body: res } = await reviveTasks({
      ids,
      actor: body.actor,
      reason: body.reason,
      keepOwner: body.keepOwner === true,
      dryRun: body.dryRun === true,
    });
    return NextResponse.json(res, { status });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "REVIVE_FAILED", message: String(e?.message || e).slice(0, 300) },
      { status: 500 },
    );
  }
}

export async function GET() {
  const audit = await auditUnclaimable();
  return NextResponse.json({
    ok: true,
    unclaimable: audit.count,
    items: audit.items,
    claimableImprovementTypes: CLAIMABLE_IMPROVEMENT_TYPES,
    whitelistSource: "packages/apps/mind/src/server/pipeline/claimable-task-types.json",
  });
}
