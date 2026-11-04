/**
 * no-action-decision.ts — 「这条人类决定 = 不需要做事」判据 (2026-09-17)
 *
 * 背景(实测缺陷, 升级任务 cmu5lyhgw001lfvjp787t8wx0 / 落地待办 todo_land_jchhhfj25hgs):
 *   human-decision-consumer 原先用一条内联正则判定"人类决定其实是关闭/无需落地":
 *     /(无需处理|不用处理|不需要处理|可以标记为完成|已完成|直接关闭|关闭即可|不采纳|作废|废弃|无需落地)/
 *   该正则要求「不需要」与「处理」**逐字相邻**。真实人类回复:
 *     "确认信息，应该不需要我处理什么吧"
 *   中间插了一个主语「我」-> 正则 MISS -> 平台凭空生成一条【落地】待办, 又被 todo_worker
 *   升级成任务交给执行体。执行体领到后**无活可干**(决定本意就是"不用管"), 反复空转/重升级
 *   (本单实测: 2026-09-17 幽灵升级治理清过一次, 5 分钟后又被升级成 cmu5lyhgw...)。
 *
 * 修法: 把判据抽成单一可测函数 isNoActionDecision() ——
 *   ① 规范式: 「无需/不用/不需要/不必/毋须」+ 可选主语/助词(最多 3 个字, 逐字符白名单)
 *      + 动作词(处理/操作/干预/理会/跟进/落地/执行/做什么/做任何/管/动手);
 *      主语白名单只放**不可能自己构成动作**的字(我你您他她它咱俺们人工亲自去来再多),
 *      因此不会像"任意 3 字通配"那样把 "不需要担心处理速度" 之类误判为无需做事。
 *   ② 历史直判短语原样保留(可以标记为完成/已完成/直接关闭/关闭即可/不采纳/作废/废弃/无需落地),
 *      不在本次修复里收紧, 避免改变既有通过用例的语义。
 *   ③ 「管」用否定前瞻 (?!理) 排除「管理」, 否则 "不需要管理层的批准" 会被误判。
 *   已知边界(本次不扩大改动面, 如实记录): 裸子串「已完成」是 2026-09-14 起的既有行为,
 *      形如 "方案B已完成评审, 请执行 A" 的文本仍会命中 —— 这是历史遗留风险, 与本单要修的
 *      **假阴性**(漏判"不需要我处理")方向相反, 留待独立一单评估收紧。
 *
 * 可测: 回归见 packages/apps/mind/scripts/test-no-action-decision.ts(含真实事故原文)。
 * 守卫镜像: scripts/macs-responder/todo_worker.py 的 no_action_decision() 与本文件同口径(R2),
 *   在升级前对**历史已建**的落地待办用 meta.decisionText 复核, 命中则直接结单不升级。
 */

/** 可插在「无需/不用」与动作词之间、且**自身不构成动作**的字(人称/助词)。 */
const NO_ACTION_BRIDGE_CHARS = "我你您他她它咱俺们人工亲自去来再多";
/** 动作词。`管(?!理)` 排除「管理」这一名词性前缀。 */
const NO_ACTION_VERB = "(?:处理|操作|干预|理会|跟进|落地|执行|做什么|做任何|管(?!理)|动手)";
/** 规范式: 否定词 + 可选主语/助词(<=3) + 动作词。 */
const NO_ACTION_CANONICAL_RE = new RegExp(
  "(?:无需|不用|不需要|不必|毋须)[" + NO_ACTION_BRIDGE_CHARS + "]{0,3}" + NO_ACTION_VERB
);
/** 历史直判短语(2026-09-14 起既有行为, 本次不动)。 */
const NO_ACTION_PHRASE_RE = /(可以标记为完成|已完成|直接关闭|关闭即可|不采纳|作废|废弃|无需落地|不用落地|不需要落地)/;

/**
 * 2026-09-18 扩修(实测假阴性变体, 落地待办 todo_land_a3i3oog57ci4 / 升级任务 cmu5lzpgd000610hglk46icde):
 *   auto-8d 决策产出: "不需要人类拍板;由平台自行关闭 todo_08a8c972...(doneBy=system:auto-decision-8d),
 *   不再开人类决策落地单;本任务完成后由 human-decision-consumer 自动判定 NO_ACTION。"
 *   旧判据三条全部 MISS: 「不需要人类拍板」的「类」不在主语白名单(且「拍板」不在动作词表);
 *   「不再开…落地单」是对消费者的**元指令**, 不是动作词; 「NO_ACTION」是机器 token。
 *   -> 平台又生成落地待办并升级为任务。补三条**元指令**判据(与"否定+动作词"正交, 不依赖主语白名单):
 *     ① 明确"不再开落地单/待办/任务";
 *     ② "平台自行关闭"(平台自处理, 无需执行体);
 *     ③ 机器 token NO_ACTION(以非标识符字符为边界, 大小写不敏感; 避免 NO_ACTION_FOLLOWUP 之类误命中)。
 *   精度核对(可复算): 对平台库 59 条 HUMAN_DECISION_LANDING 的 decisionText 复算, 仅本事故单由 MISS->HIT,
 *   其余 58 条判定不变 —— 负样本「判定不需人拍板…另立一条缺陷待办」「关闭 X(无需人类决策),并由平台将…并入改造清单」
 *   「不需要人类拍板, 请执行方案B并部署」均**不**命中(它们仍需平台动作)。
 *   2026-09-18 加固(采纳独立复核 C1/C2):
 *     C1 「不必再开落地单」为单字可选组的覆盖缺口 -> 可选组改 {0,2}, 支持「不必再开」。
 *     C2 元指令与后续「但…」动作句混写("不再开落地单, 但需要把代码回滚并复测")不应判 NO_ACTION
 *        -> 匹配尾部加同句否定前瞻 (?![^。;；\n]{0,24}但); 事故原文在「落地单」后即 `;` 分隔, 不受影响。
 */
const NO_ACTION_NO_LANDING_RE = /不(?:再|必|用|需要){0,2}开[^。;；\n]{0,12}?落地(?:单|待办|任务)(?![^。;；\n]{0,24}但)/;
const NO_ACTION_SELF_CLOSE_RE = /(?:由)?平台自行关闭/;
const NO_ACTION_TOKEN_RE = /(?:^|[^0-9A-Za-z_])NO_ACTION(?:$|[^0-9A-Za-z_])/i;
/** 元指令式判据的合并正则(诊断/外部脚本用)。 */
export const NO_ACTION_META_RE = new RegExp(
  [NO_ACTION_NO_LANDING_RE, NO_ACTION_SELF_CLOSE_RE, NO_ACTION_TOKEN_RE].map((r) => r.source).join("|"),
  "i"
);

/** 兼容旧引用: 合并后的正则(诊断/外部脚本用)。判定请优先用 isNoActionDecision()。 */
export const NO_ACTION_RE = new RegExp(
  NO_ACTION_CANONICAL_RE.source +
    "|" +
    NO_ACTION_PHRASE_RE.source.replace(/^\(|\)$/g, "") +
    "|" +
    NO_ACTION_META_RE.source,
  "i"
);

/**
 * 这段文本是否等于"决定 = 不需要做事"(不该再开落地任务)。
 * 例: "确认信息，应该不需要我处理什么吧" -> true。
 * 反例: "需要我处理这件事" / "不需要管理层的批准" -> false(完整边界见回归用例)。
 */
export function isNoActionDecision(text: string | null | undefined): boolean {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  return NO_ACTION_CANONICAL_RE.test(raw) || NO_ACTION_PHRASE_RE.test(raw) || NO_ACTION_META_RE.test(raw);
}

/** 暴露给测试/诊断: 命中的是哪条模式(可解释性)。 */
export function matchNoActionPattern(text: string | null | undefined): RegExp | null {
  const raw = String(text ?? "");
  if (NO_ACTION_CANONICAL_RE.test(raw)) return NO_ACTION_CANONICAL_RE;
  if (NO_ACTION_PHRASE_RE.test(raw)) return NO_ACTION_PHRASE_RE;
  if (NO_ACTION_NO_LANDING_RE.test(raw)) return NO_ACTION_NO_LANDING_RE;
  if (NO_ACTION_SELF_CLOSE_RE.test(raw)) return NO_ACTION_SELF_CLOSE_RE;
  if (NO_ACTION_TOKEN_RE.test(raw)) return NO_ACTION_TOKEN_RE;
  return null;
}
