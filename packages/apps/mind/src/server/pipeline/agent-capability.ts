import { prisma } from "@/lib/prisma";
import claimableTaskTypes from "./claimable-task-types.json";

/**
 * agent-capability.ts — 2026-09-11 用户批准的能力分级方案的**单一权威源**。
 *
 * 为什么需要它: "这个 agent 能做什么"此前散落在 5 处 —— claim 路由硬编码 / agents-live / work-plan /
 *   消费端 .env / cron 白名单。任何一处漏改, 症状都是"任务静默消失且不报错"
 *   (实测: 复核任务被执行器抢走判 FAILED + 认领白名单漏类型 -> 连修三轮才通)。
 * 现在: 能力等级登记在 **AgentRegistry.profile.capabilityTier**(注册时设定, 详情页可改),
 *   逐项事实登记在 **AgentRegistry.profile.capabilities**(tools/db/file/network),
 *   所有判断点都走本模块读取, 不再各自读环境变量。
 *
 * 分级(用户方案 + 补充):
 *   T0 纯文本   : 无工具调用能力(纯 LLM 通道), 只能看推送给它的快照
 *   T1 只读查证 : 可调用**只读工具**核验事实(查 finding/产物/指标/任务流水)
 *   T2 提案式写 : 可建候选/开任务/提建议 —— 进复核队列, 不进生产
 *   T3 直接写   : 可改数据/改代码/部署(当前仅执行体, 需审批)
 *
 * 兼容与回退顺序: 注册表 profile.capabilityTier -> 环境变量 CLAIM_TOOL_CAPABLE_AGENTS(视为 T3)
 *   -> 默认 T0(最小权限)。回退存在的意义是"注册表还没登记"时不至于把人锁死;
 *   但它只是回退, 权威来源始终是注册表。
 */
export type CapabilityTier = 0 | 1 | 2 | 3;

/**
 * 能力维度 (2026-09-14): tier 是"综合档位", dimensions 是逐项事实 ——
 * 回答"这个 agent 到底有没有 工具/DB/文件/网络"。派单缺什么直接读这里, 不再靠猜。
 *   tools   能否调用平台工具/接口(不只是对话)
 *   db      能否直接读写平台数据库(纯文本通道 false)
 *   file    能否读写本机文件与代码库(改代码/部署的前提)
 *   network 能否访问网络(调外部 API / 部署)
 * 注: tier 表达"可写到什么范围"(T2 提案 / T3 生产), dimensions 表达"通道有没有";
 *     机制修复的判据 = tier>=3 且四维齐全。
 */
export interface CapabilityDimensions {
  tools: boolean;
  db: boolean;
  file: boolean;
  network: boolean;
}

export interface AgentCapability {
  agentId: string;
  tier: CapabilityTier;
  /** 该 agent 是否可被派发"[机制修复]"这类需要真实执行权限的任务(等价于 tier>=3) */
  toolCapable: boolean;
  /** 四维能力事实(注册表 profile.capabilities 优先, 缺失时按 tier 推导) */
  dimensions: CapabilityDimensions;
  source: "registry" | "env" | "default";
  reason?: string;
}

/** 判定"有工具"的阈值: 保持既有语义不变(此前只有执行体算), 因此是 tier>=3 而不是 >=1。 */
export const TOOL_CAPABLE_MIN_TIER: CapabilityTier = 3;

/** tier -> 维度默认推导(注册表未逐项登记时的回退, 最小权限)。 */
export const TIER_DEFAULT_DIMENSIONS: Record<CapabilityTier, CapabilityDimensions> = {
  0: { tools: false, db: false, file: false, network: false },
  1: { tools: true, db: false, file: false, network: true },  // 只读查证: 走授权接口, 不直接落库/改文件
  2: { tools: true, db: false, file: false, network: true },  // 提案式写: 建候选/开任务, 不进生产
  3: { tools: true, db: true, file: true, network: true },    // 直接写: 改数据/代码/部署
};

/** 机制修复类任务的契约前缀(与 goal-gap.ts 生成侧、claim 路由守卫一致)。 */
export const MECHANISM_FIX_PREFIX = "[机制修复]";
/** 落地类任务的标题标记(位置不固定: "[落地] 提案落地: …" / "… [落地] …" 都算)。 */
export const LANDING_TITLE_MARKER = "[落地]";
/** 取证必需型任务的标题前缀/标记(与 acceptance specs 的 titleLike 对齐)。 */
export const EVIDENCE_TITLE_PREFIXES = ["[机制修复]", "[补证]", "[验证]"];
export const EVIDENCE_TITLE_MARKERS = [LANDING_TITLE_MARKER];
/** 取证必需型的 improvementType(权威字段优先)。 */
export const EVIDENCE_IMPROVEMENT_TYPES = ["VERIFICATION", "VERIFY_AGENT_OUTPUT"];
/** improvementPayload.kind 里的取证必需型(标题/字段都会漂移, payload 是第三处权威)。 */
export const EVIDENCE_PAYLOAD_KINDS = ["VERIFY_AGENT_OUTPUT", "PROPOSAL_VERIFY"];

/**
 * improvementType 的**认领白名单**(单一来源, 2026-09-17, 待办 todo_d563d97665df49428c45)。
 *
 * 语义: 一条 PENDING 任务若 **既没有 sourceReflectionIds(反思衍生)**, **improvementType 又不在本白名单内**,
 *   则它对**所有** agent 都领不到(认领 SQL 的两个 OR 条件都不满足)—— 工作摆在那里没人能接。
 *
 * 为什么必须是常量而不是各处手写:
 *   ① 事故: improvementType='VERIFY'(提案复核生成侧产出)不在白名单 -> 该任务对所有人不可认领;
 *   ② 事故: 复活的 15 条任务 manualReview 未清 -> 同样全员不可领, 且无人发现;
 *   ③ 分叉: 体检侧(scripts/lib/task-revive.cjs)与认领侧(claim route)各持一份列表, 补了 VERIFY 只补一边。
 * 现在生成侧(tasks/route.ts 建单校验)、认领侧(claim route)、体检/指标侧(cjs 脚本)都读同一个
 *   JSON 数据源 `claimable-task-types.json`。**禁止**再手写这份列表。
 */
export const CLAIMABLE_IMPROVEMENT_TYPES: readonly string[] = Object.freeze(
  [...(claimableTaskTypes as { claimableImprovementTypes: string[] }).claimableImprovementTypes],
);

/** 该 improvementType 是否在认领白名单内(大小写敏感, 与库内字面值一致)。 */
export function isClaimableImprovementType(ty?: string | null): boolean {
  return ty != null && CLAIMABLE_IMPROVEMENT_TYPES.includes(String(ty));
}

/** 供拼 SQL 的 `'A','B'` 片段(调用方负责确保来源是本常量, 不做注入面扩张)。 */
export function claimableImprovementTypesSqlList(): string {
  return CLAIMABLE_IMPROVEMENT_TYPES.map((t) => "'" + t.replace(/[^A-Z_]/g, "") + "'").join(",");
}

export const DIMENSION_LABEL: Record<keyof CapabilityDimensions, string> = {
  tools: "工具/接口",
  db: "数据库",
  file: "文件/代码库",
  network: "网络",
};

export type TaskRequirementKind = "MECHANISM_FIX" | "LANDING" | "VERIFY" | "GENERAL";

export interface TaskCapabilityRequirement {
  kind: TaskRequirementKind;
  /** 需要的档位下限 */
  minTier: CapabilityTier;
  /** 需要的维度(缺任一 = 缺能力) */
  dimensions: (keyof CapabilityDimensions)[];
  /** 人类可读的"这是哪类活" */
  label: string;
  /**
   * 产出是否**必须附可复算证据锚点**(命令/SQL/库内 id/仓库文件/commit/可溯源引文)。
   * 这一位同时驱动两件事, 使"派单"与"收口"用同一口径:
   *   ① 派单路由: evidenceRequired 的任务只派给真有工具的执行体(claim / claim-by-id / 提案闭环派单);
   *   ② 收口自检: submit 时若无锚点则拒绝结单(不再产出"任务 DONE 但验收无证据"的假象)。
   */
  evidenceRequired: boolean;
}

/** 机制修复所需能力(常量, 供 SKIP 提示复用)。 */
export const MECHANISM_FIX_REQUIREMENT: TaskCapabilityRequirement = {
  kind: "MECHANISM_FIX", minTier: 3, dimensions: ["tools", "db", "file", "network"], label: "机制修复(需改代码/查库/部署)", evidenceRequired: true,
};

/**
 * 落地类(标题含 [落地], 或 improvementType=LANDING): 要真的改代码/改数据/部署, 并留可复算证据。
 * 2026-09-15 加入路由: 实测 23 条 [落地] 任务的 evidence-attached 全灭, 且执行者全是无 DB/文件能力的通道。
 */
export const LANDING_REQUIREMENT: TaskCapabilityRequirement = {
  kind: "LANDING", minTier: 3, dimensions: ["tools", "db", "file", "network"], label: "落地(需改代码/数据/部署并留可复算证据)", evidenceRequired: true,
};

/**
 * 复核/验证/补证类: 判定必须能落到可复算锚点上(acceptance specs VERIFY / VERIFY_EVIDENCE 都要求 evidence-attached)。
 *
 * 2026-09-15 机制修复(本常量原为 minTier:1 + ["tools"], 即"只读查证即可")。实测证据(scripts/acceptance/runner.cjs
 *   台账最新判定): 165 条 DONE 任务未过 evidence-attached, 执行者分布 = agent-f(T1)48 / agent-c(T1)41 /
 *   agent-e(T2)39 / agent-operator(T1)15 / agent-b(T1)7 / agent-lease-other(未登记)15, **T3 执行体 0 条**。
 *   这些通道的注册表虽写 tools=true, 但产出原文是"本通道无工具, 不包含任何已执行变更" —— 声明与观察互相打脸
 *   (见 agent-capabilities.ts 的 DECLARED_CONFLICT 判据)。结论: 需要取证的活必须交给**真有 db/file 工具**的执行体,
 *   否则结构上交不出锚点, 只能把"任务 DONE"做成对外假象。故下限提到 T3 + tools/db/file。
 */
export const VERIFY_REQUIREMENT: TaskCapabilityRequirement = {
  kind: "VERIFY", minTier: 3, dimensions: ["tools", "db", "file"], label: "需取证复核(要真查库/查文件/跑命令留锚点)", evidenceRequired: true,
};

/** 讨论/问答(纯文本即可)。 */
export const GENERAL_REQUIREMENT: TaskCapabilityRequirement = {
  kind: "GENERAL", minTier: 0, dimensions: [], label: "一般任务(纯文本即可)", evidenceRequired: false,
};

/** 从 improvementPayload 里取 kind(容错: 非 JSON / 双重编码都试一次)。 */
export function parsePayloadKind(improvementPayload?: string | null): string {
  const raw = String(improvementPayload || "");
  if (!raw) return "";
  const tryParse = (s: string): string => {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === "object" && j.kind != null) return String(j.kind);
    } catch { /* 继续尝试 */ }
    return "";
  };
  const first = tryParse(raw);
  if (first) return first;
  // 双重编码: 落库成 "\"{...}\"" 的历史数据
  try { return tryParse(String(JSON.parse(raw))); } catch { return ""; }
}

/**
 * 按任务标题/类型/payload 判定所需能力 —— 派单与"缺什么"提示的唯一口径。
 *
 * 判定顺序(权威字段优先, 再回退标题 —— 因为标题里常**引用**别的任务标题, 例如
 *   "[VERIFY_AGENT_OUTPUT] 验证 agent 结论: [agent 结论] [落地] 提案落地: …" 的 improvementType 是
 *   VERIFY_AGENT_OUTPUT, 标题里的 [落地] 只是候选标题的转述, 不能据此把复核任务当成落地任务):
 *   1) 标题前缀 [机制修复]            -> MECHANISM_FIX
 *   2) improvementType/payload.kind 命中 VERIFY 型, 或标题前缀 [验证]/[补证] -> VERIFY
 *   3) 标题含 [落地] 或 improvementType=LANDING -> LANDING
 *   4) 讨论/问答 -> GENERAL
 *
 * 【2026-10-10 单一来源漂移修复】(实践遗留 cmv2fda8p0101jso7as「排查 T3 单点饱和根因」)
 *   本函数原来把 "[验证]"/"[补证]"/"[落地]" 三个字面量**各写一遍**, 与同文件导出的
 *   EVIDENCE_TITLE_PREFIXES / EVIDENCE_TITLE_MARKERS 是两份拷贝。而 claim/route.ts 的
 *   EVIDENCE_REQUIRED_SQL(非 T3 的 SQL 层粗筛)读的是**常量**。于是只要有人往常量里加一个前缀,
 *   SQL 会把它排除, JS 精确判定却不认 -> 同一类任务"SQL 说取证必需、JS 说不是", 正是本仓库反复
 *   踩过的"口径分叉"病(见下方 CLAIMABLE_IMPROVEMENT_TYPES 注释 §③)。现在标题判据一律从常量派生,
 *   单一来源。回归见 scripts/test-evidence-routing.ts §1b(对每个常量逐个断言分类器都认)。
 */
export function classifyTaskRequirement(
  title: string | null | undefined,
  improvementType?: string | null,
  improvementPayload?: string | null,
): TaskCapabilityRequirement {
  const t = String(title || "");
  const ty = String(improvementType || "");
  const pk = parsePayloadKind(improvementPayload);
  if (t.startsWith(MECHANISM_FIX_PREFIX)) return MECHANISM_FIX_REQUIREMENT;
  // 取证必需型标题: 前缀/标记都从单一来源常量派生(不再手写字面量)。
  if (EVIDENCE_IMPROVEMENT_TYPES.includes(ty) || EVIDENCE_PAYLOAD_KINDS.includes(pk) || EVIDENCE_TITLE_PREFIXES.some((p) => t.startsWith(p))) {
    return VERIFY_REQUIREMENT;
  }
  if (EVIDENCE_TITLE_MARKERS.some((m) => t.includes(m)) || ty === "LANDING") return LANDING_REQUIREMENT;
  if (ty === "DISCUSSION_QUESTION" || t.startsWith("[讨论]")) return GENERAL_REQUIREMENT;
  return GENERAL_REQUIREMENT;
}

/**
 * 单条任务能否派给某 agent —— claim 路由的判据(把"能力过滤"从 SQL 字符串提升为可单测的纯函数)。
 * 返回 ok=false 时, missing 就是"缺什么"(供诚实 SKIP 提示复用)。
 */
export function canClaimTask(
  cap: AgentCapability,
  task: { title?: string | null; improvementType?: string | null; improvementPayload?: string | null },
): { ok: boolean; requirement: TaskCapabilityRequirement; missing: string[] } {
  const requirement = classifyTaskRequirement(task.title, task.improvementType, task.improvementPayload);
  // 2026-10-23: 人类决策类任务任何 agent 都不可认领（要人拍板，不是能力问题）。
  //   生成端会打 [需人类决策] 前缀 / payload.humanDecision=true；这里统一挡住，避免它们进队列空转。
  const t = String(task.title || "");
  let humanDecision = t.startsWith("[需人类决策]");
  if (!humanDecision && task.improvementPayload) {
    try { humanDecision = JSON.parse(String(task.improvementPayload)).humanDecision === true; } catch { /* 忽略 */ }
  }
  if (humanDecision) return { ok: false, requirement, missing: ["需人类决策（agent 不可代做）"] };
  const missing = missingCapabilities(cap, requirement);
  return { ok: missing.length === 0, requirement, missing };
}

/** 该 agent 相对某任务缺什么(空数组 = 能力足够)。 */
export function missingCapabilities(cap: AgentCapability, req: TaskCapabilityRequirement): string[] {
  const miss: string[] = [];
  if (cap.tier < req.minTier) miss.push(`档位 T${cap.tier} < 要求 T${req.minTier}`);
  for (const d of req.dimensions) {
    if (!cap.dimensions[d]) miss.push(`${d}(${DIMENSION_LABEL[d]})`);
  }
  return miss;
}

function normalizeDimensions(raw: any, tier: CapabilityTier): CapabilityDimensions {
  const base = TIER_DEFAULT_DIMENSIONS[tier];
  if (!raw || typeof raw !== "object") return base;
  const pick = (k: keyof CapabilityDimensions) => (typeof raw[k] === "boolean" ? raw[k] : base[k]);
  return { tools: pick("tools"), db: pick("db"), file: pick("file"), network: pick("network") };
}

function envToolCapable(): string[] {
  return String(process.env.CLAIM_TOOL_CAPABLE_AGENTS || "agent-d")
    .split(",").map((x) => x.trim()).filter(Boolean);
}

function tierFromProfile(profile: string | null): { tier: CapabilityTier; reason?: string; dimensions?: any } | null {
  try {
    const j = profile ? JSON.parse(String(profile)) : null;
    if (!j) return null;
    const t = Number(j.capabilityTier);
    if (Number.isFinite(t) && t >= 0 && t <= 3) {
      return { tier: Math.trunc(t) as CapabilityTier, reason: String(j.capabilityReason || ""), dimensions: j.capabilities };
    }
    if (j.toolCapable === true || j.hasTools === true) return { tier: 3, reason: "profile.toolCapable=true(旧字段)", dimensions: j.capabilities };
    return null;
  } catch { return null; }
}

/** 单个 agent 的能力(注册表优先, 环境变量回退, 再默认 T0)。 */
export async function getAgentCapability(agentId: string): Promise<AgentCapability> {
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT agent_id, profile FROM AgentRegistry WHERE agent_id = ? LIMIT 1", agentId);
    if (rows && rows.length) {
      const t = tierFromProfile(rows[0].profile);
      if (t) return {
        agentId, tier: t.tier, toolCapable: t.tier >= TOOL_CAPABLE_MIN_TIER,
        dimensions: normalizeDimensions(t.dimensions, t.tier), source: "registry", reason: t.reason,
      };
    }
  } catch { /* 注册表读失败 -> 回退 */ }
  if (envToolCapable().includes(agentId)) {
    return { agentId, tier: 3, toolCapable: true, dimensions: TIER_DEFAULT_DIMENSIONS[3], source: "env", reason: "CLAIM_TOOL_CAPABLE_AGENTS(注册表尚未登记该 agent)" };
  }
  return { agentId, tier: 0, toolCapable: false, dimensions: TIER_DEFAULT_DIMENSIONS[0], source: "default", reason: "注册表未登记且不在环境变量名单 -> 最小权限" };
}

/** 全量能力表(看板/派单用), 避免各处再自己拼。 */
export async function listAgentCapabilities(): Promise<AgentCapability[]> {
  const out: AgentCapability[] = [];
  let rows: any[] = [];
  try {
    rows = await prisma.$queryRawUnsafe("SELECT agent_id, profile FROM AgentRegistry");
  } catch { rows = []; }
  const envList = envToolCapable();
  for (const r of rows) {
    const id = String(r.agent_id);
    const t = tierFromProfile(r.profile);
    if (t) out.push({
      agentId: id, tier: t.tier, toolCapable: t.tier >= TOOL_CAPABLE_MIN_TIER,
      dimensions: normalizeDimensions(t.dimensions, t.tier), source: "registry", reason: t.reason,
    });
    else if (envList.includes(id)) out.push({ agentId: id, tier: 3, toolCapable: true, dimensions: TIER_DEFAULT_DIMENSIONS[3], source: "env" });
    else out.push({ agentId: id, tier: 0, toolCapable: false, dimensions: TIER_DEFAULT_DIMENSIONS[0], source: "default" });
  }
  return out;
}
