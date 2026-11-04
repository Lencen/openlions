// memory-retrieval.ts — 记忆检索排序（B3 + 2026-10-26 A2）。
// 约束（人类）：用户自带模型 key，向量化花用户的钱 ⇒ **必须"没有向量也能工作"**（词面 + 主题保底）。
// 有向量时叠加余弦相似度；无向量时退化为词面/标题/主题 + 结构化信号（质量/使用/新鲜度）。
//
// 2026-10-26 A2 改动：
//   1) 中文查询按 2 字滑窗切分（原来只按空格切，中文整句被当成一个 token，只能整句匹配）；
//   2) 命中率按 n-gram 计算（部分命中也有分），而不是"整 token 命中/不命中"；
//   3) 无向量时的排序加入结构化信号：qualityScore 0.25 / usage 0.20（分位归一）/ freshness 0.10；
//   4) 权重外置（RankOpts.weights），便于后续调参与 A/B。
export interface RetrievalDoc {
  id: string;
  content?: string | null; summary?: string | null; title?: string | null;
  tags?: string | null; theme?: string | null; importance?: number | null;
  qualityScore?: number | null; usageCount?: number | null; updatedAt?: Date | string | null;
  vector?: number[] | null;
}

const CJK = /[\u4e00-\u9fff]/;

/** 词面 token：英文按空白/标点切；中文按 2 字滑窗（并保留整段中文）。 */
export function tokenize(q: string): string[] {
  const raw = String(q || "").toLowerCase().trim();
  if (!raw) return [];
  const out: string[] = [];
  for (const seg of raw.split(/[\s,，。;；、/|]+/).filter(Boolean)) {
    if (CJK.test(seg)) {
      const chars = Array.from(seg);
      if (chars.length <= 2) { out.push(seg); continue; }
      for (let i = 0; i + 2 <= chars.length; i++) out.push(chars.slice(i, i + 2).join(""));
      out.push(seg);
    } else {
      out.push(seg);
    }
  }
  return [...new Set(out)].slice(0, 24);
}

export function lexicalScore(q: string, d: RetrievalDoc): number {
  const toks = tokenize(q);
  if (!toks.length) return 0;
  const hay = [d.title, d.summary, d.content, d.tags, d.theme].filter(Boolean).join(" ").toLowerCase();
  const titleHay = String(d.title || "").toLowerCase();
  const themeHay = String(d.theme || "").toLowerCase();
  let hit = 0, titleHit = 0, themeHit = 0;
  for (const t of toks) {
    if (hay.indexOf(t) >= 0) hit++;
    if (titleHay && titleHay.indexOf(t) >= 0) titleHit++;
    if (themeHay && themeHay.indexOf(t) >= 0) themeHit++;
  }
  const base = hit / toks.length;
  const tRatio = titleHit / toks.length;
  const thRatio = themeHit / toks.length;
  let score = base * 0.6 + tRatio * 0.25 + thRatio * 0.15;
  // 2026-10-26 A2 v4: 整句命中必须显著高于 n-gram 部分命中。
  //   实测教训：只按 n-gram 排序时 top-1 含整句的比例从 6/6 掉到 1/6（候选都共享两个字，把只沾边的顶上来）。
  const qLower = String(q || "").toLowerCase().trim();
  if (qLower && titleHay && titleHay.indexOf(qLower) >= 0) score = Math.max(score, 0.98);
  else if (qLower && hay.indexOf(qLower) >= 0) score = Math.max(score, 0.85);
  return +score.toFixed(4);
}

export function cosine(a?: number[] | null, b?: number[] | null): number | null {
  if (!a || !b || !a.length || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 结构化信号权重（无向量时的默认值；外置便于调参） */
export const LEXICAL_WEIGHTS = {
  lexical: 0.45,
  quality: 0.25,
  usage: 0.20,
  freshness: 0.10,
} as const;

export interface RankOpts {
  queryVector?: number[] | null;
  weightVector?: number;
  weights?: Partial<typeof LEXICAL_WEIGHTS>;
  usageMax?: number;
  now?: number;
}

function freshnessScore(updatedAt: Date | string | null | undefined, now: number): number {
  if (!updatedAt) return 0.3;
  const t = typeof updatedAt === "string" ? Date.parse(updatedAt) : updatedAt.getTime();
  if (!Number.isFinite(t)) return 0.3;
  const ageDays = Math.max(0, (now - t) / 86400000);
  return +Math.exp(-ageDays / 30).toFixed(4);
}

export function rankDocs(q: string, docs: RetrievalDoc[], opts: RankOpts = {}) {
  const w = { ...LEXICAL_WEIGHTS, ...(opts.weights || {}) };
  const wv = opts.weightVector ?? 0.5;
  const now = opts.now ?? Date.now();
  const usageMax = opts.usageMax ?? Math.max(1, ...docs.map((d) => Number(d.usageCount ?? 0)));
  return docs.map((d) => {
    const lex = lexicalScore(q, d);
    const v = cosine(opts.queryVector, d.vector);
    const qual = Math.max(0, Math.min(1, Number(d.qualityScore ?? 0)));
    const usage = Math.max(0, Math.min(1, Number(d.usageCount ?? 0) / usageMax));
    const fresh = freshnessScore(d.updatedAt, now);
    const lexPart = w.lexical * lex;
    const structPart = w.quality * qual + w.usage * usage + w.freshness * fresh;
    const score = v == null
      ? +(lexPart + structPart).toFixed(4)
      : +((1 - wv) * (lexPart + structPart) + wv * v).toFixed(4);
    return Object.assign({}, d, { score, vectorScore: v, explain: { lexical: lex, quality: qual, usage, freshness: fresh } });
  }).sort((a, b) => b.score - a.score);
}
