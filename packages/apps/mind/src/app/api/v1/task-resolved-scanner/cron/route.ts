import { NextResponse } from "next/server";
import { runTaskResolvedScanner } from "@/server/pipeline/task-resolved-scanner";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/task-resolved-scanner/cron
 * P5 修洞 2 (B3): 定时扫 status=DONE task, 路由到 4 类 (MEMORY/KNOWLEDGE/SKILL/PRACTICE) 回填
 * 频率建议: 1h (task 完成频率不高)
 *
 * 路由规则 (§15.2.3):
 *   1. task.theme (targetType 编码) 优先
 *   2. 无则按 description [tags:...] 推
 *      - 含 skill/能力/tool  → SKILL
 *      - 含 knowledge/知识   → KNOWLEDGE
 *      - 含 practice/实践   → PRACTICE
 *      - 默认                → MEMORY
 *
 * 防重复: task.description 加 [task:<id>] 标记
 *
 * 真验 (§15.2.3): 4 类都有新增条目 (历史只回填 memory)
 */
export async function GET() {
  try {
    const result = await runTaskResolvedScanner({ limit: 50 });
    return NextResponse.json({
      ok: true,
      scanned: result.scanned,
      routed: result.routed,
      skipped: result.skipped,
      tasks: result.tasks,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}