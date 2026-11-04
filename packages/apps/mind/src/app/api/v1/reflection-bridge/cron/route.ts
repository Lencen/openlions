import { NextResponse } from "next/server";
import { runReflectionToTaskBridge } from "@/server/pipeline/reflection-to-task-bridge";
import { withCronTimeout } from "@/server/pipeline/cron-with-timeout";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/reflection-bridge/cron
 * P5 修洞 1 (B2): 定时触发 reflection→task bridge
 * 频率建议: 30min (跟 §15.2.2 设计对齐)
 *
 * 行为:
 *   - 扫 status=OPEN reflection
 *   - P0/P1 priority 或 improvements 含 gap/未解/未覆盖 或 actionType=CREATE_TASK
 *   - 满足条件 → 自动建 Task (status=PENDING, sourceReflectionIds 标记)
 *   - 防重复: Task.sourceReflectionIds 已存在则跳过
 *   - FlywheelEvent stage=REFLECTION_TO_TASK 留痕
 */
export async function GET(req: Request) {
  // ===== 2026-09-10 退役 (反思节奏对齐修正) =====
  // BRIDGE 是 V1 遗留通道: 扫【旧 Reflection 表】(status=OPEN, 仍剩 13,641 条) -> 每条按目标类型建 task
  //   -> improving-tasks cron 执行时把该反思的一句话结论回填成 1 行产物(无证据/无 findingId/无质量保证)。
  // 现行反思节奏 = 主题反思 */4h + 每日 00:00 日结, 产物为 FlywheelReflection -> generateImprovingTasks
  //   (THEME_IMPROVE, 带证据/findingId/质量分)。旧通道不同源不同频, 每小时仍在新建 ~100 个低价值任务。
  // 处置: 默认停止新建(存量 PENDING 仍由 improving-tasks cron 消化); 临时重开 REFLECTION_BRIDGE_ENABLED=1。
  if (process.env.REFLECTION_BRIDGE_ENABLED !== "1") {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "reflection-bridge retired 2026-09-10: V1 遗留通道, 与现行反思节奏(主题 4h + 日结)不同步; 改进由 FlywheelReflection->THEME_IMPROVE 承担",
    });
  }
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
  return withCronTimeout(
    async (signal) => {
      const result = await runReflectionToTaskBridge({ limit, signal });
      return {
        ok: true,
        scanned: result.scanned,
        triggered: result.triggered,
        skipped: result.skipped,
        tasks: result.tasks,
        timestamp: new Date().toISOString(),
      };
    },
    { timeoutMs: 90_000, label: "reflection-bridge-cron" },
  );
}