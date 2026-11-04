
/**
 * @lions/product-contract -- product-table controlled vocabularies + pure projection functions
 *   (single source of truth, 2026-10-08 round 55).
 *
 * Consumed by: mind pipeline (enum-projection.ts re-exports), module stores (memory/knowledge/practice),
 *   scripts (CJS via require of ./vocab.json).
 * The vocabulary data lives in ./vocab.json (read at build/load time via JSON import).
 *
 * IMPORTANT: this module is intentionally pure (no DB / no side effects) so it can be imported
 *   safely from anywhere (scripts, modules, mind app) and is trivial to test in isolation.
 */
import vocab from "./vocab.json";

export const DOMAINS = vocab.domains as readonly string[];
export const CATEGORY_CONTRACT = vocab.categoryContract as readonly string[];
export const CATEGORY_MARKERS = vocab.categoryMarkers as readonly string[];
export const CATEGORY_REFLECTION_EXTRAS = vocab.categoryReflectionExtras as readonly string[];
export const CATEGORY_SKILL_EXTRAS = vocab.categorySkillExtras as readonly string[];
export const CATEGORY_FALLBACK = vocab.categoryFallback as string;
export const PRACTICE_OUTCOMES = vocab.practiceOutcomes as readonly string[];
export const PRACTICE_OUTCOME_FALLBACK = vocab.practiceOutcomeFallback as string;
export const PRACTICE_OUTCOME_SYNONYMS: Record<string, string> = vocab.practiceOutcomeSynonyms;
export const PRACTICE_TYPES = vocab.practiceTypes as readonly string[];
export const MEMORY_TYPES = vocab.memoryTypes as readonly string[];
export const TIERS = vocab.tiers as readonly string[];
export const DOMAIN_CATEGORY_MAP: Record<string, string> = vocab.domainCategoryMap;
export const DOMAIN_ALIASES: Record<string, string> = vocab.domainAliases;
export const CATEGORY_ALIASES: Record<string, string> = vocab.categoryAliases;

/** size/case/whitespace normalized; null/empty -> null */
export function projectDomain(raw: unknown, _ctx?: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if ((DOMAINS as readonly string[]).includes(s)) return s;
  if ((DOMAINS as readonly string[]).includes(up)) return up;
  if (DOMAIN_ALIASES[s]) return DOMAIN_ALIASES[s];
  if (DOMAIN_ALIASES[up]) return DOMAIN_ALIASES[up];
  return DOMAIN_CATEGORY_MAP[up] || null;
}

export function allowedCategories(kind: "knowledge" | "skill"): string[] {
  if (kind === "skill") return [...CATEGORY_CONTRACT, ...CATEGORY_MARKERS, ...CATEGORY_REFLECTION_EXTRAS, ...CATEGORY_SKILL_EXTRAS];
  return [...CATEGORY_CONTRACT, ...CATEGORY_MARKERS, ...CATEGORY_REFLECTION_EXTRAS];
}

/** category projection: alias -> uppercase -> allowed set -> else FALLBACK; null/empty -> null */
export function projectCategory(raw: unknown, kind: "knowledge" | "skill"): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (CATEGORY_ALIASES[s]) return CATEGORY_ALIASES[s];
  const up = s.toUpperCase();
  if (CATEGORY_ALIASES[up]) return CATEGORY_ALIASES[up];
  return allowedCategories(kind).includes(up) ? up : CATEGORY_FALLBACK;
}

export function projectPracticeOutcome(raw: unknown): string {
  if (raw === null || raw === undefined) return PRACTICE_OUTCOME_FALLBACK;
  const s = String(raw);
  const up = s.trim().toUpperCase();
  if (!up) return PRACTICE_OUTCOME_FALLBACK;
  if ((PRACTICE_OUTCOMES as readonly string[]).includes(up)) return up;
  return PRACTICE_OUTCOME_SYNONYMS[up] || PRACTICE_OUTCOME_FALLBACK;
}

/** identifier-style normalization (type/tier), case+whitespace only */
export function normalizeEnumToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.toUpperCase();
}

// 质量分天平 (round 56a) re-export
export {
  calcQualityScore, calcMemoryQuality, calcKnowledgeQuality, calcReflectionQuality, calcPracticeQuality, calcSkillQuality,
  STANDARD_THEMES, STANDARD_LEVELS,
} from "./quality";

// ===========================================================================================
// 标题/名字合规归一 (2026-10-08 round 58, 人类批准)
// -------------------------------------------------------------------------------------------
// 业务前提: 实测近 30 天 28% 的飞轮产物标题(或技能名)超长(Knowledge 33.9%% / Practice 31.3%% / Memory 17.3%% /
//   Skill 名 44.2%%); 规则早已写进生成端 prompt 却仍违规 -> "请求层约束"不可靠, 必须在**出口**把格式变成保证.
//   旧逻辑对超长标题是"拒绝"(静默丢行), 与同文件内"截断到 30"自相矛盾; 且机械从右往左切会砍掉中文标题里
//   信息最密集的句尾结论(实测样例: 反思: worktree pre-commit 拦截预先漂移须报方案 -> 反思: worktree pre-commit).
//
// 本函数(纯函数/确定性/可复算): 去空白 -> 去模板前缀 -> 合规直通 -> 超长则"保头保尾"压缩(保主语+保结论).
// ===========================================================================================
export const TITLE_MAX = 30;
export const SKILL_NAME_MAX = 20;
const ELLIPSIS = "…";
const TEMPLATE_PREFIXES = [
  "[反思]", "反思:", "反思：", "[实践]", "实践:", "实践：", "[知识]", "知识:", "知识：",
  "[技能]", "技能:", "技能：", "[Practice]", "Practice:", "[Knowledge]", "Knowledge:", "[Memory]", "Memory:",
];
const BREAK_CHARS = " :：,，、。;；)）（(/·-—|";
/** 收尾时必须去掉的"悬空连接符" —— 实测 headCut 会产出 "Next.js 14 + tRPC +" 这种尾巴。 */
const TRAILING_SEP = " :：,，、。;；)）（(/·-—|+&*=~*<>" + '"' + "'";
const SPACE = " ";
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const CR = String.fromCharCode(13);

/** 折叠空白(空格/制表/换行); 不做任何其它改动 */
function collapseSpaces(s: string): string {
  const out: string[] = [];
  let prevSpace = false;
  for (const ch of s) {
    const isSpace = ch === SPACE || ch === TAB || ch === NEWLINE || ch === CR;
    if (isSpace) {
      if (!prevSpace && out.length > 0) out.push(SPACE);
      prevSpace = true;
    } else {
      out.push(ch);
      prevSpace = false;
    }
  }
  let r = out.join("");
  while (r.endsWith(SPACE)) r = r.slice(0, -1);
  return r;
}

/** 去掉模板前缀(反思:/[反思] 等) —— 仅当剩余仍有 >=4 字 */
function stripTemplatePrefix(s: string): string {
  for (const p of TEMPLATE_PREFIXES) {
    if (s.startsWith(p)) {
      const rest = s.slice(p.length).trim();
      if (rest.length >= 4) return rest;
    }
  }
  return s;
}

/**
 * 保头保尾压缩(**尾部优先 + 按断点分段**):
 *   1) 按断点(空格/标点)把标题切成段;
 *   2) 从**末尾往前累积**段, 直到接近 tail 预算 —— 尾部恒为完整的词/小句(不会切半个词);
 *   3) 头部用剩余额度, 并从右往最近的断点收尾.
 * 实测依据: 中文标题结论在句尾; 英文技术名不能被切半(register -> gister 是首版实测踩到的坑).
 */
function splitSegments(s: string): string[] {
  const segs: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (BREAK_CHARS.includes(ch)) {
      if (cur) { segs.push(cur); cur = ""; }
      segs.push(ch);
    } else {
      cur += ch;
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

function smartCut(s: string, max: number): string {
  const tailBudget = Math.max(6, Math.floor(max * 0.45));
  const segs = splitSegments(s);
  let tail = "";
  for (let i = segs.length - 1; i >= 0; i--) {
    const cand = segs[i] + tail;
    if (tail.length > 0 && cand.trim().length > tailBudget) break;
    tail = cand;
  }
  while (tail.length > 0 && BREAK_CHARS.includes(tail[0])) tail = tail.slice(1);
  while (tail.length > 0 && BREAK_CHARS.includes(tail[tail.length - 1])) tail = tail.slice(0, tail.length - 1);
  if (tail.length > tailBudget) tail = tail.slice(tail.length - tailBudget);
  const headBudget = Math.max(6, max - 1 - tail.length);
  let head = s.slice(0, Math.max(0, s.length - tail.length - 1));
  if (head.length > headBudget) {
    head = head.slice(0, headBudget);
    for (let i = head.length - 1; i >= Math.max(3, head.length - 8); i--) {
      if (BREAK_CHARS.includes(head[i])) { head = head.slice(0, i); break; }
    }
  }
  const out = head.trim() + ELLIPSIS + tail;
  return out.length <= max ? out : out.slice(0, max);
}


/**
 * 归一标题/名字到 <= max 字(默认 30; 技能名传 20).
 * null/空输入 -> null(调用方按字段可空性处理); 非空输入**永远返回合规值**(不再有"拒绝").
 */
export function normalizeProductTitle(raw: unknown, opts?: { max?: number }): string | null {
  if (raw === null || raw === undefined) return null;
  const max = (opts && opts.max) || TITLE_MAX;
  let t = collapseSpaces(String(raw));
  if (!t) return null;
  if (t.length <= max) return t;
  const stripped = stripTemplatePrefix(t);
  if (stripped.length >= 4) t = stripped;
  if (t.length <= max) return t;
  return smartCut(t, max);
}

// =====================================================================================
// 2026-10-09 round 70: Skill 名称/摘要/标签 三件套契约 (人类裁决)
//
// 人类口径(原话): "技能名称要简写, 不能有长名, **名称不能有省略**"; "技能要加标签";
//   "技能摘要或者简要说明也需要加一个"; 用途是 "通过名称, 摘要, 标签快速确认技能的匹配,
//   匹配到的再看技能详情确认是否与当前工作匹配"。
//
// 为什么需要单独的函数(不能复用 normalizeProductTitle):
//   ① 标题的"保头保尾压缩"会**插入省略号** `头…尾` —— 人类明确否决了技能名带省略;
//   ② 标题压缩是**尾部优先**(中文标题结论在句尾), 而技能名是**指代**, 主语在前 -> 必须头部优先;
//   ③ 技能名是检索入口, 截断后在前面留下的信息量最大才有意义。
// 因此技能名走"**永不出省略号**"的独立路径: 先语义剥离(模板前缀/括号补充), 再头部断点截断。
// =====================================================================================

/** 技能摘要上限(字)。摘要用于"列表页快速判断要不要展开", 不是详情。 */
export const SKILL_SUMMARY_MAX = 80;
/** 单个标签上限(字)。 */
export const SKILL_TAG_MAX = 12;
/** 一个技能最多保留的标签数。 */
export const SKILL_TAGS_MAX = 8;

const UNDERSCORE = "_";
const ELLIPSIS_LIKE = new RegExp("[\u2026]|\\.\\.\\.", "g");

/** 去掉所有省略号形态(… / ...) —— 技能名不得带省略; 直接删字符会让前后粘连, 故换成空格。 */
function stripEllipsisLike(s: string): string {
  return collapseSpaces(s.replace(ELLIPSIS_LIKE, SPACE));
}

/** 去掉成对括号里的补充说明(中英文), 括号本身与内容一起删 —— 技能名要短, 补充信息属于摘要。 */
function stripAsides(s: string): string {
  let out = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(" || ch === "（" || ch === "[") { depth++; continue; }
    if (ch === ")" || ch === "）" || ch === "]") { if (depth > 0) depth--; continue; }
    if (depth === 0) out += ch;
  }
  return collapseSpaces(out);
}

/** 头部优先截断: 按断点从左累积到不超过 max; 收尾去掉悬空的断点字符。 */
function headCut(s: string, max: number): string {
  const segs = splitSegments(s);
  let out = "";
  for (const seg of segs) {
    if ((out + seg).trim().length > max) break;
    out += seg;
  }
  const trimTail = (x: string) => {
    let r = x.trim();
    while (r.length > 0 && TRAILING_SEP.includes(r[r.length - 1])) r = r.slice(0, -1).trim();
    return r;
  };
  out = trimTail(out);
  if (out.length > 0) return out;
  // 全是长段落(无断点可切) -> 硬截, 但仍要清理尾部标点
  return trimTail(s.slice(0, max));
}

/**
 * 归一**技能名**: 永不含省略号; **默认不做有损截断**(见下), 只在 `lossy:true` 时截断。
 *
 * 顺序: 折空白 -> 去省略号 -> 去模板前缀 -> 去括号补充 -> 长度已合规则返回。
 *   `lossy:false`(默认): 到此为止。做不到 <=max 就**原样返回净化后的名字**(可能仍超长) —— 让调用方
 *     去走语义压缩(LLM)或入待处理队列, 而不是硬截。
 *   `lossy:true`: 继续头部断点截断, 保证 <=max。
 *
 * **为什么默认不截断(2026-10-09 round 70 实测, 这是本轮最重要的一个结论)**:
 *   对 859 条超长技能名做头部断点截断, 结果把 **441 行塌缩成 117 个名字**, 而且塌得离谱:
 *     'Prisma schema设计与migration' / 'Prisma ORM与DateTime处理' / 'Prisma $queryRawUnsafe'
 *        -> 全部变成 "Prisma"
 *     'Next.js App Router Server Component' / 'Next.js App Router SSR 注水…' / '…webpack RSC chunk 调试'
 *        -> 全部变成 "Next.js App Router"
 *   这些是**不同的技能**, 只是前缀相同。而本平台的去重判据是"同名即同技能" —— 一旦截断结果被写进库,
 *   下一次写入就会**据此把不同技能合并掉**。所以: **确定性截断不能作为技能名的来源**,
 *   短技能名必须靠**语义压缩(LLM)**; 确定性路径只负责"净化 + 不产省略号 + 不制造假同名"。
 */
export function normalizeSkillName(raw: unknown, opts?: { max?: number; lossy?: boolean }): string | null {
  if (raw === null || raw === undefined) return null;
  const max = (opts && opts.max) || SKILL_NAME_MAX;
  const lossy = !!(opts && opts.lossy);
  let t = stripEllipsisLike(collapseSpaces(String(raw)));
  if (!t) return null;

  // ① 模板前缀**无条件**剥离: "反思:" / "[Practice]" 这类是流水线噪音, 不是名字的一部分。
  //    (与标题归一不同 —— 标题对合规输入**一律不动**, 因为标题可能是原文标题; 技能名是标识符, 该干净。)
  const strippedPrefix = stripTemplatePrefix(t);
  if (strippedPrefix.length >= 4) t = strippedPrefix;
  if (t.length <= max) return t;

  // ② 括号补充只在**超长时**才剥离 —— 短名里的补充信息(如 "端口占用诊断（含 Windows）")是有用的,
  //    而它属于"可放摘要"的内容, 只在需要腾长度时才牺牲。
  const noAside = stripAsides(t);
  if (noAside.length >= 4 && noAside.length < t.length) t = noAside;
  if (t.length <= max) return t;

  if (!lossy) return t; // 净化后仍超长 -> 交调用方做语义压缩, 不硬截

  const cut = headCut(t, max);
  if (cut.length > 0 && cut.length <= max) return cut;
  const hard = stripEllipsisLike(t.slice(0, max));
  return hard.length > 0 ? hard : null;
}

/**
 * 判断某次归一**是否发生了有损压缩**(供写入侧决定要不要写"待语义命名"标记)。
 * `true` = 结果比原值短且原值超长 -> 名字信息有丢失, 不该据此判定"同名即同技能"。
 */
export function isSkillNameCompressionLossy(raw: unknown, opts?: { max?: number }): boolean {
  if (raw === null || raw === undefined) return false;
  const max = (opts && opts.max) || SKILL_NAME_MAX;
  const src = collapseSpaces(String(raw));
  if (src.length <= max) return false;
  const out = normalizeSkillName(raw, { max, lossy: true });
  return !!out && out.length < src.length;
}

/** 归一**技能摘要**: 折空白、去省略号、<= SKILL_SUMMARY_MAX; 超长按断点收尾(不追加省略号)。 */
export function normalizeSkillSummary(raw: unknown, opts?: { max?: number }): string | null {
  if (raw === null || raw === undefined) return null;
  const max = (opts && opts.max) || SKILL_SUMMARY_MAX;
  const t = stripEllipsisLike(collapseSpaces(String(raw)));
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = headCut(t, max);
  return cut.length > 0 ? cut : t.slice(0, max);
}

/**
 * 归一**技能标签**: 接受 string[] 或 "a,b、c | d" 形态; 去 # 前缀、去空、去重(不分大小写)、
 * 每个 <= SKILL_TAG_MAX、最多 SKILL_TAGS_MAX 个; 返回**规范化数组**(调用方自行 JSON.stringify 落库)。
 */
export function normalizeSkillTags(raw: unknown, opts?: { maxTags?: number; maxLen?: number }): string[] {
  if (raw === null || raw === undefined) return [];
  const maxTags = (opts && opts.maxTags) || SKILL_TAGS_MAX;
  const maxLen = (opts && opts.maxLen) || SKILL_TAG_MAX;
  const parts: string[] = Array.isArray(raw)
    ? raw.map((x) => String(x))
    : String(raw).split(/[,，、;；|/\n]/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let p of parts) {
    p = collapseSpaces(String(p)).trim();
    while (p.startsWith("#")) p = p.slice(1).trim();
    while (p.length > 0 && BREAK_CHARS.includes(p[p.length - 1])) p = p.slice(0, -1);
    if (!p) continue;
    if (p.length > maxLen) p = headCut(p, maxLen);
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= maxTags) break;
  }
  return out;
}


// =====================================================================================
// 2026-10-09 round 72-D: 认知表"完备性"判定 (人类裁决的定义 → 可判定的检查函数)
//
// 背景: 人类对 4 张表给了明确定义, 但这些定义**从来没有变成生成时的闸** ——
//   实测后果: Memory 的 scenario 填充率 0% / summary 37%; Knowledge 近 7 天新增里
//   只有 0.2% 含 markdown 结构; Practice 没有 lesson 字段(本轮才加)。
//   Skill 那边已经证明过"闸有效": 加 SKILL_STEPS_MIN 之后新写入 steps 覆盖 99.8%。
//
// 设计原则(踩过的坑):
//   ① 判定必须是**纯函数**(可单测、无 IO) —— hook 层只放纯函数是本平台的既定教训;
//   ② 阈值必须**宽松**(宁放过可疑, 不误杀合格) —— 因为生产者还没全部升级,
//      过严的闸会让整条产线停摆(Memory 若强制 scenario, 当前会拒 100%);
//   ③ 观察/强制两档: 先 observe(只记事件), 生产者修完再 enforce —— 见 GOOGATE_MODE。
// =====================================================================================

/** 闸的工作模式: observe=只记不拦; enforce=真拦(不落库) */
export type CognitiveGateMode = "observe" | "enforce";

export interface GateVerdict {
  ok: boolean;
  /** 缺什么(ok=false 时列出, 供调用方记事件/回填) */
  missing: string[];
  /** 人类可读原因(用于日志) */
  reason: string;
}

/**
 * Memory 完备性 —— 人类定义: "做过的事/经验, 记事实: 什么时间做了什么事, 输出了哪些内容, 可在哪找回"。
 *   硬性项: content(做了什么) + title(一句话) + sourceId(在哪找回)。
 *   结构化项(人类补充要求): summary(摘要) **或** scenario(适用场景) 至少有一个。
 *   注: summary/scenario 是"二选一"而不是"都要" —— 短经验可能只需要一句场景说明, 不应强求两者齐全。
 */
export function checkMemoryCompleteness(data: {
  content?: unknown; title?: unknown; sourceId?: unknown;
  summary?: unknown; scenario?: unknown;
}): GateVerdict {
  const missing: string[] = [];
  const s = (v: unknown) => (v == null ? "" : String(v).trim());
  if (!s(data.content)) missing.push("content");
  if (!s(data.title)) missing.push("title");
  if (!s(data.sourceId)) missing.push("sourceId");
  const hasSummary = !!s(data.summary);
  const hasScenario = !!s(data.scenario);
  if (!hasSummary && !hasScenario) missing.push("summary|scenario");
  const ok = missing.length === 0;
  return { ok, missing, reason: ok ? "memory 完备" : "memory 缺: " + missing.join(",") };
}

/**
 * Knowledge 结构化 —— 人类定义: "知识本身内容应该是结构化的 ... 与知识之间应该是网状关联的"。
 *   硬性项: content 非空 + 至少一个 markdown 结构标记(标题/列表/编号)。
 *   为什么只要求"至少一个结构标记": 实测当前 90% 的 Knowledge 完全没有结构,
 *     若要求"必须有 ## 标题"会拒掉大部分; 先用最宽松的判据(任一标记)把习惯改过来。
 *   网状关联(mapId/relation)不在本闸 —— 那是**独立能力**(见 round 72-D 计划 P1), 未实现前不能作为落库前提。
 */
export function checkKnowledgeStructure(data: { content?: unknown }): GateVerdict {
  const c = data.content == null ? "" : String(data.content).trim();
  if (!c) return { ok: false, missing: ["content"], reason: "knowledge 内容为空" };
  const hasHeading = /(^|\n)#{1,6}\s+\S/.test(c);
  const hasList = /(^|\n)\s*(?:[-*+]\s+\S|\d+[.、)]\s+\S)/.test(c);
  const hasTable = /(^|\n)\s*\|.*\|/.test(c);
  if (!hasHeading && !hasList && !hasTable) {
    return { ok: false, missing: ["structure"], reason: "knowledge 无结构标记(标题/列表/表格任一)" };
  }
  return { ok: true, missing: [], reason: "knowledge 有结构" };
}

/**
 * Practice 完备性 —— 人类定义: "记录做过的事情 + 总结: 时间/任务/背景场景/应用了什么知识与技能/
 *   结果成功失败/原因/证实了什么/经验与教训"。
 *   硬性项: title + outcome + lesson。
 *   lesson 阈值 20 字: 人类要的是"总结", 5 个字的"顺利"不算总结 —— 但也不能太长(≤20 就放过)。
 */
export function checkPracticeCompleteness(data: {
  title?: unknown; outcome?: unknown; lesson?: unknown;
}): GateVerdict {
  const missing: string[] = [];
  const s = (v: unknown) => (v == null ? "" : String(v).trim());
  if (!s(data.title)) missing.push("title");
  if (!s(data.outcome)) missing.push("outcome");
  if (s(data.lesson).length < 20) missing.push("lesson(>=20字)");
  const ok = missing.length === 0;
  return { ok, missing, reason: ok ? "practice 完备" : "practice 缺: " + missing.join(",") };
}

/** 闸模式读取(env 可覆盖; 默认 observe —— 生产者升级期间只观察不拦) */
export function cognitiveGateMode(): CognitiveGateMode {
  const v = String((typeof process !== "undefined" && process.env && process.env.COGNITIVE_GATE_MODE) || "observe").toLowerCase();
  return v === "enforce" ? "enforce" : "observe";
}

// =====================================================================================
// 2026-10-09 round 72-D 遗留项: Knowledge 网状关联抽取 (纯函数地基)
// -----------------------------------------------------------------------------------
// 出处: checkKnowledgeStructure 注释 413 行自述「网状关联(mapId/relation)不在本闸 ——
//   那是**独立能力**(见 round 72-D 计划 P1)」。本条遗留即补这个独立能力的地基。
//
// 现状(实测, 见 dev.db): Knowledge 全表无 entity/relation 字段, KnowledgeRelation 仅 60 行,
//   KnowledgeEntity 仅 21 行 —— 即"网状关联"实际是空的; 生成端没有任何确定性抽取。
//   knowledge-graph.ts 里已有的 extractRelations() 用 `Math.random() > 0.7` 造边, 不可复算、
//   不可测试、每次结果不同 —— 这正是要找纯函数替换的原因。
//
// 本函数(纯函数/确定性/无 IO/可单测):
//   输入一条 Knowledge(title/content/tags) + 可选 peers(兄弟文档标签集), 输出**候选**关系:
//   ① heading:     regex 抽 `##`~`######` 小标题 -> (文档 PART_OF 标题)
//   ② md-link:     markdown 内链 `[text](href)` (仅内链, 排除 http/https/mailto//) -> RELATED_TO;
//                  `#anchor` 且能对上小标题时升级为 PART_OF
//   ③ tag:         文档自带标签 -> (文档 RELATED_TO 标签)
//   ④ tag-overlap: 与 peers 的标签重叠比 >= 阈值 -> (文档 SIMILAR_TO 兄弟文档)
//
// **不接 enforce**: 与认知闸同一条铁律(observe -> enforce) —— 当前 90% Knowledge 无结构,
//   抽取命中率必然低, 直接把"有关联"作为落库前提会停摆产线。本函数只产出候选 + 统计口径,
//   observe 日志行由 knowledgeRelationObserveLine() 统一给出 `[cognitive-gate/relation] missing=N/total=M`。
// =====================================================================================

/** KnowledgeRelation.relationType 的受控取值(与 prisma schema 注释一致) */
export type KnowledgeRelationType = "IS_A" | "PART_OF" | "USES" | "DEPENDS_ON" | "SIMILAR_TO" | "RELATED_TO";
export const KNOWLEDGE_RELATION_TYPES: readonly KnowledgeRelationType[] =
  ["IS_A", "PART_OF", "USES", "DEPENDS_ON", "SIMILAR_TO", "RELATED_TO"];

/** 候选边来自哪条抽取规则(用于 observe 归因: 该先修哪种结构) */
export type KnowledgeRelationRule = "heading" | "md-link" | "tag" | "tag-overlap";
export const KNOWLEDGE_RELATION_RULES: readonly KnowledgeRelationRule[] = ["heading", "md-link", "tag", "tag-overlap"];

/** 单条候选关系(不是最终落库行 —— source/target 是**名字**, 落库前需映射到 KnowledgeEntity.id) */
export interface KnowledgeRelationCandidate {
  source: string;
  target: string;
  type: KnowledgeRelationType;
  /** 0-1; 显式内链 0.9 > 标签 0.6 > 结构包含 0.5; tag-overlap 用实际重叠比 */
  weight: number;
  rule: KnowledgeRelationRule;
  /** 可复算证据(命中的原文片段 / 共享标签), 便于人工核验 */
  evidence: string;
}

/** tag-overlap 规则的兄弟文档(只需 title + tags, 不引入数据库类型) */
export interface KnowledgeRelationPeer {
  title?: unknown;
  tags?: unknown;
}

export interface ExtractKnowledgeRelationsOptions {
  /** 兄弟文档标签集; 不传则跳过 tag-overlap 规则(其余三条规则仍可用) */
  peers?: KnowledgeRelationPeer[];
  /** 标签重叠比阈值(重叠系数 = |A∩B| / min(|A|,|B|)); 默认与"重叠>=50%应合并"的业务口径对齐 */
  tagOverlapMin?: number;
  /** 单文档候选边上限(防爆量); 默认 50 */
  maxCandidates?: number;
}

export interface KnowledgeRelationStats {
  headings: number;
  links: number;
  tags: number;
  /** 一条候选都没产出 (= observe 日志 missing 的口径) */
  missing: boolean;
  byRule: Record<KnowledgeRelationRule, number>;
}

export interface KnowledgeRelationExtraction {
  /** 归一后的文档节点名; title 为空时为 null */
  node: string | null;
  candidates: KnowledgeRelationCandidate[];
  stats: KnowledgeRelationStats;
}

export const KNOWLEDGE_RELATION_TAG_OVERLAP_MIN = 0.5;
export const KNOWLEDGE_RELATION_MAX = 50;
const UNTITLED_NODE = "(untitled)";

/** 节点名归一: 折空白 -> 去首尾 #/`/引号 -> 去尾部连接符。**不做截断**(标题是节点标识, 截断会撞名) */
function cleanRelationNode(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  let s = collapseSpaces(String(raw)).trim();
  while (s.startsWith("#")) s = s.slice(1).trim();
  while (s.length > 0 && (s.startsWith("`") || s.startsWith('"') || s.startsWith("'"))) s = s.slice(1);
  while (s.length > 0 && (s.endsWith("`") || s.endsWith('"') || s.endsWith("'"))) s = s.slice(0, -1);
  s = s.trim();
  while (s.length > 0 && (s.endsWith(":") || s.endsWith("：") || s.endsWith("。") || s.endsWith("."))) s = s.slice(0, -1);
  return s.trim();
}

/** 标签拆分: 逗号(中英)/顿号/分号/竖线/斜杠/换行; 去 # 前缀; 大小写不敏感去重; 上限 32 */
export function splitKnowledgeTags(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  const src = Array.isArray(raw) ? raw.map((x) => String(x)).join(",") : String(raw);
  if (!src.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let p of src.split(/[,，、;；|/\n]/)) {
    p = collapseSpaces(p).trim();
    while (p.startsWith("#")) p = p.slice(1).trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= 32) break;
  }
  return out;
}

/** markdown 小标题: `##`~`######` (H1 视为文档标题, 不计入子节点) */
export function extractKnowledgeHeadings(content: unknown): Array<{ text: string; level: number; evidence: string }> {
  const c = content == null ? "" : String(content);
  const out: Array<{ text: string; level: number; evidence: string }> = [];
  const re = /(^|\n)(#{2,6})[ \t]+([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c)) !== null) {
    let text = cleanRelationNode(m[3]);
    if (!text) continue;
    out.push({ text, level: m[2].length, evidence: `${m[2]} ${m[3].trim()}` });
  }
  return out;
}

/** markdown 内链: 仅相对路径/anchor 算内链(排除 scheme:// 与 // 协议相对) */
export function extractKnowledgeLinks(content: unknown): Array<{ text: string; href: string; anchor: string; evidence: string }> {
  const c = content == null ? "" : String(content);
  const out: Array<{ text: string; href: string; anchor: string; evidence: string }> = [];
  const re = /\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c)) !== null) {
    const href = m[2].trim();
    if (!href) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue; // http(s)/mailto/... 算外链
    const anchorMatch = /#([^#\s]*)$/.exec(href);
    out.push({
      text: cleanRelationNode(m[1]),
      href,
      anchor: anchorMatch ? anchorMatch[1] : "",
      evidence: m[0],
    });
  }
  return out;
}

/** decodeURIComponent 的安全包装(非法百分号编码不应抛异常打断纯函数) */
function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 标题/文本 -> anchor slug(与常见 markdown 实现对齐: 小写, 空白转 -, 去标点) */
export function knowledgeHeadingSlug(raw: unknown): string {
  return collapseSpaces(String(raw == null ? "" : raw))
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 标签重叠比 = |A∩B| / min(|A|,|B|) (重叠系数; 任一为空 -> 0) */
export function knowledgeTagOverlap(a: readonly string[], b: readonly string[]): { ratio: number; shared: string[] } {
  const sa = new Set(a.map((x) => x.toLowerCase()));
  const sb = new Set(b.map((x) => x.toLowerCase()));
  if (sa.size === 0 || sb.size === 0) return { ratio: 0, shared: [] };
  const shared: string[] = [];
  for (const t of sa) if (sb.has(t)) shared.push(t);
  shared.sort();
  const min = Math.min(sa.size, sb.size);
  return { ratio: min === 0 ? 0 : shared.length / min, shared };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * 从一条 Knowledge 抽候选关系(确定性: 无随机、无 IO、同输入同输出)。
 * 注意: 返回的是**候选**, 不构成落库前提(observe 阶段只统计)。
 */
export function extractKnowledgeRelations(
  input: { title?: unknown; content?: unknown; tags?: unknown },
  opts: ExtractKnowledgeRelationsOptions = {},
): KnowledgeRelationExtraction {
  const nodeName = cleanRelationNode(input.title);
  const node = nodeName || UNTITLED_NODE;
  const ownTags = splitKnowledgeTags(input.tags);
  const maxCandidates = Number.isFinite(opts.maxCandidates as number) && (opts.maxCandidates as number) > 0
    ? Math.floor(opts.maxCandidates as number)
    : KNOWLEDGE_RELATION_MAX;
  const overlapMin = Number.isFinite(opts.tagOverlapMin as number) && (opts.tagOverlapMin as number) >= 0
    ? (opts.tagOverlapMin as number)
    : KNOWLEDGE_RELATION_TAG_OVERLAP_MIN;

  const headings = extractKnowledgeHeadings(input.content);
  const links = extractKnowledgeLinks(input.content);
  const slugToHeading = new Map<string, string>();
  for (const h of headings) {
    const slug = knowledgeHeadingSlug(h.text);
    if (slug && !slugToHeading.has(slug)) slugToHeading.set(slug, h.text);
  }

  const candidates: KnowledgeRelationCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: KnowledgeRelationCandidate) => {
    if (!c.source || !c.target) return;
    if (c.source.toLowerCase() === c.target.toLowerCase()) return;
    const key = `${c.source.toLowerCase()}\u0000${c.target.toLowerCase()}\u0000${c.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ ...c, weight: round3(c.weight) });
  };

  // ① 小标题 -> PART_OF 文档
  for (const h of headings) {
    push({ source: node, target: h.text, type: "PART_OF", weight: 0.5, rule: "heading", evidence: h.evidence });
  }

  // ② markdown 内链 -> RELATED_TO(#anchor 能对上小标题则 PART_OF)
  for (const l of links) {
    const anchored = l.anchor ? slugToHeading.get(knowledgeHeadingSlug(l.anchor)) : undefined;
    // anchor 未命中时用 anchor 文本作节点名(比链接文字更精确指向"那一节"), 再退回链接文字/href
    const target = anchored || (l.anchor ? cleanRelationNode(safeDecodeURIComponent(l.anchor)) : "") || l.text || l.href;
    push({
      source: node,
      target,
      type: anchored ? "PART_OF" : "RELATED_TO",
      weight: 0.9,
      rule: "md-link",
      evidence: l.evidence,
    });
  }

  // ③ 标签 -> 文档 RELATED_TO 标签
  for (const t of ownTags) {
    push({ source: node, target: t, type: "RELATED_TO", weight: 0.6, rule: "tag", evidence: `tag:${t}` });
  }

  // ④ 标签重叠 -> 文档 SIMILAR_TO 兄弟文档
  for (const peer of opts.peers || []) {
    const peerName = cleanRelationNode(peer && peer.title);
    if (!peerName) continue;
    const peerTags = splitKnowledgeTags(peer && peer.tags);
    const { ratio, shared } = knowledgeTagOverlap(ownTags, peerTags);
    if (ratio < overlapMin || shared.length === 0) continue;
    push({
      source: node,
      target: peerName,
      type: "SIMILAR_TO",
      weight: ratio,
      rule: "tag-overlap",
      evidence: `shared:${shared.join(",")}`,
    });
  }

  const capped = candidates.slice(0, maxCandidates);
  const byRule: Record<KnowledgeRelationRule, number> = { heading: 0, "md-link": 0, tag: 0, "tag-overlap": 0 };
  for (const c of capped) byRule[c.rule]++;
  return {
    node: nodeName || null,
    candidates: capped,
    stats: {
      headings: headings.length,
      links: links.length,
      tags: ownTags.length,
      missing: capped.length === 0,
      byRule,
    },
  };
}

/** observe 口径统一格式化(按计数): `[cognitive-gate/relation] missing=N/total=M` */
export function knowledgeRelationObserveLineFromCounts(missing: number, total: number): string {
  const m = Number.isFinite(missing) && missing > 0 ? Math.floor(missing) : 0;
  const t = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  return `[cognitive-gate/relation] missing=${m}/total=${t}`;
}

/** observe 口径统一格式化(按抽取结果): `[cognitive-gate/relation] missing=N/total=M` */
export function knowledgeRelationObserveLine(extractions: readonly KnowledgeRelationExtraction[]): string {
  const total = extractions.length;
  let missing = 0;
  for (const e of extractions) if (e.stats.missing) missing++;
  return knowledgeRelationObserveLineFromCounts(missing, total);
}

// =====================================================================================
// 2026-10-09 round 72-D 遗留项(落库): 候选 -> KnowledgeRelation 落库**计划**
// -----------------------------------------------------------------------------------
// 上一条遗留只做到「抽候选 + observe 计数」; 本段补落库缺口, 三件事:
//   ① name -> KnowledgeEntity.id 映射: 归一 key(name 大小写/空白/标点) + aliases 联合索引;
//      归一后撞名的实体不猜 —— 记为 entity_ambiguous, 交人工消歧(记忆 TaskCluster 的 ATTACH-RACE 教训:
//      没有唯一约束兜底时"猜第一个"会在集成时变成脏数据)。
//   ② 去重: 批内按 (sourceId,targetId,type) 合并取最大 weight; SIMILAR_TO/RELATED_TO 视为**对称边**,
//      (A,B) 与 (B,A) 归一成同一 key, 避免双向重复。
//   ③ @@unique([sourceId,targetId,relationType]) 冲突策略: 计划阶段先与**已存在边**比对, 分类为
//      insert / update(仅当 weight 更高) / skip(已存在且不低于计划) —— 绝不盲插后靠数据库报错兜。
//
// **仍不接 enforce**: 认知闸(拦 Knowledge 写入)保持 observe, 见 cognitiveGateMode()。关联落库是
//   独立的旁路写入(默认 **write**, 见 knowledgeRelationWriteMode; 显式 env 才降级 observe), 即使失败也只记
//   failed 计数, 绝不阻断 Knowledge 落库。文档节点(Knowledge.title)
//   命中实体的概率极低(实测 500 条 top 文档 title 命中 0), 因此 cooccur 投影把"文档内共现的已解析
//   概念"两两连边(文档=超边投影) —— 这是让 KnowledgeRelation 真正有边的唯一现实路径。
// =====================================================================================

/** 落库所需的最小实体形状(不引入 prisma 类型) */
export interface KnowledgeEntityRef {
  id: string;
  name: string;
  aliases?: unknown;
  type?: string | null;
}

/** 名字归一 key: 与 cleanRelationNode 同口径(折空白/去 #`"'/去尾标点) 再小写 */
export function knowledgeEntityKey(raw: unknown): string {
  return cleanRelationNode(raw).toLowerCase();
}

/** 实体解析索引: 归一 name 与 aliases 都进 byKey */
export interface KnowledgeEntityIndex {
  byKey: Map<string, KnowledgeEntityRef>;
  /** 同一 key 命中 >1 个不同实体 id —— 不自动选, 解析时判 entity_ambiguous */
  ambiguous: Set<string>;
  size: number;
}

/** 构造实体索引(纯函数, 无 IO; 顺序稳定: 先到先得, 撞名进 ambiguous) */
export function buildKnowledgeEntityIndex(entities: readonly KnowledgeEntityRef[]): KnowledgeEntityIndex {
  const byKey = new Map<string, KnowledgeEntityRef>();
  const ambiguous = new Set<string>();
  const put = (raw: unknown, e: KnowledgeEntityRef) => {
    const key = knowledgeEntityKey(raw);
    if (!key) return;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, e);
    } else if (prev.id !== e.id) {
      ambiguous.add(key);
    }
  };
  for (const e of entities || []) {
    if (!e || !e.id) continue;
    put(e.name, e);
    for (const a of splitKnowledgeTags(e.aliases)) put(a, e);
  }
  return { byKey, ambiguous, size: entities ? entities.length : 0 };
}

function isKnowledgeEntityIndex(x: unknown): x is KnowledgeEntityIndex {
  return !!x && typeof x === "object" && (x as KnowledgeEntityIndex).byKey instanceof Map;
}

/** 单端解析结果(source/target -> 实体) */
export type KnowledgeEntityResolution =
  | { resolved: true; entity: KnowledgeEntityRef; key: string; viaName: string }
  | { resolved: false; key: string; name: string; reason: "entity_missing" | "entity_ambiguous" };

/** name -> 实体解析(别名/大小写/空白归一; 撞名不猜) */
export function resolveKnowledgeEntity(
  raw: unknown,
  index: KnowledgeEntityIndex,
): KnowledgeEntityResolution {
  const name = cleanRelationNode(raw);
  const key = name.toLowerCase();
  if (!key) return { resolved: false, key, name, reason: "entity_missing" };
  if (index.ambiguous.has(key)) return { resolved: false, key, name, reason: "entity_ambiguous" };
  const hit = index.byKey.get(key);
  if (!hit) return { resolved: false, key, name, reason: "entity_missing" };
  return { resolved: true, entity: hit, key, viaName: name };
}

/** 对称关系类型: 反向边等价于正向边(需应用层归一, 数据库 @@unique 挡不住) */
export const KNOWLEDGE_RELATION_SYMMETRIC: readonly KnowledgeRelationType[] = ["SIMILAR_TO", "RELATED_TO"];
export function isSymmetricKnowledgeRelation(type: string): boolean {
  return (KNOWLEDGE_RELATION_SYMMETRIC as readonly string[]).includes(type);
}

/** 边唯一 key: 对称类型按 id 排序归一, 保证 (A,B)/(B,A) 同 key */
export function knowledgeRelationEdgeKey(sourceId: string, targetId: string, type: string): string {
  const [a, b] = isSymmetricKnowledgeRelation(type) && sourceId > targetId ? [targetId, sourceId] : [sourceId, targetId];
  return `${a}\u0000${b}\u0000${type}`;
}

/** 已存在边(用于 @@unique 冲突分类) */
export interface KnowledgeRelationExistingEdge {
  sourceId: string;
  targetId: string;
  relationType: string;
  weight?: number;
}

/** 落库动作: insert=新边; update=已存在但计划 weight 更高; skip=已存在且不低于计划(幂等) */
export type KnowledgeRelationPlanAction = "insert" | "update" | "skip";

export interface KnowledgeRelationWrite {
  key: string;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  relationType: KnowledgeRelationType;
  weight: number;
  /**
   * action=update 时, 已存在行在库中的**原方向**。
   * 对称边(SIMILAR_TO/RELATED_TO)计划会把 (A,B) 归一成 (A<B), 但库里可能存的是反向 (B,A);
   * 适配器按 sourceId/targetId 精确匹配更新, 若沿用归一方向会 UPDATE 0 行(静默丢权重升级)。
   * 因此 update 一律回传库里那一行的方向; 非对称/同向时与 sourceId/targetId 相同。
   */
  existingSourceId?: string;
  existingTargetId?: string;
  /** 贡献该边的规则(去重排序) */
  rules: KnowledgeRelationRule[];
  /** 全部可复算证据(去重, 保序) */
  evidence: string[];
  action: KnowledgeRelationPlanAction;
  reason: string;
}

export interface KnowledgeRelationUnresolved {
  name: string;
  side: "source" | "target";
  occurrences: number;
  reason: "entity_missing" | "entity_ambiguous";
}

export interface KnowledgeRelationPlanStats {
  /** 输入候选边数(跨文档累计) */
  inputCandidates: number;
  /** 两端都映射到实体、进入计划的边数(去重前) */
  resolvedEdges: number;
  insert: number;
  update: number;
  skip: number;
  dropsSelfLoop: number;
  dropsDuplicate: number;
  dropsCapped: number;
  unresolvedNames: number;
  entityIndexSize: number;
}

export interface KnowledgeRelationWritePlan {
  writes: KnowledgeRelationWrite[];
  unresolved: KnowledgeRelationUnresolved[];
  stats: KnowledgeRelationPlanStats;
}

export interface PlanKnowledgeRelationWritesOptions {
  /** 已存在边(用于 @@unique 冲突分类); 不传则全部按 insert */
  existingRelations?: readonly KnowledgeRelationExistingEdge[];
  /** direct=仅两端可解析的候选; cooccur=额外把同一文档内已解析概念两两连 RELATED_TO(文档超边投影)。默认 cooccur */
  projection?: "direct" | "cooccur";
  /** 单批最大写入边数(防爆量); 默认 200 */
  maxEdges?: number;
  /** 已存在边 weight 需高出计划值多少才算 update; 默认 0.001 */
  weightEpsilon?: number;
}

export const KNOWLEDGE_RELATION_PLAN_MAX = 200;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 候选 -> 落库计划(纯函数: 无 IO, 同输入同输出)。
 * 返回的 writes 已按 (weight desc, type, sourceId, targetId) 稳定排序。
 */
export function planKnowledgeRelationWrites(
  extractions: KnowledgeRelationExtraction | readonly KnowledgeRelationExtraction[],
  entities: readonly KnowledgeEntityRef[] | KnowledgeEntityIndex,
  opts: PlanKnowledgeRelationWritesOptions = {},
): KnowledgeRelationWritePlan {
  const index = isKnowledgeEntityIndex(entities) ? entities : buildKnowledgeEntityIndex(entities || []);
  const list: readonly KnowledgeRelationExtraction[] = Array.isArray(extractions)
    ? (extractions as readonly KnowledgeRelationExtraction[])
    : [extractions as KnowledgeRelationExtraction];
  const projection = opts.projection === "direct" ? "direct" : "cooccur";
  const maxEdges = Number.isFinite(opts.maxEdges as number) && (opts.maxEdges as number) > 0
    ? Math.floor(opts.maxEdges as number)
    : KNOWLEDGE_RELATION_PLAN_MAX;
  const epsilon = Number.isFinite(opts.weightEpsilon as number) && (opts.weightEpsilon as number) >= 0
    ? (opts.weightEpsilon as number)
    : 0.001;

  const existing = new Map<string, { weight: number; sourceId: string; targetId: string }>();
  for (const e of opts.existingRelations || []) {
    if (!e || !e.sourceId || !e.targetId || !e.relationType) continue;
    existing.set(knowledgeRelationEdgeKey(e.sourceId, e.targetId, e.relationType), {
      weight: typeof e.weight === "number" ? e.weight : 0.5,
      sourceId: e.sourceId,
      targetId: e.targetId,
    });
  }

  const planned = new Map<string, KnowledgeRelationWrite>();
  const unresolvedMap = new Map<string, KnowledgeRelationUnresolved>();
  let inputCandidates = 0;
  let resolvedEdges = 0;
  let dropsSelfLoop = 0;
  let dropsDuplicate = 0;

  const markUnresolved = (res: KnowledgeEntityResolution, side: "source" | "target") => {
    if (res.resolved) return;
    const u = res as { key: string; name: string; reason: "entity_missing" | "entity_ambiguous" };
    const k = `${side}\u0000${u.reason}\u0000${u.key}`;
    const cur = unresolvedMap.get(k);
    if (cur) cur.occurrences++;
    else unresolvedMap.set(k, { name: u.name || u.key, side, occurrences: 1, reason: u.reason });
  };

  // 累加一条计划边(批内去重 + 取最大 weight + 合并规则/证据)
  const addEdge = (
    sourceId: string,
    sourceName: string,
    targetId: string,
    targetName: string,
    type: KnowledgeRelationType,
    weight: number,
    rule: KnowledgeRelationRule,
    evidence: string,
  ) => {
    if (sourceId === targetId) {
      dropsSelfLoop++;
      return;
    }
    let a = sourceId;
    let b = targetId;
    let an = sourceName;
    let bn = targetName;
    if (isSymmetricKnowledgeRelation(type) && a > b) {
      [a, b] = [b, a];
      [an, bn] = [bn, an];
    }
    const key = `${a}\u0000${b}\u0000${type}`;
    const cur = planned.get(key);
    if (cur) {
      dropsDuplicate++;
      cur.weight = round4(Math.max(cur.weight, weight));
      if (!cur.rules.includes(rule)) cur.rules.push(rule);
      if (evidence && !cur.evidence.includes(evidence)) cur.evidence.push(evidence);
      return;
    }
    resolvedEdges++;
    planned.set(key, {
      key,
      sourceId: a,
      targetId: b,
      sourceName: an,
      targetName: bn,
      relationType: type,
      weight: round4(weight),
      rules: [rule],
      evidence: evidence ? [evidence] : [],
      action: "insert",
      reason: "new_edge",
    });
  };

  for (const ex of list) {
    if (!ex || !Array.isArray(ex.candidates)) continue;
    const resolvedNodes = new Map<string, { id: string; name: string; weight: number }>();
    for (const c of ex.candidates) {
      inputCandidates++;
      const src = resolveKnowledgeEntity(c.source, index);
      const tgt = resolveKnowledgeEntity(c.target, index);
      markUnresolved(src, "source");
      markUnresolved(tgt, "target");
      if (tgt.resolved) {
        const prev = resolvedNodes.get(tgt.entity.id);
        if (!prev || prev.weight < c.weight) {
          resolvedNodes.set(tgt.entity.id, { id: tgt.entity.id, name: tgt.entity.name, weight: c.weight });
        }
      }
      if (src.resolved && tgt.resolved) {
        addEdge(src.entity.id, src.entity.name, tgt.entity.id, tgt.entity.name, c.type, c.weight, c.rule, c.evidence);
      }
    }
    // 文档超边投影: 同一文档内已解析的概念两两 RELATED_TO(文档本身大多不是实体, 见文件头说明)
    if (projection === "cooccur") {
      const nodes = [...resolvedNodes.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          addEdge(
            nodes[i].id,
            nodes[i].name,
            nodes[j].id,
            nodes[j].name,
            "RELATED_TO",
            Math.min(nodes[i].weight, nodes[j].weight),
            "tag",
            `cooccur@${ex.node || UNTITLED_NODE}`,
          );
        }
      }
    }
  }

  // @@unique 冲突分类(对称边反查靠 knowledgeRelationEdgeKey 归一)
  const all = [...planned.values()];
  all.sort((x, y) => {
    if (y.weight !== x.weight) return y.weight - x.weight;
    if (x.relationType !== y.relationType) return x.relationType < y.relationType ? -1 : 1;
    if (x.sourceId !== y.sourceId) return x.sourceId < y.sourceId ? -1 : 1;
    return x.targetId < y.targetId ? -1 : x.targetId > y.targetId ? 1 : 0;
  });
  const capped = all.slice(0, maxEdges);
  const dropsCapped = all.length - capped.length;
  for (const w of capped) {
    w.rules.sort();
    const hit = existing.get(w.key);
    if (hit) {
      if (hit.weight + epsilon >= w.weight) {
        w.action = "skip";
        w.reason = "existing_weight_ge";
      } else {
        w.action = "update";
        w.reason = "weight_upgrade";
        // 回传库里那一行的原方向(对称反向边也能被精确匹配到)
        w.existingSourceId = hit.sourceId;
        w.existingTargetId = hit.targetId;
      }
    }
  }

  let insert = 0;
  let update = 0;
  let skip = 0;
  for (const w of capped) {
    if (w.action === "insert") insert++;
    else if (w.action === "update") update++;
    else skip++;
  }
  const unresolved = [...unresolvedMap.values()].sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return {
    writes: capped,
    unresolved,
    stats: {
      inputCandidates,
      resolvedEdges,
      insert,
      update,
      skip,
      dropsSelfLoop,
      dropsDuplicate,
      dropsCapped,
      unresolvedNames: unresolved.length,
      entityIndexSize: index.size,
    },
  };
}

/** 落库计划 observe 行: `[cognitive-gate/relation-plan] insert=N update=M skip=K unresolved=U/total=T` */
export function knowledgeRelationPlanObserveLine(
  plan: Pick<KnowledgeRelationWritePlan, "writes" | "unresolved" | "stats">,
): string {
  const s = plan.stats;
  const total = s.inputCandidates;
  return `[cognitive-gate/relation-plan] insert=${s.insert} update=${s.update} skip=${s.skip} unresolved=${s.unresolvedNames}/${total}`;
}

/**
 * 落库写入模式开关。
 *
 * 默认 **write**: 关系落库是**加性旁路** —— 只 INSERT/UPDATE 边, 单条失败只计 failed,
 *   绝不阻断 Knowledge 落库(见 applyKnowledgeRelationPlan 的 catch)。因此它不是认知闸的
 *   enforce; 认知闸 cognitiveGateMode() 仍默认 observe, 未接 enforce。
 * 这不违反 observe→enforce 铁律: 铁律约束的是"以缺少结构/关联为理由**拦截写入**"的闸,
 *   而关系落库只**新增**数据, 不产生拒绝。真正的 enforce(强拦)见 cognitiveGateMode()。
 * 降级/退出: KNOWLEDGE_RELATION_WRITE=observe|off|0|false|no -> 只出计划行不写。
 */
export type KnowledgeRelationWriteMode = "observe" | "write";
export function knowledgeRelationWriteMode(): KnowledgeRelationWriteMode {
  const raw = typeof process !== "undefined" && process.env ? process.env.KNOWLEDGE_RELATION_WRITE : undefined;
  if (raw === undefined || raw === "") return "write";
  const v = String(raw).toLowerCase();
  return v === "observe" || v === "off" || v === "0" || v === "false" || v === "no" ? "observe" : "write";
}

/** 落库执行适配器(IO 由调用方注入, 便于纯单测) */
export interface KnowledgeRelationWriteAdapter {
  nextRelationId(): string;
  insertRelation(row: {
    id: string;
    sourceId: string;
    targetId: string;
    relationType: string;
    weight: number;
  }): Promise<unknown> | unknown;
  updateRelationWeight(row: {
    sourceId: string;
    targetId: string;
    relationType: string;
    weight: number;
  }): Promise<unknown> | unknown;
}

export interface KnowledgeRelationApplyResult {
  mode: KnowledgeRelationWriteMode;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
}

/**
 * 执行落库计划。observe 模式**不调用 adapter**(纯 dry-run, 零写)。
 * write 模式逐条执行; 单条失败只累计 failed, **绝不抛出**(旁路写入不得阻断 Knowledge 落库)。
 */
export async function applyKnowledgeRelationPlan(
  plan: Pick<KnowledgeRelationWritePlan, "writes">,
  adapter: KnowledgeRelationWriteAdapter,
  opts: { mode?: KnowledgeRelationWriteMode } = {},
): Promise<KnowledgeRelationApplyResult> {
  const mode: KnowledgeRelationWriteMode = opts.mode === "write" ? "write" : "observe";
  const out: KnowledgeRelationApplyResult = { mode, inserted: 0, updated: 0, skipped: 0, failed: 0 };
  for (const w of plan.writes || []) {
    if (w.action === "skip") {
      out.skipped++;
      continue;
    }
    if (mode === "observe") {
      if (w.action === "insert") out.inserted++;
      else out.updated++;
      continue;
    }
    try {
      if (w.action === "insert") {
        await adapter.insertRelation({
          id: adapter.nextRelationId(),
          sourceId: w.sourceId,
          targetId: w.targetId,
          relationType: w.relationType,
          weight: w.weight,
        });
        out.inserted++;
      } else {
        await adapter.updateRelationWeight({
          sourceId: w.existingSourceId || w.sourceId,
          targetId: w.existingTargetId || w.targetId,
          relationType: w.relationType,
          weight: w.weight,
        });
        out.updated++;
      }
    } catch (_e) {
      out.failed++;
    }
  }
  return out;
}
