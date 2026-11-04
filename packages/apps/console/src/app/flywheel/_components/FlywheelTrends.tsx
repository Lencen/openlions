"use client";
import Sparkline from "@/components/Sparkline";
import { fmt } from "./shared";
import type { DashboardData } from "./shared";

/** Section 2: 24h 趋势 sparkline */
export default function FlywheelTrends({
  writes24,
  events24,
  errors24,
  writesSum,
  totalH24,
  totalErrors,
  actionStats,
}: {
  writes24: number[];
  events24: number[];
  errors24: number[];
  writesSum: number;
  totalH24: number;
  totalErrors: number;
  actionStats: DashboardData["actionStats"];
}) {
  return (
    <div className="trend-grid">
      <div className="trend-card">
        {/* 2026-10-21 去重：24h 总量在页首 KPI 已有，趋势卡改显示"峰值/小时"（不同信息，能看出节奏） */}
        <div className="trend-label"><span>5 表写入 · 峰值/小时</span><span>合计 +{fmt(writesSum)}</span></div>
        <div className="trend-val">{fmt(Math.max(0, ...writes24))}</div>
        <Sparkline data={writes24} color="#5eead4" />
      </div>
      <div className="trend-card">
        <div className="trend-label"><span>飞轮事件 / 24h</span></div>
        <div className="trend-val">{fmt(events24.reduce((a: number, b: number) => a + b, 0))}</div>
        <Sparkline data={events24} color="#a78bfa" />
      </div>
      <div className="trend-card">
        {/* 同上：错误总数在 KPI 已有，这里给峰值/小时 */}
        <div className="trend-label"><span>错误 · 峰值/小时</span><span>合计 {totalErrors}</span></div>
        <div className="trend-val" style={{ color: totalErrors > 50 ? "var(--status-warn)" : "var(--text)" }}>{fmt(Math.max(0, ...errors24))}</div>
        <Sparkline data={errors24} color="var(--status-warn)" />
      </div>
      <div className="trend-card">
        <div className="trend-label"><span>改进任务</span></div>
        <div className="trend-val">{actionStats.completed} / {actionStats.pending}</div>
        <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginBottom: "var(--sp-2)" }}>完成 / 待执行 · 共 {fmt(actionStats.total)}</div>
        <div className="mini-bar" style={{ width: "100%" }}>
          <div className="mini-bar-fill" style={{ width: `${Math.round(actionStats.completed / Math.max(actionStats.total, 1) * 100)}%` }} />
        </div>
      </div>
    </div>
  );
}
