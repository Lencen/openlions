import { t } from "@/i18n";

// 2026-09-10 任务语义分层 (mind 侧已上线): Task.improvementType 明确分成四类, 前端按 scope 区分展示。
//   机制修复 GOAL_GAP          —— 来自目标差距; 标题前缀 [机制修复] (历史数据为 [GOAL_GAP]); 要求落地改动 + 复测证据, 不收"只交方案"
//   验证/裁决 VERIFY_AGENT_OUTPUT —— 独立复核 agent 结论 (通过/驳回/缺依据)
//   对话/问答 DISCUSSION_QUESTION —— 讨论模块 @agent 提问生成的对话任务 (主题 讨论·<entityType>), 不计入"改进任务"
//   既有类型 THEME_IMPROVE / PLATFORM_REVIEW —— 反思衍生改进与平台复审
//   (另有 BRIDGE/FIX_*/RE_RUN/MIGRATE_DATA 等自动与遗留类型, 归入"其他", 避免混进机制修复口径)
// 说明: scope 一律以 improvementType 为准 (标题前缀只用于显示剥离, 兼容历史 [GOAL_GAP] 写法)。

// 2026-09-14 文案业务化: 任务范围文案走集中文案 (src/i18n), 不硬编码。
export type ScopeKey = "ALL" | "MECHANISM" | "VERIFY" | "DISCUSSION" | "OTHER";

export interface TaskScope {
  key: ScopeKey;
  label: string;
  short: string;
  /** 归属的 improvementType; 空数组 = 不过滤 (全部) */
  types: string[];
  color: string;
  desc: string;
  /** 是否计入"改进任务数/完成率"口径 */
  inImprovementMetric: boolean;
  /** 标题前缀 (含历史写法), 仅用于展示剥离 */
  prefix: string[];
}

export const TASK_SCOPES: TaskScope[] = [
  {
    key: "ALL", label: t("scope.ALL.label"), short: t("scope.ALL.short"), types: [], color: "var(--primary)",
    desc: t("scope.ALL.desc"), inImprovementMetric: false, prefix: [],
  },
  {
    key: "MECHANISM", label: t("scope.MECHANISM.label"), short: t("scope.MECHANISM.short"), types: ["GOAL_GAP", "THEME_IMPROVE", "PLATFORM_REVIEW"], color: "var(--status-warn)",
    desc: t("scope.MECHANISM.desc"),
    inImprovementMetric: true, prefix: ["[机制修复]", "[GOAL_GAP]", "[THEME_IMPROVE]", "[PLATFORM_REVIEW]"],
  },
  {
    key: "VERIFY", label: t("scope.VERIFY.label"), short: t("scope.VERIFY.short"), types: ["VERIFY_AGENT_OUTPUT"], color: "var(--table-knowledge)",
    desc: t("scope.VERIFY.desc"), inImprovementMetric: false, prefix: ["[VERIFY_AGENT_OUTPUT]"],
  },
  {
    key: "DISCUSSION", label: t("scope.DISCUSSION.label"), short: t("scope.DISCUSSION.short"), types: ["DISCUSSION_QUESTION"], color: "var(--table-memory)",
    desc: t("scope.DISCUSSION.desc"), inImprovementMetric: false, prefix: ["[讨论提问]"],
  },
  {
    key: "OTHER", label: t("scope.OTHER.label"), short: t("scope.OTHER.short"), types: ["BRIDGE", "FIX_CONFLICT", "FIX_THEME", "RE_RUN", "MIGRATE_DATA"], color: "#64748b",
    desc: t("scope.OTHER.desc"), inImprovementMetric: false, prefix: [],
  },
];

/** "改进任务" 口径 = 机制修复类 (概览首页 / Agent 活跃看板 使用) */
export const IMPROVEMENT_TYPES = ["GOAL_GAP", "THEME_IMPROVE", "PLATFORM_REVIEW"];

/** 生成 SQL IN 列表 (类型常量来自本文件白名单, 不含外部输入) */
export function sqlTypeList(types: string[]): string {
  return types.map((t) => "'" + String(t).replace(/'/g, "") + "'").join(",");
}

export function improvementTypeSql(): string {
  return sqlTypeList(IMPROVEMENT_TYPES);
}

export function scopeOfType(type?: string | null): ScopeKey {
  const t = String(type || "");
  if (!t) return "OTHER";
  for (const s of TASK_SCOPES) {
    if (s.key === "ALL") continue;
    if (s.types.includes(t)) return s.key;
  }
  return "OTHER";
}

export function scopeDef(key: string | null | undefined): TaskScope {
  return TASK_SCOPES.find((s) => s.key === key) || TASK_SCOPES[0];
}

export function scopeColorOfType(type?: string | null): string {
  return scopeDef(scopeOfType(type)).color;
}

export function scopeLabelOfType(type?: string | null): string {
  return scopeDef(scopeOfType(type)).label;
}

/** 是否计为"改进任务" */
export function isImprovementType(type?: string | null): boolean {
  return IMPROVEMENT_TYPES.includes(String(type || ""));
}

/** 剥离标题里的类型前缀 (兼容 [机制修复] 与历史 [GOAL_GAP] 等), 展示用 */
export function stripTypePrefix(title?: string | null, type?: string | null): string {
  let t = String(title || "");
  const prefixes = new Set<string>();
  for (const s of TASK_SCOPES) for (const p of s.prefix) prefixes.add(p);
  if (type) prefixes.add("[" + type + "]");
  for (const p of Array.from(prefixes).sort((a, b) => b.length - a.length)) {
    if (t.startsWith(p)) { t = t.slice(p.length).trim(); break; }
  }
  return t;
}
