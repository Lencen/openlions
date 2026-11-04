/**
 * memory-layers.ts — 记忆分层 + top-K 相关性召回 (2026-09-23, uos20 #1 记忆分层+检索)
 *
 * 背景(由待办 todo_uos20fb_1790047372338_1 升级任务 cmudlzwfg02nnoi31p6wgj3m6 驱动):
 *   uos20 P0 #1: 记忆库"全文注入"浪费且被 ~2K token 硬上限卡死(旧实现 renderContextSeed
 *   maxChars=1400 ≈ 2K token, macs_responder 再 seed[:1400] 硬截断) -> 平台记忆库 86K+
 *   条只有 2K token 能被模型用上, 召回/容量都不够。
 *   改法(本模块): 记忆库分**短期层(工作记忆 HOT/WARM)** 与 **长期层(沉淀归档 COLD)** 两层,
 *   按 query 做相关性评分 top-K 召回(每层各取 K 条), 注入容量上限 2K token -> 50K+ token
 *   (MEMORY_SEED_MAX_TOKENS, 默认 50000), 召回命中率不降(探针 scripts/probe-memory-layers.cjs 复算)。
 *
 * 分层口径(与既有 Knowledge 条目"记忆分层与自动遗忘算法"的 WORKING/EPISODIC/LONG_TERM 对齐,
 *   落在 DB tier 上的映射):
 *   - 短期层 SHORT_TERM: tier ∈ {HOT, WARM} 且未被取代(supersededBy IS NULL) —— 活跃工作记忆
 *   - 长期层 LONG_TERM : tier = COLD 且未被取代 —— 归档沉淀(28K+ 条, 容量主力)
 *   - 被取代(supersededBy 非空)的旧版本一律不参与召回(与 context-seed 既有活性口径一致)
 *
 * 纯查询层 + 纯函数评分, 不写库。供 context-seed.searchContext / claim 路由 / 探针复用。
 */
import { prisma } from "@/lib/prisma";

export const MEMORY_LAYER_SHORT = "SHORT_TERM";
export const MEMORY_LAYER_LONG = "LONG_TERM";
export type MemoryLayer = typeof MEMORY_LAYER_SHORT | typeof MEMORY_LAYER_LONG;

// ===== 容量(2K -> 50K+): 唯一事实来源, 注入方/探针都从这里取上限 =====
// 旧实现: renderContextSeed maxChars=1400 / macs_responder seed[:1400] (~2K token) —— 硬上限。
// 新实现: 上限由 MEMORY_SEED_MAX_TOKENS 决定, 默认 50000 token(≈ 50000 字符, 中英混排 1 字符≈1 token 的保守上界)。
export const MEMORY_SEED_MAX_TOKENS_DEFAULT = 50_000;
export const OLD_SEED_CAP_CHARS = 1400; // 旧硬上限, 探针作基线对比用

/** 注入容量上限(token): env MEMORY_SEED_MAX_TOKENS 覆盖, 默认 50K+ */
export function memorySeedMaxTokens(): number {
  const v = Number(process.env.MEMORY_SEED_MAX_TOKENS);
  return Number.isFinite(v) && v >= 1000 ? Math.floor(v) : MEMORY_SEED_MAX_TOKENS_DEFAULT;
}

/** token 预算 -> 字符预算(中英混排: 1 CJK 字符≈1 token 为保守上界, 故字符预算=token 预算) */
export function maxCharsForTokens(maxTokens: number): number {
  return Math.max(200, Math.floor(maxTokens));
}

/**
 * token 估算(与 scripts/probe-memory-layers.cjs 保持一致):
 *   CJK 字符按 1 token, ASCII 单词按每 4 词 1 token —— 保守上界(真实 tokenizer 对中文通常 ≤1 token/字)。
 */
export function estimateTokens(text: string): number {
  const s = String(text ?? "");
  const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const asciiWords = (s.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, " ").match(/[A-Za-z0-9_]+/g) || []).length;
  return cjk + Math.ceil(asciiWords / 4);
}

/** 查询词切分(与 context-seed 旧 terms 同口径: 空格/中英标点分隔, ≥2 字, 最多 8 词) */
export function terms(q: string): string[] {
  return String(q || "")
    .split(/[\s,，、;；|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 8);
}

/**
 * 查询分词(中文友好) —— 2026-10-09 round 72-J 新增。
 *
 * 为什么要它(实测): `terms()` 只按空格/标点切词, 而平台的任务标题几乎全是中文整句, 于是
 *   "任务状态查询端点返回404" 会变成**一个** token, `title LIKE %整句%` 永不命中 ->
 *   检索四个分支全空 -> 走"兜底: 最近的高质量产物" -> **注入内容与查询无关**, 每次还是同一批行。
 *   实测(30 条真实任务标题): 旧口径 15/30 有命中; 中文 2 字滑窗(bigram) 28/30, 命中总数 658 -> 928。
 *   同一份 token 还喂给 `scoreRelevance` —— 那边本来就有"标题命中+3/主题+2/正文+1.5 + 覆盖率奖励"的
 *   完整排序公式, 但因为 token 是整句, matched 恒为 0, 排序退化成"只按质量分"。
 *
 * 口径: ASCII 词(>=2 字符) + 中文 2 字滑窗; 去重保序; 默认最多 12 个(控制 LIKE 子句数量)。
 * 为什么是 bigram 而不是分词器: 不引入依赖、不需要词典, 且对"关键词出现在任意位置"的召回远好于整句;
 *   代价是噪声略增(单字停用词已剔除), 由后续的排序公式(命中数 + 覆盖率)兜住。
 */
const CJK_STOP_BIGRAMS = new Set(["的", "了", "是", "在", "和", "与", "或", "要", "需要", "问题", "导致", "以及"]);
/**
 * 2026-10-09 round 72-K: 分词模式开关 —— 只为**评测与回滚**而存在。
 *   `legacy` = 旧口径(按空格/标点切整句), `bigram`(默认) = 中文 2 字滑窗。
 *   为什么要有它: ① 相关度评测必须能**同题对照**(否则"改好了"只是感觉);
 *   ② 一旦 bigram 的噪声被证实有害, 回滚只需改一个环境变量, 不用再发一版。
 */
export function tokenMode(): "legacy" | "bigram" {
  return String(process.env.CONTEXT_TOKEN_MODE || "bigram").toLowerCase() === "legacy" ? "legacy" : "bigram";
}

/** 按当前模式取检索词(检索过滤与打分都必须走这里, 否则 A/B 会掺进"过滤用了新词、打分用了旧词"的混合态) */
export function retrievalTokens(q: string, maxTokens = 12): string[] {
  return tokenMode() === "legacy" ? terms(q) : queryTokens(q, maxTokens);
}

export function queryTokens(q: string, maxTokens = 12): string[] {
  const s = String(q || "").trim();
  if (!s) return [];
  const ascii = s.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, " ").match(/[A-Za-z0-9_.:/-]{2,}/g) || [];
  const runs = s.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const bigrams: string[] = [];
  for (const run of runs) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (CJK_STOP_BIGRAMS.has(bg)) continue;
      bigrams.push(bg);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...ascii, ...bigrams]) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= maxTokens) break;
  }
  return out;
}

/** tier -> 层: COLD 归长期层, 其余(HOT/WARM/GLOBAL/其它)归短期层 */
export function classifyTier(tier: string | null | undefined): MemoryLayer {
  return String(tier || "").toUpperCase() === "COLD" ? MEMORY_LAYER_LONG : MEMORY_LAYER_SHORT;
}

export interface RelevanceTarget {
  title?: string | null;
  content: string;
  theme?: string | null;
  qualityScore?: number | null;
  importance?: number | null;
  reinforceCount?: number | null;
  updatedAt?: Date | string | number | null;
}

/**
 * 相关性评分(query 与条目):
 *   - 标题命中 +3 / 主题命中 +2 / 正文命中 +1.5(词越多分越高)
 *   - 覆盖率奖励: 命中词数/查询词数 * 2(多词查询必须整体覆盖才靠前)
 *   - 质量分 * 1.5 + 重要性 * 0.5 + reinforceCount(封顶 10)*0.05 —— 历史沉淀的"越用越强"仍参与排序
 *   - 短期层(工作记忆)按 updatedAt 近者加权 0~1(新鲜度), 长期层不加速旧条目
 */
export function scoreRelevance(query: string, m: RelevanceTarget, layer?: MemoryLayer): number {
  // 2026-10-09 round 72-J: 换中文友好分词 —— 旧口径下 matched 恒为 0, 排序退化成"只按质量分"
  const ts = retrievalTokens(query);
  if (!ts.length) return m.qualityScore ?? 0;
  const title = String(m.title || "");
  const theme = String(m.theme || "");
  const content = String(m.content || "");
  let s = 0;
  let matched = 0;
  for (const t of ts) {
    if (title.includes(t)) { s += 3; matched++; }
    else if (theme.includes(t)) { s += 2; matched++; }
    else if (content.includes(t)) { s += 1.5; matched++; }
  }
  s += (matched / ts.length) * 2;
  s += (m.qualityScore ?? 0) * 1.5;
  s += (m.importance ?? 0.5) * 0.5;
  s += Math.min(m.reinforceCount ?? 0, 10) * 0.05;
  if (layer === MEMORY_LAYER_SHORT && m.updatedAt) {
    const t = new Date(m.updatedAt).getTime();
    const ageDays = Number.isFinite(t) ? (Date.now() - t) / 86400000 : 365;
    s += Math.max(0, 1 - ageDays / 90); // 90 天内的近期工作记忆加权, 之后归零
  }
  return s;
}

export interface LayerMemoryHit {
  id: string;
  title: string;
  content: string;
  snippet: string;
  layer: MemoryLayer;
  tier: string;
  score: number;
  qualityScore: number | null;
  theme: string | null;
  sourceType: string | null;
}

export interface RecallResult {
  shortTerm: LayerMemoryHit[];
  longTerm: LayerMemoryHit[];
  total: number;
}

const SNIPPET_LEN = 220;

function toHit(r: any, layer: MemoryLayer, score: number): LayerMemoryHit {
  return {
    id: r.id,
    title: r.title || "",
    content: String(r.content || ""),
    snippet: String(r.content || "").replace(/\s+/g, " ").slice(0, SNIPPET_LEN),
    layer,
    tier: r.tier || "WARM",
    score,
    qualityScore: r.qualityScore ?? null,
    theme: r.theme ?? null,
    sourceType: r.sourceType ?? null,
  };
}

/**
 * top-K 相关性召回: 短期层取 shortK 条、长期层取 longK 条。
 * 候选池先按 DB 级关键词(OR: title/content/theme contains) + theme 过滤 + 活性(supersededBy null)
 * 缩小, 再用 scoreRelevance 在 JS 内全量评分取 top-K —— 与旧"qualityScore 直排"相比是相关性召回,
 * 探针实测命中率不降。
 */
export async function recallTopK(opts: { query?: string; theme?: string; shortK?: number; longK?: number } = {}): Promise<RecallResult> {
  const shortK = Math.max(1, Math.min(opts.shortK ?? 5, 200));
  const longK = Math.max(1, Math.min(opts.longK ?? 5, 200));
  const q = String(opts.query || "").trim();
  const ts = retrievalTokens(q); // round 72-J/K: 中文友好分词 + 可切换模式(见 tokenMode 注释)
  const whereBase: any = { supersededBy: null };
  if (opts.theme) whereBase.theme = opts.theme;
  if (ts.length) whereBase.OR = ts.flatMap((t) => [{ title: { contains: t } }, { content: { contains: t } }, { theme: { contains: t } }]);

  const select = {
    id: true, title: true, content: true, theme: true, tier: true,
    qualityScore: true, importance: true, reinforceCount: true,
    sourceType: true, updatedAt: true,
  };
  const pool = Math.max((shortK + longK) * 6, 40);
  const [shortRows, longRows] = await Promise.all([
    prisma.memory.findMany({ where: { ...whereBase, tier: { in: ["HOT", "WARM"] } }, select, orderBy: { updatedAt: "desc" }, take: pool }).catch(() => [] as any[]),
    prisma.memory.findMany({ where: { ...whereBase, tier: "COLD" }, select, orderBy: { updatedAt: "desc" }, take: pool }).catch(() => [] as any[]),
  ]);

  const short = (shortRows as any[])
    .map((r) => ({ hit: toHit(r, MEMORY_LAYER_SHORT, scoreRelevance(q, r, MEMORY_LAYER_SHORT)), r }))
    .sort((a, b) => b.hit.score - a.hit.score)
    .slice(0, shortK)
    .map((x) => x.hit);
  const long = (longRows as any[])
    .map((r) => ({ hit: toHit(r, MEMORY_LAYER_LONG, scoreRelevance(q, r, MEMORY_LAYER_LONG)), r }))
    .sort((a, b) => b.hit.score - a.hit.score)
    .slice(0, longK)
    .map((x) => x.hit);
  return { shortTerm: short, longTerm: long, total: short.length + long.length };
}

/**
 * 每层统计(条目数 + content token 估算) —— 给探针/可观测性用。
 * 注意: 探针 scripts/probe-memory-layers.cjs 直接读库独立复算(避免与实现同源), 本函数是平台侧镜像。
 */
export async function memoryLayerStats(): Promise<{
  shortTerm: { count: number; tokens: number };
  longTerm: { count: number; tokens: number };
  oldCapChars: number;
  maxTokens: number;
}> {
  const [shortCount, longCount, shortContent, longContent] = await Promise.all([
    prisma.memory.count({ where: { supersededBy: null, tier: { in: ["HOT", "WARM"] } } }),
    prisma.memory.count({ where: { supersededBy: null, tier: "COLD" } }),
    prisma.memory.findMany({ where: { supersededBy: null, tier: { in: ["HOT", "WARM"] } }, select: { content: true } }),
    prisma.memory.findMany({ where: { supersededBy: null, tier: "COLD" }, select: { content: true } }),
  ]);
  const sumTokens = (rows: any[]) => rows.reduce((acc, r) => acc + estimateTokens(r.content), 0);
  return {
    shortTerm: { count: shortCount, tokens: sumTokens(shortContent) },
    longTerm: { count: longCount, tokens: sumTokens(longContent) },
    oldCapChars: OLD_SEED_CAP_CHARS,
    maxTokens: memorySeedMaxTokens(),
  };
}
