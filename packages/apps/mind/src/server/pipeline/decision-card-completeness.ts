/**
 * decision-card-completeness.ts — 决策卡"内容是否可决策"的单一判据 (2026-10-26)
 *
 * 背景(源待办 todo_5r9e4kcs0folv6en / 8 条占位 HUMAN_DECISION_CARD):
 *   旧链路把 `平台自动分级: APPLY_IMPROVEMENT 优先级=P1。完整内容: 为 m878t1 增加…`
 *   交给 decision-card-language 的业务语言层; 该层为了"业务段不出现技术词"会 deTechnicalize,
 *   把条目 ID 全删掉, 于是业务段变成:
 *     `平台梳理出的要点:平台自动分级:优先级=。完整内容:为 增加…`
 *   `isBusinessCard()` 只检查"①~⑤ 齐全 + 无技术词", 这种占位文本**照样 PASS** ——
 *   于是卡被交给人类, 人类却不知道"对哪个对象、做什么、做完什么样算成功"。
 *
 * 本模块只做两件事(纯函数, 无 IO, 可被 tsx 回归):
 *   1. extractDecisionFacts(): 从原始决定文本里**原样**抽出对象 ID / 建议动作 / 期望结果,
 *      供卡片技术细节段保留可核对锚点(不参与业务段去技术化);
 *   2. auditDecisionCard(): 判定一张卡是否"可决策"(对象 + 动作 + 期望 + ①~⑤ + 无占位泄漏),
 *      用于建卡后自检 / 存量巡检, 不再让占位卡静默过关。
 *
 * 设计约束:
 *   - 不引入新状态机、不改 claimable/auto-decide 的语义;
 *   - 判定只依赖 title/detail 文本, 便于对历史卡复算;
 *   - 与 decision-card-language.isBusinessCard() 互补: 后者管"像不像人话", 本模块管"够不够决策"。
 */

/** 短条目 ID: 至少 6 位且含数字(如 m878t1 / 2oaojq / j859kt), 或完整 cuid(25 位左右)。 */
const SHORT_ID_RE = /(^|[^A-Za-z0-9])([a-z0-9]{6,24})(?![A-Za-z0-9])/g;

/** 业务段里的占位泄漏: 机器分级串被去技术化后留下的残片。 */
const PLACEHOLDER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /优先级\s*=\s*(?:[。.;；]|$)/, label: "优先级取值被抹空(优先级=。)" },
  { re: /完整内容\s*[:：]\s*(?:为\s+增加|[。.;；]|$)/, label: "完整内容被去技术化后残缺" },
  { re: /平台梳理出的要点\s*[:：]\s*(?:$|平台自动分级)/, label: "要点段只剩机器分级串" },
  { re: /为\s{2,}(?:增加|补充|修改|删除)/, label: "动作缺少对象(为  增加)" },
];

const TABLE_LABELS: Array<[RegExp, string]> = [
  [/Knowledge/i, "平台知识条目"],
  [/Memory/i, "平台记忆条目"],
  [/Practice/i, "平台实践条目"],
];

export interface DecisionFacts {
  /** 去重后的对象引用, 形如 "平台知识条目 2oaojq"; 未识别到表名时为 "条目 xxxx"。 */
  objects: string[];
  /** 建议动作原文(已去掉机器分级前缀与来源行, 不改写)。 */
  action: string;
  /** 期望结果/验收口径(原文摘录, 最多 3 条)。 */
  expected: string[];
}

function tableLabelNear(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - 48), index);
  let best = "条目";
  let bestPos = -1;
  for (const [re, label] of TABLE_LABELS) {
    const m = before.match(re);
    if (!m || m.index == null) continue;
    if (m.index > bestPos) { bestPos = m.index; best = label; }
  }
  return best;
}

/** 从原始决定文本里抽"对象 / 动作 / 期望"; 纯函数, 不做技术词清洗。 */
export function extractDecisionFacts(decision: string | null | undefined): DecisionFacts {
  const d = String(decision ?? "");
  const seen = new Set<string>();
  const objects: string[] = [];
  SHORT_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SHORT_ID_RE.exec(d)) !== null) {
    const id = m[2];
    // 纯字母串(如 coverage/console)不是条目 ID; 必须含数字, 且不能是常见英文词。
    if (!/[0-9]/.test(id)) continue;
    if (/^(?:p[0-9]+|v[0-9]+|f-[0-9]+)$/i.test(id)) continue;
    const label = tableLabelNear(d, m.index);
    const ref = label + " " + id;
    const key = label + ":" + id;
    if (seen.has(key)) continue;
    seen.add(key);
    objects.push(ref);
    if (objects.length >= 8) break;
  }

  // 动作: 优先取"完整内容:"之后; 去掉"来源:"尾注; 保留原文(含 ID)。
  let action = d;
  const cm = d.match(/完整内容\s*[:：]\s*([\s\S]*)$/);
  if (cm) action = cm[1];
  action = action.split(/\n\s*来源\s*[:：]/)[0].trim();
  // 机器分级前缀只留在技术细节的"原始建议"里, 动作段不重复。
  action = action.replace(/^平台自动分级\s*[:：][^\n]*?\n?/, "").trim();

  const expected: string[] = [];
  const expRe = /(?:期望(?:结果|效果)?|目标|验收(?:标准)?|通过标准)[^。；;\n]{0,140}/g;
  const seenExp = new Set<string>();
  let em: RegExpExecArray | null;
  while ((em = expRe.exec(d)) !== null) {
    const s = em[0].trim();
    if (s.length < 4 || seenExp.has(s)) continue;
    seenExp.add(s);
    expected.push(s);
    if (expected.length >= 3) break;
  }
  return { objects, action: action.slice(0, 1800), expected };
}

/** 把事实渲染成技术细节段的行(调用方负责拼进【技术细节】)。 */
export function renderDecisionFacts(facts: DecisionFacts): string[] {
  const lines: string[] = [];
  if (facts.objects.length) lines.push("- 涉及对象(原样 ID): " + facts.objects.join("; "));
  if (facts.action && facts.action.length >= 12) lines.push("- 建议动作(原文未改写): " + facts.action);
  if (facts.expected.length) lines.push("- 期望结果/验收: " + facts.expected.join(" | "));
  return lines;
}

export interface CardAudit {
  ok: boolean;
  missing: string[];
}

/**
 * 决策卡"可决策"审计:
 *   - 业务段不得出现占位残片;
 *   - ①~⑤ 齐全;
 *   - 技术细节段必须保留"原始建议"或"建议动作", 且对象 ID / 动作 / 期望至少各有其一(期望可缺, 但要在 missing 里显式说明)。
 * 返回 missing 便于巡检/建卡日志直接说清"缺什么", 而不是只给一个 false。
 */
export function auditDecisionCard(title: string, detail: string): CardAudit {
  const t = String(title ?? "");
  const d = String(detail ?? "");
  const missing: string[] = [];
  if (!/^【需您拍板】/.test(t)) missing.push("标题缺少【需您拍板】前缀");
  const biz = d.split(/【技术细节/)[0];
  for (const p of PLACEHOLDER_PATTERNS) if (p.re.test(biz)) missing.push("业务段占位: " + p.label);
  for (const sec of ["①背景", "②要您决定什么", "③选项与各自后果", "④推荐", "⑤不决定的后果"]) {
    if (!biz.includes(sec)) missing.push("缺少章节 " + sec);
  }
  const tech = d.split(/【技术细节/)[1] || "";
  const hasAction = /建议动作|原始建议/.test(tech) || /建议动作|原始建议/.test(d);
  if (!hasAction) missing.push("技术细节段缺少『建议动作/原始建议』(对象与做法无处可查)");
  const hasObject = /[a-z0-9]{6,24}/i.test(tech) && /[0-9]/.test(tech);
  if (!hasObject) missing.push("技术细节段缺少对象 ID(无法定位要处理哪个条目)");
  if (!/期望(?:结果|效果)?|验收(?:标准)?|通过标准/.test(d)) missing.push("缺少期望结果/验收口径");
  return { ok: missing.length === 0, missing };
}
