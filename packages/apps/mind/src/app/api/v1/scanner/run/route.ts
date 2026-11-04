import { NextRequest, NextResponse } from "next/server";
import { runTaskResolvedScanner, markTaskDone } from "@/server/pipeline/task-resolved-scanner";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/scanner/run
 *
 * 飞轮洞2: Task resolved -> 4表回填
 * 扫 DONE 状态 Task, 按 targetType 路由到 Memory/Knowledge/Skill/Practice
 *
 * Body:
 *   { dryRun?: boolean, limit?: number }
 *   或 { markDone: "taskId" }  -- 把指定 task 标记为 DONE (测试用)
 *
 * Returns:
 *   { scanned, routed: {MEMORY,KNOWLEDGE,SKILL,PRACTICE}, skipped, tasks: [...] }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    // 子命令: markDone
    if (body.markDone) {
      await markTaskDone(body.markDone);
      return NextResponse.json({
        status: "OK",
        message: `task ${body.markDone} marked DONE`,
      });
    }

    const dryRun = body.dryRun ?? false;
    const limit = body.limit ?? 50;

    const result = await runTaskResolvedScanner({ dryRun, limit });

    return NextResponse.json({
      status: "OK",
      dryRun,
      ...result,
    });
  } catch (err) {
    console.error("[scanner/run] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** GET: dry-run 预览 */
export async function GET() {
  try {
    const result = await runTaskResolvedScanner({ dryRun: true, limit: 50 });
    return NextResponse.json({
      status: "OK",
      dryRun: true,
      ...result,
    });
  } catch (err) {
    console.error("[scanner/run GET] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
