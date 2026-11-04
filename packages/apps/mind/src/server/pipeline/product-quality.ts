/**
 * product-quality.ts — 飞轮产物(FLYWHEEL_STRUCTURED)质量评分的**单一权威入口** (2026-09-14)
 *
 * 为什么存在 (FW-QUALITY 根因):
 *   指标 `products_avg_quality_24h` = 近24h 三表 FLYWHEEL_STRUCTURED 行的 AVG(qualityScore)。
 *   该指标曾在 2026-09-11 塌到 0.493, 根因不是"内容变差", 而是**写入侧没有质量评分契约**:
 *     - structure-fragments(V1.7 结构化产线, 当时 24h 窗口内 103/418 行)在 create 里**根本没写
 *       qualityScore** -> 落库取默认 0; 该提交(1638dc2)补了评分, 但**参数名传错**(传了 confidence,
 *       那是 knowledge 分支的参数, calcMemoryQuality 签名里没有它) -> 价值分维度恒定不得分(21ebc52 再修)。
 *     - 结果是同一份 calcQualityScore 被 N 个调用方以各自不同的(有时错误的)参数调用,
 *       任何一处漂移都静默拉低总均值, 且没有任何告警。
 *
 * 本模块把"评分 + 门槛"收敛成一个入口:
 *   - `structuredProductScore()`: FLYWHEEL_STRUCTURED Memory 的唯一评分函数(参数与 rubric 对齐, clamp valueScore)。
 *   - `MIN_PRODUCT_QUALITY`: 平台 G3 产物质量门槛的单一来源(此前只在 execute-improving-task.ts 本地定义)。
 *   - `isBelowProductFloor()`: 判定是否低于门槛, 供写入侧登记/告警。
 *
 * 注意(诚实披露): 本模块**不改变评分公式**(公式仍是 db-writer.ts 的 calcQualityScore)。
 *   它只保证: ①参数名不再传错; ②valueScore 一定 clamp 到 [0,1]; ③门槛只有一个来源。
 *   若未来要改公式权重, 那属于"改尺子", 必须在 docs 里单列披露并另走复核, 不在此模块里偷偷做。
 */
import { calcQualityScore } from "./db-writer";

/**
 * 平台 G3 产物质量门槛(单一权威源)。
 * 低于此分的飞轮产物不允许"无标记"地混入产物池; 写入侧必须至少登记它(见 structure-fragments.ts)。
 * 环境变量与 execute-improving-task.ts 保持一致: FLYWHEEL_MIN_PRODUCT_QUALITY。
 */
export const MIN_PRODUCT_QUALITY: number = (() => {
  const n = Number(process.env.FLYWHEEL_MIN_PRODUCT_QUALITY ?? "0.4");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.4;
})();

export interface StructuredProductInput {
  content: string;
  title?: string | null;
  theme?: string | null;
  tags?: string | null;
  /** LLM 自评复用/决策价值 0-1; 缺失按 0.5 回落(与 cognitive-extractor 既有约定一致) */
  valueScore?: number | null;
  reinforceCount?: number;
}

/**
 * FLYWHEEL_STRUCTURED Memory 的权威评分。
 * - valueScore: 非有限数 -> 0.5 回落; 否则 clamp 到 [0,1](防 LLM 给出 3 或 -1)
 * - tags: 结构化产线统一给 "flywheel-structured" 一类标签
 * - 返回 Math.max(0, min(..., 1)) —— 与 calcMemoryQuality 同界
 */
export function structuredProductScore(p: StructuredProductInput): number {
  const rawVs = Number(p.valueScore);
  const valueScore = Number.isFinite(rawVs) ? Math.min(1, Math.max(0, rawVs)) : 0.5;
  return calcQualityScore({
    type: "memory",
    content: String(p.content ?? ""),
    title: p.title ?? null,
    theme: p.theme ?? null,
    tags: p.tags ?? null,
    valueScore,
    reinforceCount: p.reinforceCount ?? 0,
  });
}

/** 低于 G3 门槛(或分数非法) => true。写入侧据此登记, 而不是静默入库/静默丢弃。 */
export function isBelowProductFloor(score: number): boolean {
  return !Number.isFinite(score) || score < MIN_PRODUCT_QUALITY;
}

/**
 * 写入侧的"评分 + 门槛"一次判定(纯函数, 供单测直接覆盖)。
 * 所有 FLYWHEEL_STRUCTURED 产物写入点都应走这里, 以保证:
 *   评分只有一个入口; 低于门槛一定被标记(belowFloor), 而不是静默蒙混。
 */
export function classifyStructuredOutput(
  o: { content: string; title?: string | null; valueScore?: number | null },
  theme: string,
  tags?: string | null
): { qualityScore: number; belowFloor: boolean } {
  const qualityScore = structuredProductScore({
    content: o.content,
    title: o.title ?? null,
    theme,
    tags: tags ?? null,
    valueScore: o.valueScore,
  });
  return { qualityScore, belowFloor: isBelowProductFloor(qualityScore) };
}
