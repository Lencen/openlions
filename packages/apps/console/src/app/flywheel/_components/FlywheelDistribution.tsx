"use client";
import { fmt } from "./shared";
import type { DashboardData } from "./shared";
import { entityLabel } from "@/config/artifactTypes";
import styles from "../page.module.css";
/** 5% 一档的宽度类（组件内不写内联 style） */
const pctClass = (v: number, m: Record<string, string>) =>
  m["p" + Math.round((Math.max(0, Math.min(1, v)) * 100) / 5) * 5] || m.p0;


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
          <span className={styles.mutedSm}>总计 {fmt(totalActive)}</span>
        </div>
        {tableStats.map(t => (
          <div key={t.table} className="dist-row">
            <span className={"dist-dot " + styles.distDot} data-table={t.table} />
            <span className="dist-name">{entityLabel(t.table)}</span>
            <div className="dist-track">
              <div className={"dist-fill " + styles.distFill + " " + pctClass(t.active / maxActive, styles as unknown as Record<string, string>)} data-table={t.table} />
            </div>
            <span className="dist-num">{fmt(t.active)}</span>
            <span className="dist-h24">+{fmt(t.h24)}</span>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">主题分布 (Top 10)</span>
          <span className={styles.mutedSm}>记忆表</span>
        </div>
        <div className="theme-list">
          {themes.slice(0, 10).map((t, i) => {
            const maxCnt = themes[0]?.cnt ?? 1;
            return (
              <div key={t.theme} className="theme-row">
                <span className="theme-name">{i + 1}. {t.theme}</span>
                <div className="theme-bar-wrap">
                  <div className={"theme-bar " + pctClass(t.cnt / maxCnt, styles as unknown as Record<string, string>)} />
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