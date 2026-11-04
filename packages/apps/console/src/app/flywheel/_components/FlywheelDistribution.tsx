"use client";
import { TABLE_COLORS, fmt } from "./shared";
import type { DashboardData } from "./shared";
import { entityLabel } from "@/config/artifactTypes";

/** Section 4: 5 表数据分布 + 主题分布 (可视化) */
export default function FlywheelDistribution({
  tableStats,
  themes,
  totalActive,
  maxActive,
}: {
  tableStats: DashboardData["tableStats"];
  themes: DashboardData["themes"];
  totalActive: number;
  maxActive: number;
}) {
  return (
    <div className="grid-2">
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">5 表数据分布</span>
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>总计 {fmt(totalActive)}</span>
        </div>
        {tableStats.map(t => (
          <div key={t.table} className="dist-row">
            <span className="dist-dot" style={{ background: TABLE_COLORS[t.table] || "var(--primary)" }} />
            <span className="dist-name">{entityLabel(t.table)}</span>
            <div className="dist-track">
              <div className="dist-fill" style={{ width: `${(t.active / maxActive) * 100}%`, background: TABLE_COLORS[t.table] || "var(--primary)" }} />
            </div>
            <span className="dist-num">{fmt(t.active)}</span>
            <span className="dist-h24">+{fmt(t.h24)}</span>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">主题分布 (Top 10)</span>
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)" }}>记忆表</span>
        </div>
        <div className="theme-list">
          {themes.slice(0, 10).map((t, i) => {
            const maxCnt = themes[0]?.cnt ?? 1;
            return (
              <div key={t.theme} className="theme-row">
                <span className="theme-name">{i + 1}. {t.theme}</span>
                <div className="theme-bar-wrap">
                  <div className="theme-bar" style={{ width: `${(t.cnt / maxCnt) * 100}%` }} />
                </div>
                <span className="theme-cnt">{t.cnt}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
