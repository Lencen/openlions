import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rankDocs, tokenize } from "@/server/pipeline/memory-retrieval";
import { recordContextQueried, resolveAgentId } from "@/server/lib/context-queried-event";
// 2026-10-23 R2-b: 检索结果按归属过滤（agent 侧最常用的旁路入口）
import { readableWhere } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";

// POST /api/v1/memory/search - 语义搜索 (agent 用)
// Body: { query, theme?, minImportance?, limit?, rank?, queryVector? }
//
// 2026-10-26 A2/A2b：
//   排序 = 0.45 词面(n-gram + 整句强下限) + 0.25 质量 + 0.20 使用(accessCount) + 0.10 新鲜度；
//   粗筛 = 先整句候选，不足 5 条再补 token 候选（两次查询都只查一次主表，不做额外的 count）。
const SELECT_FIELDS = {
  id: true, content: true, summary: true, theme: true,
  importance: true, qualityScore: true, accessCount: true,
  sourceType: true, updatedAt: true,
} as const;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { query, theme, minImportance = 0, limit = 20 } = body;

  if (!query) {
    return NextResponse.json({ error: "query required" }, { status: 400 });
  }

  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const tokens = tokenize(query).slice(0, 4); // 4 个 2 字滑窗 × 5 字段 = 20 个谓词，避免谓词爆炸
  const scope = readableWhere(who.actor, { kind: "memory" });
  const baseWhere: any = { supersededBy: null };
  if (theme) baseWhere.theme = theme;
  if (minImportance > 0) baseWhere.importance = { gte: minImportance };
  // 2026-10-23 R2-b: 归属过滤与关键词 OR 用 AND 组合
  if (Object.keys(scope).length) baseWhere.AND = [scope];

  const CANDIDATES = Math.min(Math.max(limit * 5, 50), 200);
  const phraseWhere: any = { ...baseWhere, OR: [
    { content: { contains: query } }, { summary: { contains: query } },
    { title: { contains: query } }, { tags: { contains: query } }, { theme: { contains: query } },
  ] };

  let items: any[] = await prisma.memory.findMany({
    where: phraseWhere, orderBy: [{ updatedAt: "desc" }], take: CANDIDATES, select: SELECT_FIELDS as any,
  });
  const phraseFirst = items.length >= Math.min(limit, 5);
  if (!phraseFirst) {
    const coarseOr = (tokens.length ? tokens : [query]).flatMap((t) => ([
      { content: { contains: t } }, { summary: { contains: t } },
      { title: { contains: t } }, { tags: { contains: t } }, { theme: { contains: t } },
    ]));
    const more: any[] = await prisma.memory.findMany({
      where: { ...baseWhere, OR: coarseOr }, orderBy: [{ updatedAt: "desc" }], take: CANDIDATES, select: SELECT_FIELDS as any,
    });
    const seen = new Set(items.map((x) => x.id));
    items = [...items, ...more.filter((x) => !seen.has(x.id))].slice(0, CANDIDATES);
  }

  // 默认按相关性排序（无向量也能用；带 vector 则叠加余弦）；rank=false 退回按更新时间（兼容旧调用方）。
  const useRank = body.rank !== false;
  // Memory 没有 usageCount 列：用 accessCount（每次检索 +1）作为"被使用"信号。
  const docsForRank = items.map((m) => ({ ...m, usageCount: m.accessCount ?? 0 }));
  const ranked = useRank ? rankDocs(query, docsForRank as any, { queryVector: body.queryVector || null }) : items;
  const results: any[] = (ranked as any[]).slice(0, Math.min(limit, 50));

  // 2026-09-28 立规: 端口读计入 —— 只对最终返回的结果 +1（旧实现是对候选集全部 +1，语义偏宽）。
  if (results.length > 0) {
    prisma.memory.updateMany({
      where: { id: { in: results.map((x) => x.id).filter(Boolean) } },
      data: { accessCount: { increment: 1 }, lastAccessed: new Date() },
    }).catch((e) => console.warn("[memory/search] accessCount+1 失败(非致命): " + String(e?.message || "").slice(0, 100)));
  }

  // 2026-10-20 需求单: 检索入口写一条 CONTEXT_QUERIED（去噪 + fire-and-forget，不改检索语义）。
  recordContextQueried({
    agentId: resolveAgentId(req, body),
    query,
    targetType: "MEMORY",
    hits: results.length,
    firstHitId: results[0]?.id ?? null,
  });

  return NextResponse.json({
    query,
    results,
    total: items.length,
    count: results.length,
    strategy: useRank ? "lexical" : "recency",
  });
}