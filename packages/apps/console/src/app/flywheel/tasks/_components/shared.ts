"use client";
// 2026-09-14 页面瘦身: 改进任务看板共享类型 / 小工具。
import type { CSSProperties } from "react";

export interface Counts { byStatus: Record<string, number>; byType: Record<string, number>; total: number }
export interface ScopeCount { key: string; label: string; color: string; count: number; desc: string }
export interface Item {
  id: string; type?: string; scope?: string; status: string; title?: string; theme?: string | null;
  priority?: string | null; completedBy?: string | null;
  /** 2026-09-15: 承接该任务的执行体(未完成时也知道谁在做) */
  assignedAgent?: string | null;
  createdAt?: string | null; updatedAt?: string | null; description?: string;
}
export interface Tr { fromStatus: string; toStatus: string; actor: string; reason: string; createdAt: string | null }
export interface Ex { agentId: string; status: string; output: string; problemsEncountered?: string | null; completedAt?: string | null }
export interface Pd { type: string; count: number; samples: Array<{ id: string; title: string; createdAt: string | null }> }
export interface Detail {
  task: any;
  payloadSummary: { actionCount: number; actionTypes: Record<string, number>; findingCount: number; cycleCount: number; coverageScore: number | null; relatedMemoryIds: string[]; aliasedThemes: string[] } | null;
  structured: { reflectionId?: string; sourceChain?: any; reflectionUpdatedAt?: string; relatedMemoryCount?: number } | null;
  transitions: Tr[]; executions: Ex[]; produced: Pd[];
  /** 2026-09-21: 反向关联的来源/关联待办(由待办升级的任务展示来源待办详情) */
  sourceTodos?: Array<{ id: string; title: string; status: string; priority?: string | null; ownerType?: string; ownerId?: string | null; source?: string; detail?: string | null; createdAt?: string | null }>;
}

export const fmtNum = (n: number) => new Intl.NumberFormat().format(n);
export function fmtTs(v?: string | null): string {
  if (!v) return "-";
  const n = Number(v);
  const d = Number.isNaN(n) ? new Date(v) : new Date(n);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 16);
  try {
    return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return d.toISOString().slice(0, 16); }
}
export const badgeCls = (s: string) => "badge " + (s === "DONE" ? "badge-green" : s === "FAILED" ? "badge-red" : s === "PENDING" ? "badge-yellow" : "badge-blue");
export const chip = (active: boolean): CSSProperties => ({ padding: "4px 12px", borderRadius: 12, cursor: "pointer", border: "1px solid var(--border)", background: active ? "rgba(59,130,246,.15)" : "transparent", color: "inherit", fontSize: 12 });
