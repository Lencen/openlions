/**
 * GET /api/v1/flywheel/improving-tasks/cron — 整点批量执行 PENDING ImprovingTask
 * V1.6 §3.1 API
 *
 * 建议调用频率: 每小时第 15 分钟 (cron: "15 * * * *", 在反思 cron 之后)
 * 反思 cron: "5 * * * *" → 写 FlywheelReflection + 自动 generate ImprovingTask
 * 改进 cron: "15 * * * *" → 批量执行 PENDING ImprovingTask
 */
import { runImprovingTasksCron } from "@/server/pipeline/improving-tasks-cron";
import { withCronTimeout } from "@/server/pipeline/cron-with-timeout";

export async function GET(req: Request) {
  // V1.8 Feature flag
  if (process.env.FLYWHEEL_V16_ENABLED === "false") {
    return Response.json({ skipped: true, reason: "FLYWHEEL_V16_ENABLED=false" });
  }
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 500); // 2026-09-08: BRIDGE 纯回填毫秒级, cap 100->500 加速消化积压
  const type = (url.searchParams.get("type") || "").replace(/[^A-Z_]/g, ""); // 2026-09-09: ?type=THEME_IMPROVE 单独消化该类

  // P0-3: 90s server-side timeout (防止 RE_EXTRACT 触发的 LLM 合成拖垮 HTTP 路由)
  return withCronTimeout(
    async (signal) => {
      const t0 = Date.now();
      try {
        const result = await runImprovingTasksCron({
          limit,
          actor: "cron:v16:improving-tasks",
          type: type || undefined,
          signal,
        });
        return { ok: true, ...result, duration: Date.now() - t0 };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: "CRON_FAILED", message, duration: Date.now() - t0 };
      }
    },
    { timeoutMs: 90_000, label: "improving-tasks-cron" },
  );
}
