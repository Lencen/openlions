// reflections 页 · 共享类型与格式化 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import type { CSSProperties } from "react";

export interface Refl { id: string; theme: string; reflectionGranularity?: string; status: string; coverageScore?: number; coverageDelta?: number | null; missedTopics?: string[]; improvements?: string[]; conflicts?: any[]; summary?: string; triggerReason?: any; sourceStats?: any; dayStats?: any; findings?: any[]; derivedTasks?: any[]; updatedAt?: string; createdAt?: string; }
export interface Stats { reflections?: { total: number; ok: number; failed: number }; structuredFindings?: { rate: number }; }

export const fmt = (n: number) => new Intl.NumberFormat().format(n);
export function fmtTs(v?: string | null): string {
  if (!v) return "-";
  const n = Number(v);
  const d = Number.isNaN(n) ? new Date(v) : new Date(n);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 16);
  try { return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  catch { return d.toISOString().slice(0, 16); }
}
export const badge = (s?: string) => "badge " + (s === "DONE" ? "badge-green" : s === "FAILED" ? "badge-red" : s === "OK" ? "badge-green" : "badge-yellow");
export const chipStyle = (active: boolean): CSSProperties => ({ padding: "2px 8px", borderRadius: 10, border: "1px solid var(--border)", background: active ? "rgba(59,130,246,.15)" : "transparent", fontSize: 11, cursor: "default" });
