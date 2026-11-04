import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// 2026-10-23 R2-b: 裸 SQL 聚合同样按归属过滤（scopeSqlFragment 与 readableWhere 同源）
import { scopeSqlFragment } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";

// GET /api/v1/memory/themes - 主题列表 + 质量统计 (agent 用)
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const activeOnly = url.searchParams.get("activeOnly") !== "false";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);

  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const scopeFrag = scopeSqlFragment(who.actor, "memory");
  const conds = [activeOnly ? "supersededBy IS NULL" : "", scopeFrag].filter(Boolean);
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      COALESCE(theme, '(未分类)') as theme,
      COUNT(*) as totalCount,
      SUM(CASE WHEN supersededBy IS NULL THEN 1 ELSE 0 END) as activeCount,
      SUM(CASE WHEN supersededBy IS NOT NULL THEN 1 ELSE 0 END) as supersededCount,
      AVG(CASE WHEN supersededBy IS NULL THEN importance ELSE NULL END) as avgImportance,
      MAX(CASE WHEN supersededBy IS NULL THEN updatedAt ELSE NULL END) as latestUpdate
    FROM Memory
    ${where}
    GROUP BY COALESCE(theme, '(未分类)')
    ORDER BY activeCount DESC
    LIMIT ${limit}
  `);

  const themes = (rows as any[]).map(r => ({
      theme: String(r.theme),
      totalCount: Number(r.totalCount),
      activeCount: Number(r.activeCount),
      supersededCount: Number(r.supersededCount),
      avgImportance: r.avgImportance ? Number(r.avgImportance) : null,
      latestUpdate: r.latestUpdate ? String(r.latestUpdate) : null,
    }));

  return NextResponse.json({
    total: themes.length,
    themes,
  });
}
