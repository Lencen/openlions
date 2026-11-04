/**
 * human-decision.ts — 识别"这件事只能由人拍板"（2026-10-23）
 *
 * 背景：PENDING 2,043 条里有 150 条标题写着"拍板/等 X 决策/需人类产品决策"。
 *   agent 永远做不完这类活，却持续参与认领/回收，是 churn 的稳定来源。
 *   在**生成端**打标 + 在**认领端**拦住，比事后清理干净。
 *
 * 判据保守：只认明确的决策/授权语义，避免把"确认现状"这类可执行动作误判。
 */
const HUMAN_DECISION_RE = /拍板|定方向|由.{0,6}(决定|拍板)|等.{0,8}决策|需(.{0,6})?(人类|产品|领导).{0,4}决策|要人定|人工确认|需人类|请用户决定|待良晨|授权(范围|额度|采购)/;

export function looksLikeHumanDecision(text: string | null | undefined): boolean {
  return HUMAN_DECISION_RE.test(String(text || ""));
}
