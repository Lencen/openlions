"use client";
import type { DashboardData } from "./shared";
import styles from "../page.module.css";

/** Section 7: 实时日志 */
export default function FlywheelLogs({
  recentLogEntries,
}: {
  recentLogEntries: DashboardData["recentLogEntries"];
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">最近日志（明细）</span>
        <span className={styles.logCount}>最后 {recentLogEntries.length} 条</span>
      </div>
      {recentLogEntries.length === 0 ? (
        <div className={styles.logEmpty}>无日志</div>
      ) : (
        <div className="log-list">
          {recentLogEntries.map((l, i) => (
            <div key={i} className="log-entry">
              <span className="log-ts">{l.ts?.slice(11, 19)}</span>
              <span className={"log-level " + styles.logLevel} data-level={l.level}>[{l.level}]</span>
              <span className="log-mod">{l.module}</span>
              <span className="log-stage">{l.stage}</span>
              <span className="log-msg">{l.msg?.slice(0, 80)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}