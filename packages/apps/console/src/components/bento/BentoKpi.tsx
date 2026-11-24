"use client";
import type { ReactNode } from "react";
import type { Metric } from "./types";
import styles from "./Bento.module.css";

/** Bento KPI：有值 / n/a+原因；loading 由外层 state=loading 控制（不显示 0）。 */
export default function BentoKpi({ metric, label }: { metric: Metric; label: ReactNode }) {
  if (metric.kind === "na") {
    return (
      <div className={styles.kpi} data-tone="mute">
        <span className={styles.kpiLabel}>{label}</span>
        <span className={styles.kpiValue}>n/a</span>
        <span className={styles.kpiHint}>{metric.reason}</span>
      </div>
    );
  }
  return (
    <div className={styles.kpi} data-tone={metric.tone || "info"}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={styles.kpiValue}>{metric.value}{metric.unit ? <em className={styles.kpiUnit}>{metric.unit}</em> : null}</span>
      {metric.hint ? <span className={styles.kpiHint}>{metric.hint}</span> : null}
      {metric.asOf ? <span className={styles.kpiAsOf}>截至 {new Date(metric.asOf).toLocaleTimeString("zh-CN", { hour12: false })}</span> : null}
    </div>
  );
}
