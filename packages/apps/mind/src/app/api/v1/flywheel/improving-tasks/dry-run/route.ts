/**
 * POST /api/v1/flywheel/improving-tasks/dry-run — 单条 ImprovingTask 预览
 * V1.6 §3.1 API (管理后台 "预览" 按钮)
 *
 * Body: { taskId: string }
 * 等价 execute 但 dryRun=true 强制开启
 */
import { executeImprovingTask } from "@/server/pipeline/execute-improving-task";

export async function POST(req: Request) {
  let body: { taskId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }

  if (!body.taskId) {
    return Response.json({ error: "MISSING_TASK_ID" }, { status: 400 });
  }

  try {
    const result = await executeImprovingTask({
      taskId: body.taskId,
      dryRun: true,
      actor: "api:v16:dry-run",
    });
    return Response.json({ ok: true, dryRun: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: "DRY_RUN_FAILED", message }, { status: 500 });
  }
}
