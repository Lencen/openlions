"use client";
import { t } from "@/i18n";
import { DataTable } from "@/components/ui";
import type { DashboardData } from "./shared";
import type { DataColumn } from "@/components/ui";
import TableCopyButton from "@/components/TableCopyButton";
import styles from "../page.module.css";

/** Section 6: 参考信息 (折叠)
 *
 * 2026-11-04（ord-20261104-032）：内联 style 清零（7 处 → 0）；两张裸表格换成白名单 DataTable；
 *   列定义照原表头（类型/核心维度/评分规则、频率/任务/说明），一列没删、字段没改。取数未动。
 */
export default function FlywheelReference({
  qualityDims,
  cronSchedule,
  logInfo,
}: {
  qualityDims: DashboardData["qualityDims"];
  cronSchedule: DashboardData["cronSchedule"];
  logInfo: DashboardData["logInfo"];
}) {
  const dimColumns: DataColumn<DashboardData["qualityDims"][number]>[] = [
    { key: "type", title: "类型", render: (q) => <span className="nowrap"><strong>{q.type}</strong></span> },
    { key: "dim", title: "核心维度", render: (q) => <span className="nowrap">{q.dim}</span> },
    { key: "desc", title: "评分规则", render: (q) => <span className={styles.refDesc}>{q.desc}</span> },
  ];
  const cronColumns: DataColumn<DashboardData["cronSchedule"][number]>[] = [
    { key: "time", title: "频率", render: (c) => <span className={"nowrap mono " + styles.refBase}>{c.time}</span> },
    { key: "task", title: "任务", render: (c) => <span className="nowrap"><strong>{c.task}</strong></span> },
    { key: "desc", title: "说明", render: (c) => <span className={styles.refDesc}>{c.desc}</span> },
  ];

  return (
    <div className="panel">
      <details className="ref-collapse">
        <summary>{t('flywheel.ref.run')}</summary>
        <div className="grid-2">
          <div>
            <div className={styles.refHead}>质量评估维度</div>
            <TableCopyButton />
            <DataTable columns={dimColumns} rows={qualityDims} rowKey={(q) => q.type} />
          </div>
          <div>
            <div className={styles.refHead}>{t('flywheel.ref.cron')}</div>
            <TableCopyButton />
            <DataTable columns={cronColumns} rows={cronSchedule} rowKey={(c) => c.task} />
            <div className={styles.refHeadTop}>日志文件</div>
            <div className={styles.refBase}>
              log {Math.round(logInfo.logSize / 1024)}KB · 明细日志 {Math.round(logInfo.jsonlSize / 1024)}KB
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
