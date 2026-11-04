import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// 2026-10-23 R2-b: REST 读路径接归属判据（agent 换 URL 不能绕过 tRPC 判据）
import { readableWhere } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";

// GET /api/v1/memory - 查询记忆 (agent 用)
// 参数: theme, minImportance, activeOnly, sourceType, page, pageSize, search
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const params = url.searchParams;

  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const where: any = {};
  if (params.get("activeOnly") !== "false") where.supersededBy = null;
  if (params.get("theme")) where.theme = params.get("theme");
  if (params.get("sourceType")) where.sourceType = params.get("sourceType");
  if (params.get("tier")) where.tier = params.get("tier");
  const minImp = parseFloat(params.get("minImportance") || "0");
  if (minImp > 0) where.importance = { gte: minImp };
  if (params.get("search")) {
    where.OR = [
      { content: { contains: params.get("search")! } },
      { summary: { contains: params.get("search")! } },
    ];
  }

  // 2026-10-23 R2-b: 归属过滤与 search 的 OR 用 AND 组合
  const scope = readableWhere(who.actor, { kind: "memory" });
  if (Object.keys(scope).length) where.AND = [...(where.AND ?? []), scope];

  const page = Math.max(1, parseInt(params.get("page") || "1"));
  const pageSize = Math.min(parseInt(params.get("pageSize") || "20"), 100);

  const [items, total] = await Promise.all([
    prisma.memory.findMany({
      where,
      orderBy: { importance: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, content: true, summary: true, theme: true, tier: true,
        sourceType: true, importance: true, qualityScore: true,
        supersededBy: true, createdAt: true, updatedAt: true,
        // 2026-10-23 R-contract: 归属字段增量暴露
        ownerAgentId: true, memoryScope: true,
      },
    }),
    prisma.memory.count({ where }),
  ]);

  // meta 为增量字段：前端据此区分「本来没有」与「被归属过滤」
  return NextResponse.json({
    items, total, page, pageSize,
    meta: { scope: Object.keys(scope).length ? "enforced" : "off", admin: String(who.actor?.role || "").toUpperCase() === "OWNER" || String(who.actor?.role || "").toUpperCase() === "ADMIN" },
  });
}
