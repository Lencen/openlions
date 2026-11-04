"use client";
import { t } from "@/i18n";
import { fmt } from "./shared";
import type { DashboardData } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";

/** Section 6: 参考信息 (折叠) */
export default function FlywheelReference({
  qualityDims,
  cronSchedule,
  logInfo,
}: {
  qualityDims: DashboardData["qualityDims"];
  cronSchedule: DashboardData["cronSchedule"];
  logInfo: DashboardData["logInfo"];
}) {
  return (
    <div className="panel">
      <details className="ref-collapse">
        <summary>{t('flywheel.ref.run')}</summary>
        <div className="grid-2">
          <div>
            <div style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)", margin: "var(--sp-2) 0" }}>质量评估维度</div>
            <TableCopyButton />
            <table className="tbl">
              <thead><tr><th>类型</th><th>核心维度</th><th>评分规则</th></tr></thead>
              <tbody>
                {qualityDims.map(q => (
                  <tr key={q.type}>
                    <td className="nowrap"><strong>{q.type}</strong></td>
                    <td className="nowrap">{q.dim}</td>
                    <td style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>{q.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)", margin: "var(--sp-2) 0" }}>{t('flywheel.ref.cron')}</div>
            <TableCopyButton />
            <table className="tbl">
              <thead><tr><th>频率</th><th>任务</th><th>说明</th></tr></thead>
              <tbody>
                {cronSchedule.map(c => (
                  <tr key={c.task}>
                    <td className="nowrap mono" style={{ fontSize: "var(--fs-base)" }}>{c.time}</td>
                    <td className="nowrap"><strong>{c.task}</strong></td>
                    <td style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>{c.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)", margin: "var(--sp-3) 0 var(--sp-1)" }}>日志文件</div>
            <div style={{ fontSize: "var(--fs-base)" }}>
              log {Math.round(logInfo.logSize / 1024)}KB · 明细日志 {Math.round(logInfo.jsonlSize / 1024)}KB
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
