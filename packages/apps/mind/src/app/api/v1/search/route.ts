import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rankDocs, tokenize } from "@/server/pipeline/memory-retrieval";
// 2026-10-23 R2-b: 检索入口同样按归属过滤（先过滤、再排序）
import { readableWhere } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";

// POST /api/v1/search —— 统一检索入口（Memory / Knowledge / Skill）
// 2026-10-26 A3：把三类资产的检索收敛到一个入口，返回统一结构（kind/score/explain/snippet）。
//
// 设计要点：
//   1) 先按归属过滤（readableWhere）再排序——scope 绝不进相似度表达式；
//   2) 排序复用 memory-retrieval 的 rankDocs（无向量：0.45 词面 + 0.25 质量 + 0.20 使用 + 0.10 新鲜度）；
//   3) sortStrategy 预留 lexical | hybrid；当前无 embedding 服务，hybrid 自动退化为 lexical 并在响应里注明。

type Kind = "memory" | "knowledge" | "skill";
const KINDS: Kind[] = ["memory", "knowledge", "skill"];

const KIND_DEF: Record<Kind, { model: string; scopeKind: any; usage: string; text: string[]; title: string; hasStale: boolean }> = {
  memory: { model: "memory", scopeKind: "memory", usage: "accessCount", text: ["title", "summary", "content", "tags", "theme"], title: "title", hasStale: false },
  knowledge: { model: "knowledge", scopeKind: "knowledge", usage: "usageCount", text: ["title", "content", "tags", "theme"], title: "title", hasStale: true },
  skill: { model: "skill", scopeKind: "skill", usage: "totalUsageCount", text: ["name", "businessName", "description", "trigger", "content"], title: "name", hasStale: true },
};

function pick(kind: Kind, row: any) {
  const def = KIND_DEF[kind];
  return {
    kind,
    id: row.id,
    title: row[def.title] ?? row.name ?? row.title ?? "",
    snippet: String(row.content ?? row.summary ?? row.description ?? "").slice(0, 200),
    theme: row.theme ?? null,
    qualityScore: row.qualityScore ?? 0,
    usageCount: row[def.usage] ?? 0,
    updatedAt: row.updatedAt ?? null,
    content: row.content ?? "",
    summary: row.summary ?? "",
    tags: row.tags ?? "",
    description: row.description ?? "",
  };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const query = String(body.query ?? "").trim();
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });

  const requested: Kind[] = Array.isArray(body.kinds) && body.kinds.length
    ? KINDS.filter((k) => body.kinds.includes(k))
    : KINDS;
  const limit = Math.min(Math.max(Number(body.limit ?? 10), 1), 50);
  const perKind = Math.min(limit * 3, 30);
  const tokens = tokenize(query).slice(0, 4);
  const sortStrategy = body.sortStrategy === "hybrid" ? "hybrid" : "lexical";

  const collected: any[] = [];
  for (const kind of requested) {
    const def = KIND_DEF[kind];
    const scope = readableWhere(who.actor, { kind: def.scopeKind });
    const base: any = { supersededBy: null };
    if (def.hasStale) base.stale = false;
    if (Object.keys(scope).length) base.AND = [scope];

    const phraseOr = def.text.map((f) => ({ [f]: { contains: query } }));
    const model = (prisma as any)[def.model];
    let rows: any[] = await model.findMany({ where: { ...base, OR: phraseOr }, take: perKind, orderBy: [{ updatedAt: "desc" }] });
    if (rows.length < 3 && tokens.length) {
      const tokOr = def.text.flatMap((f) => tokens.map((t) => ({ [f]: { contains: t } })));
      const more = await model.findMany({ where: { ...base, OR: tokOr }, take: perKind, orderBy: [{ updatedAt: "desc" }] });
      const seen = new Set(rows.map((r: any) => r.id));
      rows = [...rows, ...more.filter((r: any) => !seen.has(r.id))].slice(0, perKind);
    }
    for (const r of rows) collected.push(pick(kind, r));
  }

  // 无 embedding 服务：hybrid 退化为 lexical（明确回报，避免调用方误以为做了向量检索）
  const effective = sortStrategy === "hybrid" ? "lexical" : sortStrategy;
  const ranked = rankDocs(query, collected as any[], {}).slice(0, limit);

  return NextResponse.json({
    query,
    strategy: effective,
    ...(sortStrategy === "hybrid" ? { degradedFrom: "hybrid", degradedReason: "未配置 embedding 服务，hybrid 退化为 lexical" } : {}),
    total: collected.length,
    count: ranked.length,
    results: ranked.map((r: any) => ({
      kind: r.kind, id: r.id, title: r.title, snippet: r.snippet, theme: r.theme,
      score: r.score, explain: r.explain,
    })),
  });
}