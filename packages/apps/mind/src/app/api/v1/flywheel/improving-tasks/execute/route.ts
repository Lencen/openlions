/**
 * POST /api/v1/flywheel/improving-tasks/execute — 单条 ImprovingTask 执行
 * V1.6 §3.1 API
 *
 * Body: { taskId: string, dryRun?: boolean, actor?: string }
 *
 * 注意: dryRun=true 时不真改数据, 只返回预览
 * dryRun=false 时按 Task.improvementType 走对应执行器 (FIX_THEME/FIX_CONFLICT/MIGRATE_DATA/RE_RUN)
 */
import { executeImprovingTask } from "@/server/pipeline/execute-improving-task";
import { requireFeature } from "@/lib/license";

export async function POST(req: Request) {
  let body: { taskId?: string; dryRun?: boolean; actor?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (!body.taskId) {
    return Response.json({ error: "MISSING_TASK_ID" }, { status: 400 });
  }

  // 2026-10-27 S2 授权门: flywheel.improve（自动改进属 Pro 收费点）。
  //   未授权 → 402 LICENSE_REQUIRED；开发模式放行但告警（requireFeature 内部处理）。
  //   dryRun 也拦：预览同样暴露改进能力，且避免"先预览再执行"绕过。
  {
    const gate = requireFeature("flywheel.improve");
    if (!gate.ok) return Response.json(gate.body, { status: gate.status });
  }

  try {
    const result = await executeImprovingTask({
      taskId: body.taskId,
      dryRun: body.dryRun || false,
      actor: body.actor || "api:v16:execute",
    });
    // 2026-10-27（平台数据线）: 执行前的**授权二次校验**失败必须在 **HTTP 状态码**上体现。
    //   原来返回 200 + result.error=LICENSE_REQUIRED —— 只看 status 的调用方会当成"执行成功"。
    //   契约：授权相关失败一律 402；其它失败仍 200 + result.error（保持既有调用方兼容）。
    const rerr = String((result as any)?.error || "");
    if (rerr === "LICENSE_REQUIRED" || rerr === "LICENSE_CHECK_UNAVAILABLE") {
      return Response.json({
        error: rerr === "LICENSE_REQUIRED" ? "LICENSE_REQUIRED" : "LICENSE_CHECK_UNAVAILABLE",
        feature: "flywheel.improve",
        reason: String((result as any)?.summary || "").slice(0, 240),
        phase: "pre-execute-recheck",
        license: "invalid-or-unavailable",
      }, { status: 402 });
    }
    return Response.json({ ok: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: "EXECUTE_FAILED", message }, { status: 500 });
  }
}
