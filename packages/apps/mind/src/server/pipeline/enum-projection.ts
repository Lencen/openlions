/**
 * enum-projection.ts -- LLM 直出枚举字段的写入侧白名单投影 (2026-10-07, round 52, P4)
 *
 * 为什么需要(实测根因): Practice.outcome 曾是 1,060 种取值的自由文本, 因为没有任何写入侧闸门;
 *   execute-improving-task 旧代码把 acceptance 判据整句写进 outcome。存量已在 2026-10-07 归一,
 *   但没有投影就会再生。
 *
 * 纪律(对应 data-governance-plan-2026-10-07.md P4 部分通过):
 *   1. 只做投影(不命中 -> 受控兜底值), 不做写入拒绝 -- 历史口径差异不能变成业务写入失败;
 *   2. 受控集以代码 contract 为源: types.ts outcome: SUCCESS | PARTIAL | FAILED;
 *   3. 去空格 + 大写命中 -> 归一; 平台同义词(如 scanner 的 RESOLVED)显式登记 -> 归一;
 *   4. 其余 -> UNKNOWN, 并打一条去重日志(同一脏值只报一次)。
 */

export const PRACTICE_OUTCOMES = ["SUCCESS", "PARTIAL", "FAILED"] as const;
export type PracticeOutcome = (typeof PRACTICE_OUTCOMES)[number];
/** 平台自身写入的等价表述 -> 规范值(实测来源: task-resolved-scanner 用 RESOLVED 表示任务已闭环) */
export const OUTCOME_SYNONYMS: Record<string, PracticeOutcome> = {
  RESOLVED: "SUCCESS",
  DONE: "SUCCESS",
  COMPLETED: "SUCCESS",
  OK: "SUCCESS",
  PARTIALLY_DONE: "PARTIAL",
  ERROR: "FAILED",
  BROKEN: "FAILED",
};
export const OUTCOME_FALLBACK = "UNKNOWN";

const warned = new Set<string>();
function warnOnce(label: string, value: unknown, to: string) {
  const key = label + "|" + String(value).slice(0, 40);
  if (warned.has(key)) return;
  warned.add(key);
  console.warn("[enum-projection] " + label + ": " + JSON.stringify(String(value == null ? "" : value).slice(0, 60)) + " -> " + to + " (受控枚举外, 已投影)");
}

/**
 * 投影 Practice.outcome: 去空格 + 大写命中枚举 -> 规范值; 平台同义词 -> 规范值; 其余(含空值) -> UNKNOWN。
 * 返回 string 而非 null: Prisma 的 Practice.outcome 是 NOT NULL 列, 写 null 会直接报错;
 * 且 outcome 只描述"结果明确度", UNKNOWN 与缺失在此等价。
 */
export function projectPracticeOutcome(value: unknown): string {
  if (value === null || value === undefined) return OUTCOME_FALLBACK;
  const raw = String(value);
  const up = raw.trim().toUpperCase();
  if (up === "") { warnOnce("Practice.outcome", raw, OUTCOME_FALLBACK); return OUTCOME_FALLBACK; }
  if ((PRACTICE_OUTCOMES as readonly string[]).includes(up)) return up;
  const syn = OUTCOME_SYNONYMS[up];
  if (syn) { warnOnce("Practice.outcome(synonym)", raw, syn); return syn; }
  warnOnce("Practice.outcome", raw, OUTCOME_FALLBACK);
  return OUTCOME_FALLBACK;
}

/**
 * 投影标识类字段(type/level/category 等): 只做大小写/空白归一, 不替换取值 --
 * 平台多路径各自使用自己的 type 值(PROCEDURE/TASK_DERIVED/GENERAL/...), 强行替换会改变业务语义。
 * 字段级受控词表待逐个在 data-schema-spec.md 登记后再收紧。
 */
// ===========================================================================================
// category 受控词表 (2026-10-08 round 54): 与 scripts/lib/category-vocab.cjs 镜像(由 test-enum-projection 比对)
// -------------------------------------------------------------------------------------------
// 实测: Knowledge.category 462 种 / Skill.category 3,923 种 -> 分组统计失真。词表来源:
//   ① 抽取器 prompt 声明的 7 个; ② 平台自己写的标记(AGENT_OUTPUT/ARCHITECTURE + 反思 finding 类别泄漏);
//   ③ 反思类别词表里 Skill 侧在用的 TOOL/TECH/WORKFLOW(以及 task-resolved-scanner 的 DERIVED);
//   ④ 少数无歧义中文别名。其余 -> OTHER(原文进隔离档)。
//   注意: **不**把平台标记归一掉 —— 2026-10-07 曾把平台自写的 RESOLVED 当脏值清掉, 那是信息损失(已复盘)。
export const KNOWLEDGE_CATEGORIES = ["FRONTEND", "BACKEND", "DEVOPS", "DESIGN", "PRODUCT", "PROCESS", "OTHER"] as const;
export const CATEGORY_PLATFORM_MARKERS = ["AGENT_OUTPUT", "ARCHITECTURE", "MISSED_TOPIC", "CONFLICT", "IMPROVEMENT", "DATA_QUALITY", "COVERAGE_GAP", "RECURRING", "ADR_INDEX", "SKILL", "DOCUMENT", "LEARNING"] as const;
export const CATEGORY_REFLECTION_EXTRAS = ["TOOL", "TECH", "WORKFLOW"] as const;
export const CATEGORY_SKILL_EXTRAS = ["DERIVED"] as const;
export const CATEGORY_ALIASES: Record<string, string> = {
  "后端": "BACKEND", "后端开发": "BACKEND", "服务端": "BACKEND",
  "前端": "FRONTEND", "前端开发": "FRONTEND", "前端框架": "FRONTEND",
  "运维": "DEVOPS", "部署": "DEVOPS", "基础设施": "DEVOPS",
  "设计": "DESIGN", "架构设计": "DESIGN",
  "产品": "PRODUCT", "业务": "PRODUCT",
  "流程": "PROCESS", "规范": "PROCESS", "项目管理": "PROCESS",
};
export const CATEGORY_FALLBACK = "OTHER";

export function allowedCategories(kind: "knowledge" | "skill"): string[] {
  if (kind === "skill") return [...KNOWLEDGE_CATEGORIES, ...CATEGORY_PLATFORM_MARKERS, ...CATEGORY_REFLECTION_EXTRAS, ...CATEGORY_SKILL_EXTRAS];
  return [...KNOWLEDGE_CATEGORIES, ...CATEGORY_PLATFORM_MARKERS, ...CATEGORY_REFLECTION_EXTRAS];
}

/**
 * 投影 category: 去空格 -> 中文别名 -> 大写 -> 命中允许集则归一; 否则 OTHER。
 * null/空串原样返回 null(未产出 != 脏值; 不要用假值冒充分类)。
 */
export function projectCategory(raw: unknown, kind: "knowledge" | "skill"): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (CATEGORY_ALIASES[s]) return CATEGORY_ALIASES[s];
  const up = s.toUpperCase();
  if (CATEGORY_ALIASES[up]) return CATEGORY_ALIASES[up];
  return allowedCategories(kind).includes(up) ? up : CATEGORY_FALLBACK;
}

export function normalizeEnumToken(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

// ===========================================================================================
// domain(受控 7 值)写入侧投影 (2026-10-07 round 52, P4 扩展)
// -------------------------------------------------------------------------------------------
// 为什么加: 归一完成后 D1-Memory 立刻又 FAIL —— 实测 1 小时内新写入 5 行 domain='flywheel-structured'。
//   追到 4 个写入点都在写非枚举值:
//     ① cognitive-extractor.ts:703  domain: m.domain || "通用"   (LLM 自由文本 + 假默认值)
//     ② db-writer.ts:466           domain: mem.domain            (LLM 自由文本)
//     ③ db-writer.ts:755           domain: ref.category          (反思的 category 词表, 非 domain 词表)
//     ④ execute-improving-task.ts:1010 domain: "flywheel-structured" (出处标记; sourceType 已表达同一件事)
//   -> 只清存量不堵写入 = 边清边脏(与 qualityScore 同一类事故)。
//
// 口径与 scripts/lib/domain-classify.cjs **完全一致**(该文件是脚本侧单一来源);
//   两处是镜像关系, 由 scripts/test-enum-projection.ts 的漂移比对钉死(改一处不改另一处 -> 守门立刻红)。
//   跨包 import CJS 会破坏 Next 构建边界, 故采用"镜像 + 守门比对"而不是直接 import。
// ===========================================================================================
export const DOMAINS = ["platform", "agent-ops", "devops", "product", "data", "security", "ai"] as const;
export type Domain = (typeof DOMAINS)[number];
const NORM_RE = /(审视|纪律|必须|约定|守门|结单|提交规范|规范|红线|不得|禁止)/;
// 2026-10-07 round 53 补: 加入平台自己声明的反思类别词(WORKFLOW|TECH|TOOL) —— 与 scripts/lib/domain-classify.cjs 同步。
//   WORKFLOW -> platform(流程/机制属平台域), TECH/TOOL -> devops(工程手段/工具链); OTHER/GENERAL 不映射(不是领域)。
export const CATEGORY_MAP: Record<string, string> = {
  PROCESS: "platform", DEVOPS: "devops", BACKEND: "devops", FRONTEND: "devops", DEV: "devops",
  PRODUCT: "product", DESIGN: "platform", ARCHITECTURE: "platform", AGENT_OUTPUT: "agent-ops", DATA: "data",
  SECURITY: "security", AI: "ai",
  WORKFLOW: "platform", TECH: "devops", TOOL: "devops",
};
export const THEME_PATTERNS: Array<[RegExp, string]> = [
  [/记忆|知识|技能|会话|飞轮|反思|待办|审批|权限|认知/, "platform"],
  [/macs|协作|认领|通信|收件箱|agent|自动化/, "agent-ops"],
  [/mihomo|网络|服务|端口|部署|环境|进程|防火墙|tailscale|proxy|UOS/, "devops"],
  [/客户|需求|业务|产品|运营/, "product"],
  [/数据库|数据|SQL|schema|表结构/, "data"],
  [/鉴权|auth|security|双轨|反查|防伪造|凭证|签名|加密|encryption|合规|风险/, "security"],
  [/LLM|AI|capabilityTier|T0|T1|T2|T3|noEgress|aegis|brain|spool|hermes|接入|大模型|训练|推理|embedding|向量/, "ai"],
];
export const PENDING_PATTERNS: Array<[RegExp, string]> = [
  [/合规|匿名化|GDPR|隐私|密钥|keystore|vault/, "security"],
  [/claude|gpt|gemini|llama|qwen|spark|mistral|agent.?brain|thinking|reasoning|chain.of.thought/, "ai"],
];

/** 大小写/空白归一命中受控枚举 -> 规范写法; 否则 null */
export function canonDomain(value: unknown): string | null {
  const s = String(value == null ? "" : value).trim();
  if (!s) return null;
  return DOMAINS.find((d) => d.toLowerCase() === s.toLowerCase()) || null;
}

/** 关键词分类(与 scripts/lib/domain-classify.cjs 的 classify 同口径) */
export function classifyDomain(p: { title?: string | null; content?: string | null; theme?: string | null; category?: string | null }): string | null {
  const title = String(p.title || "");
  const content = String(p.content || "");
  const theme = String(p.theme || "");
  const text = title + " " + content;
  if (NORM_RE.test(text)) return "platform";
  const raw = p.category == null ? "" : String(p.category);
  const cat = raw ? (CATEGORY_MAP[raw] || CATEGORY_MAP[raw.toUpperCase()] || null) : null;
  if (cat) return cat;
  for (const [re, d] of THEME_PATTERNS) if (re.test(title + " " + theme + " " + content.slice(0, 200))) return d;
  for (const [re, d] of PENDING_PATTERNS) if (re.test(text)) return d;
  return null;
}

/**
 * 投影 Memory/Knowledge.domain: ①大小写/空白归一 -> 枚举; ②平台关键词表分类; ③仍不中 -> null。
 * 返回 null 而非假默认值: domain 列可空, null 表示"未知"(不污染枚举列, 也不用 "通用" 这类占位词伪装成领域)。
 * 出处标记(如 flywheel-structured)不写 domain —— sourceType/agentSource 已经表达同一件事(单一来源)。
 */
export function projectDomain(
  value: unknown,
  ctx?: { title?: string | null; content?: string | null; theme?: string | null; category?: string | null },
): string | null {
  const canon = canonDomain(value);
  if (canon) return canon;
  return ctx ? classifyDomain(ctx) : null;
}
