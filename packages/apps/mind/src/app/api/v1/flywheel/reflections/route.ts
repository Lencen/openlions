/**
 * GET /api/v1/flywheel/reflections — 反思列表
 * V1.5 §2.4 API 1
 *
 * Query: ?limit=50&page=1&coverageBelow=0.8&status=OK
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseStructuredFindings } from "@/server/pipeline/findings-parse";
import { rangeFromRequest } from "@/lib/range";

// ★ P2 fix: 安全 JSON.parse, 单条损坏数据不导致整个 API 500
function safeParse<T>(s: string | null, fallback: T): T {
  try { return JSON.parse(s || "") as T; }
  catch { return fallback; }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = parseInt(sp.get("limit") || "50", 10);
  const page = parseInt(sp.get("page") || "1", 10);
  const status = sp.get("status");
  const coverageBelowStr = sp.get("coverageBelow");

  const where: any = {};
  if (status) where.status = status;
  if (coverageBelowStr) {
    const coverageBelow = parseFloat(coverageBelowStr);
    if (!isNaN(coverageBelow)) where.coverageScore = { lt: coverageBelow };
  }
  // 2026-10-13 round 76-CA: **opt-in** 时间窗(③) —— 只有显式传 ?range= 才按 createdAt 过滤。
  const rf = rangeFromRequest(req);
  if (rf && rf.since > 0) where.createdAt = { gte: new Date(rf.since) };

  try {
    const [items, total] = await Promise.all([
      prisma.flywheelReflection.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.flywheelReflection.count({ where }),
    ]);

    return Response.json({
      items: items.map(item => ({
        id: item.id,
        theme: item.theme,
        missedTopics: safeParse(item.missedTopics, []),
        improvements: safeParse(item.improvements, []),
        coverageScore: item.coverageScore,
        conflicts: safeParse(item.conflicts, []),
        productCounts: safeParse(item.productCounts, {}),
        status: item.status,
        attempts: item.attempts,
        reportedMemoryIds: safeParse(item.reportedMemoryIds, []),
        lastErrors: item.lastErrors,
        // ===== 2026-09-09 P3: 新列透传 =====
        summary: item.summary || "",
        triggerReason: safeParse(item.triggerReason, null),
        sourceStats: safeParse(item.sourceStats, null),
        coverageDelta: item.coverageDelta ?? null,
        reflectionGranularity: item.reflectionGranularity || "theme",
        findings: parseStructuredFindings(item.structuredFindings),
        dayStats: safeParse(item.dayStats, null),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      total,
      page,
      pageSize: limit,
      ...(rf ? { range: rf.key, rangeLabel: rf.label } : {}),
    });
  } catch (e: any) {
    console.error("[reflections GET]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
