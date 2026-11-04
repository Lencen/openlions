"use client";
import KPICard from "@/components/KPICard";
import type { DailyReport } from "./shared";

/** KPI 行 */
export default function DailyKpis({ d }: { d: DailyReport }) {
  return (
    <div className="kpi-grid">
      <KPICard label="当日产出" value={d.summary.totalNew.toLocaleString()}
        delta={`环比昨日全天 ${d.summary.vsYesterday.newRecords >= 0 ? "+" : ""}${d.summary.vsYesterday.newRecords.toLocaleString()}`}
        deltaDir={d.summary.vsYesterday.newRecords >= 0 ? "up" : "down"} />
      <KPICard label="活跃总量" value={d.summary.totalActive.toLocaleString()} />
      <KPICard label="错误" value={d.summary.totalErrors}
        delta={`环比昨日全天 ${d.summary.vsYesterday.errors >= 0 ? "+" : ""}${d.summary.vsYesterday.errors}`}
        deltaDir={d.summary.vsYesterday.errors <= 0 ? "up" : "down"} />
      <KPICard label="反思→任务" value={d.reflectionToTask} />
    </div>
  );
}
