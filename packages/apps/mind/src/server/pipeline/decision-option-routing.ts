/**
 * decision-option-routing.ts — 「人类决策卡选了哪个选项」判据 (2026-09-18)
 *
 * 事故(平台库只读实测, 本单来源):
 *   决策卡 todo_e1s1g0217r5didag 正文给了 A/B/C 三个选项:
 *     A) 按平台建议执行——立刻推进, 短期见效
 *     B) 先补充信息再决定——多花一点时间把证据补齐, 期间事项继续挂着
 *     C) 判定无需处理, 直接关闭——不再追这件事, 接受现状
 *   人类回复: "B，这个是不是之前已经处理过了，已处理过的为什么还是会出任务让我决策？"
 *   —— 明确选了 B(先补充信息再决定, 不是执行)。
 *   但 human-decision-consumer 从**不读人类选了哪个字母**, 只按"有决定文本"就走
 *   「[落地] 按人类决策执行 -> 建执行待办 -> todo_worker 按 needs_tools 升级成执行体任务」。
 *   复现(当前仓库代码, tsx 实跑):
 *     isNoActionDecision("B，这个是不是…")=false, isNonDecisionText=false, isHumanOnlyDecision=false
 *     -> 三个已有闸门全部放行 -> 生成落地待办 todo_land_l2r2wzspprcj -> 升级任务 cmu5z3r0k0007jlosqh360ydq
 *        (正是执行体领到后"无活可干/与本意相反"的这一单)。
 *
 * 判据设计(确定性, 用**卡片自己给出的选项文本**, 不硬编码 A/B/C 含义):
 *   1. parseDecisionOptions(detail|optionsText): 解析卡片③选项段的 "X) 文本" 行;
 *   2. selectedOptionLabel(decision): 取决定文本开头人类选的选项字母
 *      (支持 `B` / `B，` / `B)` / `B、` / `选B` / `选择 B` / `B选项`);
 *   3. classifyOptionText(text): 把**该选项自己的文本**归为
 *        CLOSE_NO_ACTION(无需处理/直接关闭/接受现状…) / DEFER_INFO(补充信息/再决定/继续挂着…)
 *        / EXECUTE(执行/推进/按平台建议…) / UNKNOWN;
 *   4. resolveDecisionOption(): 合并 2+3, 返回所选选项及其语义。
 *
 * 消费者行为(见 human-decision-consumer.ts):
 *   CLOSE_NO_ACTION -> 按 no-action 关单(不建落地单);
 *   DEFER_INFO      -> 记录挂起(meta.deferredForInfo), **不建执行落地单**;
 *   EXECUTE/UNKNOWN -> 维持原有落地流程(保守: 宁可照旧执行, 也不吞掉真实动作)。
 *
 * 诚实边界:
 *   - 只在**卡片确实给出选项、且人类确实以字母开头选择**时才按选项语义路由;
 *     无选项/无字母 -> 回退原有文本闸门, 行为不变(负样本见回归)。
 *   - 退化: 字母选中但选项文本无法归类 -> UNKNOWN -> 照旧落地(不误抑制)。
 *   - 自由文本(没写字母)仅在**强 DEFER 短语且无执行动词**时按 DEFER; 否则不判。
 *   - 只决定"要不要建执行落地单"; 补信息之后如何重提请是另一条链路, 本模块不承诺自动重提。
 *
 * 回归: packages/apps/mind/scripts/test-decision-option-routing.ts
 */

export type OptionClass = "EXECUTE" | "DEFER_INFO" | "CLOSE_NO_ACTION" | "UNKNOWN";

export interface DecisionOption {
  label: string;
  text: string;
}

/** 选项行: `A) xxx` / `A） xxx` / `A. xxx` / `A、 xxx` / `A: xxx`。 */
const OPTION_LINE_RE = /^\s*([A-Za-z])\s*[)）.、:：]\s*(\S.*)$/;

/** 决定文本开头的选项选择: 可选「选/选择/按/采纳」+ 字母 + 边界。 */
const SELECTED_LABEL_RE = /^\s*(?:选\s*择?|按|采纳|执行)?\s*([A-Za-z])\s*(?:选项|项)?\s*(?=$|[\s,，、。.;；:：)）\]]|然后|,|，)/;

/** 关闭类强标记(选项文本自述"无需处理/直接关闭")。 */
const CLOSE_MARKERS = /(无需处理|不用处理|不需要处理|不必处理|不处理|直接关闭|关闭即可|确认已落地|确认已?作废|不再追|接受现状|不采纳|作废|废弃|归档|搁置|无需执行|无需落地|不用落地|不需要落地|停止|停下)/;
/** 补信息/延后类强标记(选项文本自述"先补信息再决定/继续挂着")。 */
const DEFER_MARKERS = /(补充信息|补齐证据|把证据补齐|补证|再决定|再做决定|后续再|继续挂着|继续观察|先观察|暂缓|稍后|以后再|待定|先不急|再等等|信息不足|补充材料|先补)/;
/** 执行类标记(选项文本自述"执行/推进")。 */
const EXECUTE_MARKERS = /(执行|推进|立刻|马上|按建议|按平台建议|落地|修复|处理掉|做起来|采纳并|开工)/;

/**
 * 解析卡片给出的选项列表。
 * 优先用结构化 optionsText(如有), 再回退解析 detail 里的 ③选项段。
 * 只认 "字母) 文本" 形态的行 —— 不猜自然语言。
 */
export function parseDecisionOptions(
  detail: string | null | undefined,
  optionsText?: string | null
): DecisionOption[] {
  const out: DecisionOption[] = [];
  const seen = new Set<string>();
  const push = (label: string, text: string) => {
    const L = label.toUpperCase();
    const body = text.trim();
    if (!body || seen.has(L)) return;
    seen.add(L);
    out.push({ label: L, text: body });
  };
  // 结构化 optionsText 常见形态: "A) …; B) …; C) …" 或**无分隔符紧凑串** "A) … B) …"。
  // 2026-09-18 独立复核修(P2): 旧实现先按 [;；\n] 切, 只有一项时**才**尝试紧凑切分 —— 于是
  //   "A) 立刻执行 B) 先补充信息再决定 C) 直接关闭" 被当成一项, B/C 文本被并进 A 的 text,
  //   使 A 误判为 CLOSE_NO_ACTION(false suppress)。现统一按**选项前缀**切分, 两种形态同一套逻辑。
  const raw = String(optionsText ?? "");
  if (raw.trim()) {
    for (const part of raw.split(/(?=\b[A-Za-z]\s*[)）.、:：])/)) {
      const m = part.match(OPTION_LINE_RE);
      if (m) push(m[1], m[2].replace(/[;；]\s*$/, ""));
    }
  }
  if (!out.length) {
    for (const line of String(detail ?? "").split(/\n+/)) {
      const m = line.match(OPTION_LINE_RE);
      if (m) push(m[1], m[2]);
    }
  }
  return out;
}

/** 取决定文本开头人类选择的选项字母(支持 `B`/`B，`/`选B`/`选择 B`/`B选项`)。 */
export function selectedOptionLabel(decision: string | null | undefined): string | null {
  const d = String(decision ?? "").trim();
  if (!d) return null;
  const m = d.match(SELECTED_LABEL_RE);
  return m ? m[1].toUpperCase() : null;
}

/**
 * 把一段选项文本归为: 关闭 / 补信息延后 / 执行 / 未知。
 * 顺序: 关闭 > 补信息 > 执行 > 未知; 「补信息」与「执行」同时出现时按 UNKNOWN(保守, 不抑制)。
 */
export function classifyOptionText(text: string | null | undefined): OptionClass {
  const t = String(text ?? "").trim();
  if (!t) return "UNKNOWN";
  if (CLOSE_MARKERS.test(t)) return "CLOSE_NO_ACTION";
  const defer = DEFER_MARKERS.test(t);
  const exec = EXECUTE_MARKERS.test(t);
  if (defer && !exec) return "DEFER_INFO";
  if (exec) return "EXECUTE";
  return "UNKNOWN";
}

export interface ResolvedDecisionOption {
  label: string;
  text: string;
  klass: OptionClass;
  /** 判定来源: 卡片选项(option) / 决策自由文本(free-text)。 */
  via: "option" | "free-text";
}

/**
 * 自由文本兜底: 没写选项字母时, 仅当**强 DEFER 短语且无执行动词**才判 DEFER。
 * (CLOSE 的自由文本由 no-action-decision.ts 负责, 本函数不重复。)
 */
function freeTextDeferClass(decision: string): OptionClass {
  const raw = String(decision ?? "");
  // 长度按**原始**文本判(2026-09-18 复核 P3: 旧实现先 trim 再判长度, 极端空白填充可绕过)。
  if (raw.length > 80) return "UNKNOWN";
  const t = raw.trim();
  if (!t) return "UNKNOWN";
  if (CLOSE_MARKERS.test(t)) return "UNKNOWN"; // 交给 no-action 链路
  if (DEFER_MARKERS.test(t) && !EXECUTE_MARKERS.test(t)) return "DEFER_INFO";
  return "UNKNOWN";
}

/**
 * 合并判定: 人类这条决定选择了什么语义。
 * 返回 null 表示"没有可判定的选项选择"(调用方维持原行为)。
 */
export function resolveDecisionOption(
  decision: string | null | undefined,
  options: DecisionOption[] | null | undefined
): ResolvedDecisionOption | null {
  const label = selectedOptionLabel(decision);
  if (label && Array.isArray(options) && options.length) {
    const hit = options.find((o) => o.label === label);
    if (hit) {
      return { label, text: hit.text, klass: classifyOptionText(hit.text), via: "option" };
    }
  }
  const ft = freeTextDeferClass(String(decision ?? ""));
  if (ft === "DEFER_INFO") {
    return { label: label || "", text: String(decision ?? "").trim(), klass: ft, via: "free-text" };
  }
  return null;
}
