"use client";
// 2026-09-14 页面瘦身: 每日总结页共享类型 / 日期工具。

export interface Production { today: number; prev: number; total: number }
export interface DailyReport {
  ok: boolean;
  date: string;
  summary: { totalNew: number; totalActive: number; totalErrors: number; vsYesterday: { newRecords: number; errors: number } };
  services: { name: string; port: number; status: string }[];
  production: Record<string, Production>;
  quality: Record<string, number>;
  themes: { theme: string; count: number }[];
  overCapacity: { theme: string; count: number }[];
  tasks: { done: { type: string; count: number }[]; pending: { type: string; count: number }[] };
  errors: { type: string; count: number }[];
  highlights: {
    memories: { title: string; theme: string; agent: string; score: number }[];
    reflections: { title: string; theme: string; priority: string }[];
  };
  agentActivity: { agent: string; count: number }[];
  flywheelEvents: { stage: string; count: number }[];
  reflectionToTask: number;
}

export function pad(n: number) { return String(n).padStart(2, "0"); }
export function bjToday(): string {
  const bj = new Date(Date.now() + 8 * 3600000);
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`;
}
export function shiftDate(d: string, days: number): string {
  const [y, m, dd] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
