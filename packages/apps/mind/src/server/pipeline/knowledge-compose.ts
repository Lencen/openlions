/**
 * knowledge-compose.ts — 把结构化字段拼成**带 markdown 结构**的 Knowledge.content (2026-10-09 round 72-G)
 *
 * 为什么需要它(实测): 认知闸 checkKnowledgeStructure 要求 content 至少有 1 个结构标记
 *   (# 标题 / 列表 / 表格), 而实测近 5 小时新增 Knowledge 的通过率只有 **61.7%**,
 *   缺失项几乎全是 structure —— 因为写入口是把几段纯文本用空行拼起来:
 *     [finding.what, finding.why, finding.evidenceSnippet].join("\n\n")
 *   内容其实是好的(结论/原因/证据俱全), 只是**没有说明哪段是什么**。
 *
 * 这个函数的立场: 不编造任何内容, 只把**已经有语义的字段**贴上它本来的标签。
 *   `what` 就是结论, 所以标 "结论"; `why` 就是原理/依据, 所以标 "原理/机制"。
 *   这与 db-writer 自 2026-09-03 起就在用的写法一致 —— 本模块把那份实现抽成单一来源,
 *   避免第三个写点再抄一遍(平台已多次因"同一逻辑两处各写一套"出事故)。
 */

export interface KnowledgeParts {
  /** 结论(必填, 缺失则返回空串 —— 调用方按"空内容不落库"处理) */
  conclusion?: unknown;
  /** 原理/机制 */
  principle?: unknown;
  /** 事实/依据 */
  evidence?: unknown;
  /** 适用边界/限制 */
  boundary?: unknown;
  /** 案例 */
  caseExample?: unknown;
  /** 兜底: 以上全空时使用的原始文本(保持旧行为, 不丢内容) */
  fallback?: unknown;
  /** 总长度上限; **不传/传 0 = 不截断**(调用方各自的历史行为必须保住: 执行器原本截 1000, db-writer 原本不截) */
  maxLen?: number;
}

const S = (v: unknown): string => (v == null ? "" : String(v).trim());

/** 拼装: 只在字段非空时输出对应小节; 全空则回落到 fallback。 */
export function composeKnowledgeContent(parts: KnowledgeParts): string {
  const c = S(parts.conclusion);
  const p = S(parts.principle);
  const ev = S(parts.evidence);
  const b = S(parts.boundary);
  const ce = S(parts.caseExample);
  const fb = S(parts.fallback);
  if (!c && !p && !ev && !b && !ce) return fb;
  const lines: string[] = [];
  // 结论**不强制**存在: 有些 finding 只有 why + evidence, 硬塞一个空的 "# 结论" 反而是噪音
  if (c) lines.push("# 结论\n" + c);
  if (p) lines.push("## 原理/机制\n" + p);
  if (ev) lines.push("## 事实/依据\n" + ev);
  if (b) lines.push("## 适用边界/限制\n" + b);
  if (ce) lines.push("## 案例\n" + ce);
  const out = lines.join("\n\n");
  const max = parts.maxLen ?? 0;
  return max > 0 && out.length > max ? out.slice(0, max) : out;
}