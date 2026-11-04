/**
 * GET /api/v1/flywheel/reflections/[theme] — 单主题/日结反思详情 (2026-09-09 P3)
 * 返回: 反思本体(含 summary/triggerReason/sourceStats/coverageDelta/findings) + 派生任务回显
 */
import { prisma } from "@/lib/prisma";
import { parseStructuredFindings } from "@/server/pipeline/findings-parse";

function safeParse<T>(s: string | null, fallback: T): T {
  try { return JSON.parse(s || "") as T; }
  catch { return fallback; }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ theme: string }> }
) {
  const { theme } = await params;
  if (!theme) return Response.json({ error: "theme is required" }, { status: 400 });
  const decodedTheme = decodeURIComponent(theme);
  try {
    const item: any = await prisma.flywheelReflection.findUnique({ where: { theme: decodedTheme } });
    if (!item) return Response.json({ error: "not found", theme: decodedTheme }, { status: 404 });
    // 派生任务回显 (任务管理单点写, 此处只读 JOIN; DAILY 行无派生任务)
    let derivedTasks: any[] = [];
    try {
      derivedTasks = await prisma.task.findMany({
        where: { sourceReflectionIds: { contains: item.id }, improvementType: { not: null } },
        select: { id: true, title: true, status: true, priority: true, theme: true, improvementType: true, updatedAt: true, completedBy: true },
        orderBy: { updatedAt: "desc" as const },
        take: 30,
      });
    } catch (e: any) {
      console.warn(`[reflection detail] derivedTasks fail (非致命): ${(e?.message || "").slice(0, 80)}`);
    }
    return Response.json({
      id: item.id, theme: item.theme,
      missedTopics: safeParse(item.missedTopics, []),
      improvements: safeParse(item.improvements, []),
      coverageScore: item.coverageScore,
      conflicts: safeParse(item.conflicts, []),
      productCounts: safeParse(item.productCounts, {}),
      status: item.status, attempts: item.attempts,
      reportedMemoryIds: safeParse(item.reportedMemoryIds, []),
      lastErrors: item.lastErrors,
      summary: item.summary || "",
      triggerReason: safeParse(item.triggerReason, null),
      sourceStats: safeParse(item.sourceStats, null),
      coverageDelta: item.coverageDelta ?? null,
      reflectionGranularity: item.reflectionGranularity || "theme",
      findings: parseStructuredFindings(item.structuredFindings),
      dayStats: safeParse(item.dayStats, null),
      createdAt: item.createdAt, updatedAt: item.updatedAt,
      derivedTasks,
    });
  } catch (e: any) {
    console.error("[reflections detail]", e);
    return Response.json({ error: (e && e.message) || String(e) }, { status: 500 });
  }
}
