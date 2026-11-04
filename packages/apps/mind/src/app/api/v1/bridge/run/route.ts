import { NextRequest, NextResponse } from "next/server";
import { runReflectionToTaskBridge } from "@/server/pipeline/reflection-to-task-bridge";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/bridge/run
 *
 * 飞轮洞1: Reflection -> Task bridge
 * 扫 OPEN 状态 Reflection, 按条件创建 Task
 *
 * Body:
 *   { dryRun?: boolean, limit?: number }
 *
 * Returns:
 *   { scanned, triggered, skipped, tasks: [{taskId, reflectionId, reason}] }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun ?? false;
    const limit = body.limit ?? 100;

    const result = await runReflectionToTaskBridge({ dryRun, limit });

    return NextResponse.json({
      status: "OK",
      dryRun,
      ...result,
    });
  } catch (err) {
    console.error("[bridge/run] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** GET: dry-run 预览, 不写库 */
export async function GET() {
  try {
    const result = await runReflectionToTaskBridge({ dryRun: true, limit: 50 });
    return NextResponse.json({
      status: "OK",
      dryRun: true,
      ...result,
    });
  } catch (err) {
    console.error("[bridge/run GET] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
