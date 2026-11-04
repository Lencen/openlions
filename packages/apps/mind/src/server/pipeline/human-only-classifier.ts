/**
 * human-only-classifier.ts — "只能由人拍板"判据 (2026-09-15)
 *
 * 背景(实测缺陷, todo_tfe7uhzvoj20y3ol):
 *   human-decision-consumer 原先内联一条正则判"该决策是否超出自动边界":
 *     /(HUMAN_ONLY|DEFER_TO_HUMAN|...|转人工|需人拍板|需要人类|请人拍板)/i
 *   该正则**不识别否定**。于是一条**已经由平台自动执行完毕**的 AUTO_DECISION:
 *     "不需人拍板。已执行并复测通过 —— ..."
 *   里的子串 "需人拍板" 仍命中 -> 平台又生成一张 "【需您拍板】" 决策卡,
 *   并把原待办 meta.humanOnly=true —— 实质上把球踢回给人, 违反平台硬性规则
 *   "禁止把球踢回给人"(2026-09-14 实测修正)。
 *
 * 修法: 把判据抽成可测函数, 并对**中文短语**加否定前缀负向断言
 *   (?<![不非无毋勿]) —— "不需人拍板/不需要人类/无需人工/不转人工" 一律不命中;
 *   "需人拍板/需要人类确认/转人工/HUMAN_ONLY" 仍命中。
 * 英文标记(HUMAN_ONLY 等)是显式约定, 不做否定猜测, 保持原判。
 */
const HUMAN_ONLY_PATTERNS: RegExp[] = [
  /HUMAN_ONLY/i,
  /DEFER[_ ]?TO[_ ]?HUMAN/i,
  /NEED[_ ]?HUMAN/i,
  /ESCALATE[_ ]?TO[_ ]?HUMAN/i,
  /(?<![不非无毋勿])转人工/,
  /(?<![不非无毋勿])需人拍板/,
  /(?<![不非无毋勿])需要人类/,
  /(?<![不非无毋勿])请人拍板/,
];

/** 决策文本是否属于"只能人拍板"(四类: 花钱/合规法务/对外承诺/不可逆业务取舍)。 */
export function isHumanOnlyDecision(decision: string | null | undefined): boolean {
  const d = String(decision ?? "");
  if (!d.trim()) return false;
  return HUMAN_ONLY_PATTERNS.some((re) => re.test(d));
}

/** 暴露给测试/诊断: 命中的是哪条模式(可解释性)。 */
export function matchHumanOnlyPattern(decision: string | null | undefined): RegExp | null {
  const d = String(decision ?? "");
  for (const re of HUMAN_ONLY_PATTERNS) if (re.test(d)) return re;
  return null;
}
