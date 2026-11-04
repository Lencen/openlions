/**
 * practice-conformance.ts - 把'来自 finding 的 Practice 载荷'判成**一条可复用的做法** (round 72-CQ)。
 *
 * 背景(实测 2026-10-12): CREATE_PRACTICE(execute-improving-task.ts:1062) 把 finding 字段原样写成 Practice:
 *   title <- finding.what / description <- finding.requirement / lesson <- finding.why,
 *   于是存进 Practice 表的是**祈使句的行动指令**。规模: finding 派生 1129(2.0%), 近 7 天 241/742 = 32.5%;
 *   这 241 条 qualityScore **min=中位=max=0.40**(恰为最低通过线), 而 0.40 只来自
 *   'outcome 有值 +0.1' 与 '文本含路径或数字 +0.3' 两条机械触发(quality.ts:94) —— 现有质量分**量不出有没有步骤**。
 *
 * 第一版设计错误(72-CQ 自我纠正, 用 241 条真实数据回放发现):
 *   我最初写的是'**是指令就拒**', 结果两头都错:
 *     - 被判'通过'的样本里, '将三步法沉淀为 Practice...' 与 '新增 practice type=lesson,content=...'
 *       同样是元指令(我的指令正则太窄, 漏了 沉淀为 / 新增 practice(无'条') / 新建 Reflection);
 *     - 被判'拒绝'的样本里, '创建 Practice: 步骤 1 ... 步骤 2 ... 步骤 3 ...' **内嵌的步骤是真的**,
 *       指令外壳是噪声、内容有价值, 却被一刀拒掉。
 *   => 正确做法不是'判它是不是指令', 而是 **先剥离指令外壳、取出内嵌的做法, 再判它有没有步骤**。
 *      这是**确定性提取**(不需要 LLM), 既清掉元指令, 又不丢内容。
 */

/** 前导元指令外壳(用于**剥离**, 不是用于拒绝)。 */
// 2026-10-12 72-CS 修正: 补上 '将<名词>沉淀为 Practice' 这一式 ——
//   实测漏网样本: 「将三步法沉淀为 Practice(theme=luisions端口校验流程)，content 包含：…」
//   先前只认动词紧跟 Practice, 于是外壳没被剥掉(72-CQ 已如实记录该偏差)。
const DIRECTIVE_RE = /^(?:请|将[^，,。;；]{0,16})?\s*(?:创建|新增|新建|补充|补全|重写|完善|扩展|沉淀为|生成|整理为|步骤化记录)\s*\d*\s*条?\s*(?:[Pp]ractice|实践)/;
/** 元指令后面常跟 '(theme=..., scope=...)' 这类括号说明, 一并吃掉。 */
const DIRECTIVE_TAIL_RE = /^\s*\([^)]{0,160}\)\s*[:：]?\s*/;
/** content= / 内容= / 正文= 这类**槽位**(正文常被塞在里面)。 */
const SLOT_RE = /(?:content|内容|正文)\s*[:=：]\s*['“”‘’"]?([\s\S]{8,}?)(?:['“”‘’"]?\s*(?:$|[;；]\s*(?:theme|type|scope)\s*[:=]))/i;
/**
 * 结构性步骤标记 —— **每个独立成一条**, 不用大组合正则。
 * 教训(72-CQ): 我先前把 7 种标记写成一条大正则, 结果 `1) ...` 这种行内编号**不匹配**,
 *   而把同一条片段单独拿出来测却是 true; 于是拆成数组, 每个都能被单独验证。
 */
const STEP_MARKERS: RegExp[] = [
  /步骤\s*[一二三四五六七八九十\d]/,        // 步骤 1 / 步骤一
  /第\s*[一二三四五六七八九十\d]\s*步/,      // 第 2 步
  /\bSTEP\s*\d/i,                          // STEP 1
  /[\u2460-\u2468]/,                         // ①②③
  /\(\d{1,2}\)\s*\S/,                       // (1) 做X
  /(?:^|[\s,，;；(（])\d{1,2}[).、]\s*\S/m,   // 1) 做X / 1. 做X / 1、做X
  /→|->/,                                    // 箭头流程
  // 2026-10-12 72-CS 新增: **命令序列**(用 '' / '' 分隔的多条命令)。
  //   修的是 72-CQ 如实记下的一处误杀: 「步骤化记录 sqlite3 .dump / export sessions / re-import / PRAGMA 验证命令」
  //   内容是真命令序列, 却因无编号被拒。
  //   为什么要求**斜杠两侧有空白**: 路径(packages/apps/mind/src)也是斜杠分隔, 若只数斜杠会
  //   让"文本里含路径"就通过, 等于把闸门关掉 —— 那正是现有质量分(含路径 +0.3)失效的原因。
  //   ⚠ 72-CS 第一版写成 (?:s/s){2,} —— **错**: {2,} 要求两次「 / 」**相邻**,
  //     而真实样本是 'sqlite3 .dump / export sessions / re-import' —— 中间隔着内容。
  //     改为「同一行内两次 / 且间隔有界(<=80 字符)」。
  /\s\/\s[^\n]{0,80}?\s\/\s/,
];

/** 剥掉前导元指令外壳, 得到候选'做法正文'。 */
export function stripDirective(s: string): string {
  let out = String(s || "").trim();
  const before = out;
  out = out.replace(DIRECTIVE_RE, "");
  if (out !== before) out = out.replace(DIRECTIVE_TAIL_RE, "");
  return out.replace(/^[：:；;，,\s]+/, "").trim();
}

/** 取出候选'做法正文': 优先 content 槽位, 否则剥外壳。 */
export function extractProcedure(title: string, description: string): string {
  const raw = String(description || "").trim() || String(title || "").trim();
  if (!raw) return "";
  const m = SLOT_RE.exec(raw);
  if (m && m[1] && m[1].trim().length >= 8) return stripDirective(m[1].trim());
  return stripDirective(raw);
}

/** 取出的正文里是否有**结构性**步骤(仅'提到步骤'不算)。 */
export function looksLikeSteps(text: string): boolean {
  const t = String(text || "");
  return STEP_MARKERS.some((re) => re.test(t));
}

export interface ConformanceVerdict {
  ok: boolean;
  /** 剥离外壳后取到的正文(便于审计'到底打算落什么') */
  procedure: string;
  reasons: string[];
}

export function practiceConformance(title: string, description: string): ConformanceVerdict {
  const procedure = extractProcedure(title, description);
  const reasons: string[] = [];
  if (!String(description || "").trim()) reasons.push("description 为空");
  if (!procedure) reasons.push("剥离指令外壳后无可落内容");
  else if (!looksLikeSteps(procedure)) reasons.push("无可辨识步骤结构(取出的正文里没有编号/步骤标记)");
  return { ok: reasons.length === 0, procedure: procedure.slice(0, 300), reasons };
}

export const __patterns = { DIRECTIVE_RE, DIRECTIVE_TAIL_RE, SLOT_RE, STEP_MARKERS };
