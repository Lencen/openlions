/**
 * POST /api/v1/flywheel/reflections/trigger — 手动触发反思
 * V1.5 §2.4 API 3
 *
 * Body: { "theme": "飞轮引擎", "async": false }
 * async=true → fire-and-forget, 立即返回 { jobId: ... }
 * async=false → 等反思完成返回 result
 */
import { NextRequest } from "next/server";
import { reflectWorker } from "@/server/pipeline/reflect";

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // body 可能为空
  }
  const theme: string | undefined = body.theme;
  const isAsync: boolean = body.async === true;
  // 2026-09-10 人类干预埋点: 手动触发(非 cron)计一次人工介入
  const isManual: boolean = body.manual === true || String(req.nextUrl?.searchParams?.get("manual") || "") === "1";
  if (isManual) {
    try {
      const { prisma: p } = await import("@/lib/prisma");
      await p.flywheelEvent.create({ data: { stage: "HUMAN_INTERVENTION", sourceType: "manual_trigger", sourceId: theme || "", sourceTitle: "手动触发反思: " + (theme || ""), targetStage: "OK" } });
    } catch { /* 埋点失败不影响主流程 */ }
  }

  if (!theme || typeof theme !== "string" || theme.trim().length === 0) {
    return Response.json({ error: "theme is required and must be a non-empty string" }, { status: 400 });
  }

  if (isAsync) {
    // 异步执行，立即返回
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    reflectWorker(theme.trim(), { trigger: "manual" }).catch(e => {
      console.error(`[trigger async] theme="${theme}" jobId=${jobId} failed: ${e.message}`);
    });
    return Response.json({
      jobId,
      theme: theme.trim(),
      status: "PENDING",
      message: "Reflection started in background. Check /api/v1/flywheel/reflections/[theme] for result.",
    });
  }

  // 同步执行
  try {
    const result = await reflectWorker(theme.trim(), { trigger: "manual" });
    return Response.json(result);
  } catch (e: any) {
    console.error(`[trigger sync] theme="${theme}" failed: ${e.message}`);
    return Response.json({ error: e.message, theme }, { status: 500 });
  }
}
