import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// 2026-10-23 R2-b: 归属过滤
import { readableWhere } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";

// GET /api/v1/memory/best?theme=xxx - 获取某主题的权威结构化记忆 (agent 用)
// 返回 importance 最高 + 最新的 1 条活跃 Memory
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const theme = url.searchParams.get("theme");

  if (!theme) {
    return NextResponse.json({ error: "theme parameter required" }, { status: 400 });
  }

  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const scope = readableWhere(who.actor, { kind: "memory" });
  const inScope = Object.keys(scope).length ? { AND: [scope] } : {};

  const best = await prisma.memory.findFirst({
    where: { theme, supersededBy: null, ...inScope },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true, content: true, summary: true, theme: true,
      tier: true, importance: true, qualityScore: true,
      sourceType: true, createdAt: true, updatedAt: true,
    },
  });

  if (!best) {
    return NextResponse.json({ error: "no active memory found for theme", theme }, { status: 404 });
  }

  // 尝试解析结构化内容
  let structured = null;
  try {
    const parsed = JSON.parse(best.content);
    if (parsed && typeof parsed === "object" && (parsed.summary || parsed.claim)) {
      structured = parsed;
    }
  } catch { /* legacy free text */ }

  // 同主题的其他活跃记忆 (概要)
  const siblings = await prisma.memory.findMany({
    where: { theme, supersededBy: null, id: { not: best.id }, ...inScope },
    orderBy: { importance: "desc" },
    take: 5,
    select: { id: true, summary: true, importance: true, updatedAt: true },
  });

  // 2026-09-28 立规 (north-star-b-path-2026-09-28.md Phase 1): 端口读计入 —
  //   返回前批量 +1 accessCount + lastAccessed。同 /search 处理。
  const idsToBump = [best?.id, structured?.id, ...(siblings || []).map((s) => s.id)].filter(Boolean);
  if (idsToBump.length > 0) {
    prisma.memory.updateMany({
      where: { id: { in: idsToBump } },
      data: { accessCount: { increment: 1 }, lastAccessed: new Date() },
    }).catch((e) => console.warn("[memory/best] accessCount+1 失败(非致命): " + String(e?.message || "").slice(0, 100)));
  }

  return NextResponse.json({
    best,
    structured,
    siblings,
    theme,
    activeCount: await prisma.memory.count({ where: { theme, supersededBy: null, ...inScope } }),
  });
}
