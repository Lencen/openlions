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
