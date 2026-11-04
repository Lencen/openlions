/**
 * self-correction-notice.ts — 「这条内容只是一条自纠/更正通报, 不是给人类的决策请求」判据 (2026-09-18)
 *
 * 事故(待办 todo_land_wf707ayvqbjp / 源卡 todo_35b447f57bf5408a8c6e):
 *   人类原话: "B，这个是不是之前已经处理过了，已处理过的为什么还是会出任务让我决策？"
 *   源卡是一条 [macs离线消息] —— 某个 agent 对自己**上一条消息**的自纠通报:
 *       "补正上一条第二节（16:09，只改定性，不改事实）。我上一条把归档卡 PENDING 写成'未判定'…"
 *   通篇是**陈述**, 没有向人类提问、没有选项、没有"要不要"。
 *   人类早在 2026-09-17 07:02:32 就在该卡讨论区写过:
 *       "这个任务需要我做什么，我没看出需要我决策的信息呀＠agent-x"
 *   但 2026-09-17 10:57:37 的存量迁移 migrate-human-todos-to-cards.ts 把这条已挂起的
 *   legacy 人类待办**无条件**包装成一张【需您拍板】决策卡; 13:09:11 人类批量回复时又由
 *   human-decision-consumer 生成落地待办 -> 被 todo_worker 升级为本任务。平台因此**凭空**
 *   要求人类为一条"我改了个措辞"的通报拍板。
 *
 * 判据(确定性, 保守; 与 no-action-decision.ts 同风格, 单一可测函数):
 *   同时满足才判 true ——
 *     ① 命中「自纠/更正标记」: 作者在更正自己上一条消息/自己刚写的说法;
 *     ② **不含**任何「决策请求标记」: 要不要 / 是否 / 请选择 / 选项 / 推荐 / 请拍板 / 需要您决定…。
 *   任一不满足 -> false(照常建卡)。宁可不抑制, 也不误伤真正的决策请求。
 *
 * 诚实边界(与 no-action-decision.ts 一致):
 *   - 这是**文本启发式**, 不是语义理解。跨语言/隐晦写法的自纠通报仍可能漏判(方向是"少抑制")。
 *   - 已知误伤风险: 若某人真的在决策文本里写"我把方案写成 A/B…"却完全不提要不要/是否/选项,
 *     会被判自纠(极罕见); 故②的决策请求词表尽量宽, 且单元回归里放置正/负样本逐条钉死。
 *   - 只用于**人类决策卡的建卡/迁移**环节, 不用于任务验收或结单判定。
 *
 * 回归: packages/apps/mind/scripts/test-self-correction-notice.ts(含事故原文与会话里同批真实负样本)。
 */

/** 自纠/更正标记: 作者在更正**自己上一条**消息或自己刚写的说法。 */
const SELF_CORRECTION_RE = new RegExp([
  // ① 显式自纠措辞 + 明确指向上一条/上一节
  "(?:补正|更正|勘误)(?:上一条|前一条|上条|上一节|上一则|第[一二三四五六七八九十]+[节条])",
  // ② 「上一条…写成/标成/标了/定性(降下来)」等
  "(?:上一条|前一条|上条|上一节|上一则)[^。;；\\n]{0,30}(?:写成|写作|标成|标了|定性|降下来|说成|记成|错写)",
  // ③ 第一人称更正自己刚写的说法(我上一条把 X 写成 Y / 我把 X 写成 Y)
  "我[^。;；\\n]{0,30}(?:写成|写作|标成|标了|写错|标错|记成|说成)",
  // ④ 直述式自纠/勘误
  "只改定性|自纠|勘误",
].join("|"));

/**
 * 决策请求标记: 只要文本里出现任一, 就不再判为"自纠通报"。
 * 词表宁可宽(把真决策请求都挡住), 因为漏抑制的代价远小于误抑制一张真决策卡。
 */
const DECISION_ASK_RE = new RegExp([
  "要不要",
  "是否(?:需要|应该|可以|要|可)",
  "请选择|选哪|哪一(?:个|种)",
  "选项",
  "推荐\\s*[:：]",
  "请拍板|请您(?:决定|拍板|确认|定)|需要您(?:决定|拍板|确认|定)",
  "如何取舍|怎么处理|怎么办",
  "请回复|请答复|请确认",
].join("|"));

/** 命中的自纠标记(可解释性/审计用); 未命中返回 null。 */
export function selfCorrectionMarker(text: unknown): string | null {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;
  const m = raw.match(SELF_CORRECTION_RE);
  return m ? m[0] : null;
}

/** 是否命中决策请求标记(可解释性/审计用)。 */
export function hasDecisionAsk(text: unknown): boolean {
  return DECISION_ASK_RE.test(String(text ?? ""));
}

/**
 * 这段内容是否只是"自纠/更正通报"(不是给人类的决策请求)。
 * 例: "补正上一条第二节(只改定性)…我上一条把归档卡 PENDING 写成'未判定'…" -> true。
 * 反例: "选项 A/B/C, 要不要按建议执行?" -> false(有决策请求, 即使通篇自称补正)。
 */
export function isSelfCorrectionNotice(text: unknown): boolean {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  if (!SELF_CORRECTION_RE.test(raw)) return false;
  return !DECISION_ASK_RE.test(raw);
}

/** 暴露给测试/诊断: 命中的是哪条自纠模式。 */
export const SELF_CORRECTION_RE_EXPORT = SELF_CORRECTION_RE;
/** 暴露给测试/诊断: 决策请求词表。 */
export const DECISION_ASK_RE_EXPORT = DECISION_ASK_RE;

/** 被 surfacing 的 macs 离线消息标题前缀(_surface_human_offline_todo 写入)。 */
const MACS_OFFLINE_TITLE_RE = /^\s*\[macs离线消息\]/;
/** 汇报/通报类措辞: 规则②要求命中至少一个, 作为"这是汇报不是提问"的正向证据(避免把无标点的提问吞掉)。 */
const REPORT_MARKER_RE = /(您好|我是[^。\n]{0,12}执行体|结论|汇报|报告|通报|核查|巡检|已完成|已修复|已做修复|已处理|结单|回执|说明如下|同步如下|现状|进展|变更如下)/;
/** 无标点疑问句尾: 吗/呢(排除「吗啡」)。 */
const QUESTION_PARTICLE_RE = /吗(?!啡)|呢/;

/**
 * 更宽一层的「非决策内容」判据(仍保守): 只要满足任一即 true ——
 *   ① 是自纠/更正通报(isSelfCorrectionNotice);
 *   ② **macs 离线消息**(surfaced 给人类的 agent 消息)且**通篇没有决策请求**、**没有问号/疑问语气**、
 *      且**带有汇报类措辞** —— 这类消息是"把消息并入人类待办视图"(见 mcp-agent-chat-server/registry.py
 *      `_surface_human_offline_todo`), 本身不是"请人类拍板"; 若通篇是汇报, 就不该被包装成
 *      【需您拍板】决策卡。实测同批另外 2 条 OPEN legacy 待办正是这种 agent 状态汇报:
 *        "[macs离线消息] 良晨您好，我是 agent-x 执行体…核查结论如下…" / "[macs离线消息] 【结单+NEEDS DEPLOY】…已完成"
 *   反例(must false): "[macs离线消息] 现在有两个方案，要不要 A 还是 B?" -> 有决策请求, 保留;
 *                    "[macs离线消息] 这个结论你认可吗" -> 有疑问语气, 保留。
 *
 * @param title 标题(迁移/建卡前的原文标题)
 * @param detail 可选正文(一起参与"是否有决策请求"的判断)
 */
export function isNonDecisionNotice(title: unknown, detail?: unknown): boolean {
  const t = String(title ?? "");
  const text = t + "\n" + String(detail ?? "");
  if (isSelfCorrectionNotice(text)) return true;
  if (!MACS_OFFLINE_TITLE_RE.test(t)) return false;
  if (DECISION_ASK_RE.test(text)) return false;      // 有决策请求 -> 保留
  if (/[?？]/.test(text)) return false;               // 有问号 -> 保守保留
  if (QUESTION_PARTICLE_RE.test(text)) return false;  // 无疑问标点但语气在问 -> 保守保留
  return REPORT_MARKER_RE.test(text);                 // 有汇报措辞且无提问 -> 判为通报
}

/** 暴露给测试/诊断: 命中的是哪一类非决策内容(可解释性)。 */
export function nonDecisionKind(title: unknown, detail?: unknown): string | null {
  const t = String(title ?? "");
  const text = t + "\n" + String(detail ?? "");
  if (isSelfCorrectionNotice(text)) return "SELF_CORRECTION_NOTICE";
  if (MACS_OFFLINE_TITLE_RE.test(t) && !DECISION_ASK_RE.test(text) && !/[?？]/.test(text) &&
      !QUESTION_PARTICLE_RE.test(text) && REPORT_MARKER_RE.test(text)) return "MACS_OFFLINE_MESSAGE_NO_ASK";
  return null;
}

