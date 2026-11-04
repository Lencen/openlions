/**
 * GET /api/v1/flywheel/structured/cron — 整点批量跑未结构化主题
 * V1.7 §4.3 API
 *
 * 建议 cron: "25 * * * *" (在反思 "5 * * * *" + 改进 "15 * * * *" 之后)
 */
import { runStructuredCron } from "@/server/pipeline/structured-cron";
import { withCronTimeout } from "@/server/pipeline/cron-with-timeout";

export async function GET(req: Request) {
  // V1.8 Feature flag
  if (process.env.FLYWHEEL_V17_ENABLED === "false") {
    return Response.json({ skipped: true, reason: "FLYWHEEL_V17_ENABLED=false" });
  }
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "5", 10), 20);
  // P0-3: 90s server-side timeout (防止 LLM 卡死拖垮 cron)
  return withCronTimeout(
    async (signal) => runStructuredCron({ limit, signal }),
    { timeoutMs: 90_000, label: "structured-cron" },
  );
}
