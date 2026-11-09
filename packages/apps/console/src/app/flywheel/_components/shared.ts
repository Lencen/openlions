"use client";
// 2026-09-14 页面瘦身: 飞轮总览页的共享类型 / 常量 / 小工具。
import { t } from "@/i18n";

export interface DashboardData {
  tableStats: { table: string; active: number; h24: number; h1: number }[];
  themes: { theme: string; cnt: number }[];
  qualityByType: { memory: {b:string;c:number}[]; practice: {b:string;c:number}[]; knowledge: {b:string;c:number}[]; reflection: {b:string;c:number}[] };
  qualityDims: { type: string; dim: string; desc: string }[];
  errors: { errorType: string; cnt: number }[];
  llmStats: { total24h: number; ok24h: number; fail24h: number; byEntry: { entry: string; calls: number; ok: number; avgMs: number }[]; trend: {hb:number;c:number}[] };
  lastTick: { stage: string; sourceType: string; sourceTitle: string; createdAt: number } | null;
  recentEvents: { stage: string; sourceType: string; cnt: number }[];
  cronSchedule: { time: string; task: string; desc: string }[];
  resolverStats: { resolverAction: string; cnt: number }[];
  logInfo: { logSize: number; jsonlSize: number };
  recentLogEntries: { ts: string; level: string; module: string; stage: string; msg: string }[];
  actionStats: { total: number; completed: number; pending: number };
  reflectionStats: { total: number; avgCoverage: number };
  trend: { events: {hb:number;c:number}[]; writes: {hb:number;c:number}[]; errors: {hb:number;c:number}[] };
  timestamp: string;
}

export const STAGES = [
  { id: "scan", label: "扫描", icon: "🔍", desc: t('flywheel.step.scan.desc') },
  { id: "extract", label: "提取", icon: "🧠", desc: "LLM 提取认知数据" },
  { id: "write", label: "写入", icon: "💾", desc: "5 表写入" },
  { id: "generateTasks", label: "生成任务", icon: "🎯", desc: "改进任务" },
  { id: "reflect", label: "反思", icon: "💡", desc: t('flywheel.step.reflect.desc') },
  { id: "structure", label: "结构化", icon: "🏗️", desc: "碎片整理" },
];

export const TABLE_COLORS: Record<string, string> = {
  Memory: "var(--table-memory)", Knowledge: "var(--table-knowledge)", Reflection: "var(--table-reflection)", Practice: "var(--table-practice)", Skill: "var(--table-skill)",
};

export const QUALITY_COLORS: Record<string, string> = {
  high: "var(--status-ok)", mid: "var(--status-warn)", low: "var(--text-dim)", zero: "var(--text-muted)",
};
export const QUALITY_LABELS: Record<string, string> = {
  high: "高 (0.7-1.0)", mid: "中 (0.4-0.7)", low: "低 (0-0.4)", zero: "未评分",
};
export const ERROR_COLORS: Record<string, string> = { RATE_LIMIT: "var(--err-rate-limit)", SCHEMA_INVALID: "var(--err-schema)", NETWORK: "var(--err-network)", AUTH_ERROR: "var(--err-auth)", TIMEOUT: "var(--err-timeout)", UNKNOWN: "var(--err-unknown)", SERVER_ERROR: "var(--err-server)" };

// ── 2026-11-06 · 0.4.32-03 · 数据卡 9 指标带（/flywheel）─────────────────────────
// 口径唯一来源：docs/design/uiux-bento-2026-11/data-cards/card-9-flywheel.md 行 15「指标（≤4）」
//   + 行 26-73「异常判据」。服务端（/api/flywheel-health 的 card9 块）按判据算好 state；
//   指标带按 2026-11-06 裁决**只报「值」**（阈值/判定在判据条 Card9Checks）；
//   未知（value=null）-> 「未知」+ reason，不写 0。
/** 指标态：ok=正常 / quiet=安静（只满足断流两条件之一）/ crit=超阈值 / unknown=取不到 / na=口径未定义 */
export type Card9State = "ok" | "quiet" | "crit" | "unknown" | "na";

export interface Card9Metric {
  /** 数值；未知（查询失败 / 分母为 0）时是 null —— 页面显示「未知」+ 原因，不写 0 */
  value: number | null;
  /** 阈值（卡 9 标定值）；口径未定义时为 null */
  threshold: number | null;
  state: Card9State;
  /** 未知时的原因（未知不填 0 的「原因」） */
  reason: string | null;
  /** 事实源（表名 + 状态口径） */
  source?: string;
  /** 最近一次活动距今小时（仅 ② 认知链用；来自判据接口的 "最近 4.8h" 文案） */
  lastActiveHours?: number | null;
  /** 单位（platform-data 2026-11-06 契约字段）："%" | "count" | "hours" —— 展示时按它加后缀，不硬编码 */
  unit?: "%" | "count" | "hours" | string;
}

export interface Card9Metrics {
  asOf?: string | null;
  extractFailure: Card9Metric & { unit?: string };
  reflection24h: Card9Metric & { lastActiveHours: number | null };
  backlog: Card9Metric;
  /** ④ 六段覆盖率：字典未定义（缺口 G1）-> value 恒为 null */
  coverage6: Card9Metric & { gap?: string | null };
}

export function fmt(n: number): string { return n.toLocaleString(); }

/** 小时桶 rows -> 24 点序列 (idx 23 = 当前小时) */
export function toHourly(rows: { hb: number; c: number }[] | undefined, nowMs: number): number[] {
  const arr = new Array(24).fill(0);
  if (!rows) return arr;
  const curHour = Math.floor(nowMs / 3600000);
  for (const r of rows) {
    const idx = 23 - (curHour - r.hb);
    if (idx >= 0 && idx < 24) arr[idx] = r.c;
  }
  return arr;
}

/** 2026-11-06 · 0.4.32-03：把 /api/flywheel/card9 的 checks 映射成指标带用的 Card9Metrics。
 *  为什么要适配：判据接口（platform-data 提供）按「判据」组织（含 pipeline_freshness），
 *  指标带按卡 9 第 6 行的「指标」组织（④ 是六段覆盖率，不是管道新鲜度）。
 *  **唯一数据源 = /api/flywheel/card9**，指标带不再自带一份 SQL（避免两处口径漂移）。 */
export function card9MetricsFromChecks(
  checks: { id: string; label: string; threshold: string; value: string | null; valueNum?: number | null; state: "pass" | "fail" | "na"; reason?: string; unit?: string; extra?: { lastActiveHours?: number; attempts?: number } }[] | undefined,
  asOf?: string,
): Card9Metrics | null {
  if (!checks || !checks.length) return null;
  const pick = (id: string) => checks.find((c) => c.id === id);
  /** 取数值：**优先 valueNum**（platform-data 2026-11-06 加的契约字段，value 只是展示串）。
   *  没有 valueNum 时才退回"取展示串里的第一个数字"（旧接口兜底，不能拼接）。 */
  const numOf = (c: { value: string | null; valueNum?: number | null } | undefined): number | null => {
    if (!c) return null;
    if (typeof c.valueNum === "number" && Number.isFinite(c.valueNum)) return c.valueNum;
    const m = /-?\d+(?:\.\d+)?/.exec(String(c.value ?? ""));
    return m && Number.isFinite(Number(m[0])) ? Number(m[0]) : null;
  };
  const conv = (id: string, threshold: number | null, source: string): Card9Metric => {
    const c = pick(id);
    if (!c) return { value: null, threshold, state: "unknown", reason: "判据接口未返回该条", source };
    const v = numOf(c);
    const state: Card9State = c.state === "na" ? "na" : v === null ? "unknown" : c.state === "fail" ? "crit" : "ok";
    const out: Card9Metric = { value: v, threshold, state, reason: c.reason ?? null, source, unit: c.unit };
    if (id === "cognition_24h") {
      // 优先读契约字段 extra.lastActiveHours（platform-data 4ffd3a8d3）；
      // 仅当接口没给时才退回"从展示串扒数字"——那条路是 4743 错数的来源，只作兜底。
      const lh = c.extra?.lastActiveHours;
      if (typeof lh === "number" && Number.isFinite(lh)) out.lastActiveHours = lh;
      else {
        const m = /最近\s*(-?\d+(?:\.\d+)?)\s*h/i.exec(String(c.value ?? ""));
        out.lastActiveHours = m ? Number(m[1]) : null;
      }
    }
    return out;
  };
  return {
    asOf: asOf || new Date().toISOString(),
    extractFailure: conv("extract_fail_rate", 5, "SessionExtractionState（status='ERROR' 占比）"),
    reflection24h: conv("cognition_24h", 0, "FlywheelReflection（status='OK'）"),
    backlog: conv("backlog", 20, "FlywheelJob（PENDING+PROCESSING）"),
    // ④ 六段覆盖率：字典未定义（缺口 G1）—— 不来自接口，固定 n/a，不写 0、不自造口径
    coverage6: { value: null, threshold: null, state: "na", reason: "口径未定义，见 G1", source: "缺口 G1（分子/分母/来源表未定义）" },
  } as Card9Metrics;
}
