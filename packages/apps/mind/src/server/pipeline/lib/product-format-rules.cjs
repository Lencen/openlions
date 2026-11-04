#!/usr/bin/env node
/**
 * product-format-rules.cjs — 飞轮产物格式判据的**单一来源** (2026-09-29)
 *
 * 为什么单独抽出来 (实测教训, 我自己造成的):
 *   "逃避式条目" 判据原先在 check-product-format.cjs 与 cleanup-old-non-compliant-products.cjs
 *   各写一份正则。2026-09-29 复核发现该正则有**严重误报**:
 *     - `对话[中里]` -> 命中 "当Reflection产物为0但**对话中**已多次出现元认知判断时应立即..." (触发条件描述)
 *     - `后[续续]补[充充]` -> 命中 "『需要补全才能继续|...|**后续补充**』, 卡『元评论冒充证据』"
 *       (这是在**描述一个正则模式串**, 不是逃避式)
 *   后果: 用该判据清理历史数据时, 776 条里有 751 条仅因 **title 超长** 被标 stale ——
 *   而抽样显示这些内容**有效**("会导致 self-service 链路在 mind 挂掉时静默失败" /
 *   "该量化结果是判定 aggregator 误归因的核心证据")。把有效知识因"标题长"移出检索面
 *   是**真实损害**, 与"知识可用"目标相反。
 *
 * 结论: 判据必须 (a) 收紧到**明确的逃避语义**, (b) 做**引用上下文排除**, 且 (c) 只有一处定义。
 */

/** 收紧后的逃避式模式 —— 只保留明确表达"该写而没写"的语义。 */
const EVASIVE_RE = /未记录|无对应知识|无对应Knowledge|未明确|暂未记录|无法判定|需调研|覆盖度未达标|未沉淀为/;

/**
 * 判定是否**引用上下文** (命中处附近有引号/反引号/竖线/『』等 -> 属于"在描述/引用某段文本",
 * 不是在写逃避式条目)。这是消除误报的关键一步。
 */
function isQuoteContext(text, idx, len) {
  const ctx = String(text).slice(Math.max(0, idx - 60), idx + len + 60);
  return /[『「"'`\|]/.test(ctx);
}

/** 是否真逃避式 (收紧模式 + 引用排除)。 */
function isEvasive(content) {
  const c = String(content || "");
  const m = c.match(EVASIVE_RE);
  if (!m) return false;
  const i = c.indexOf(m[0]);
  return !isQuoteContext(c, i, m[0].length);
}

/** markdown 结构检测 (与守门同口径)。 */
const MARKDOWN_RE = /(^|\n)#{1,6}\s|^[-*]\s|^\d+\.\s|\*\*[^*]+\*\*/;
function hasMarkdown(content) { return MARKDOWN_RE.test(String(content || "")); }

/** V3 title 上限。 */
const TITLE_MAX = 30;
function isLongTitle(title) { return String(title || "").trim().length > TITLE_MAX; }

/** 短而空: 内容极短且无任何 markdown 结构 (与守门同口径)。 */
function isShortEmpty(content) {
  const c = String(content || "");
  return c.trim().length < 50 && !hasMarkdown(c);
}

function isCompliant(input) {
  const { title, content, kind = "knowledge" } = input;
  const t = String(title || "");
  const c = String(content || "");
  if (isLongTitle(t)) return { ok: false, reason: "title>30 字" };
  if (isEvasive(c)) return { ok: false, reason: "逃避式短语" };
  if (isShortEmpty(c)) return { ok: false, reason: "短而空" };
  return { ok: true };
}

module.exports = { EVASIVE_RE, isQuoteContext, isEvasive, MARKDOWN_RE, hasMarkdown, TITLE_MAX, isLongTitle, isShortEmpty, isCompliant };
