"use client";
import KPICard from "@/components/KPICard";
import { fmt } from "./shared";
import type { DashboardData } from "./shared";
import { entityLabel } from "@/config/artifactTypes";

/** Section 3: KPI 核心 4 张 */
export default function FlywheelKpis({
  totalActive,
  totalH24,
  totalH1,
  tableStats,
  reflectionStats,
  totalErrors,
  trendEvents,
}: {
  totalActive: number;
  totalH24: number;
  totalH1: number;
  tableStats: DashboardData["tableStats"];
  reflectionStats: DashboardData["reflectionStats"];
  totalErrors: number;
  trendEvents?: number[];
}) {
  return (
    <div className="kpi-grid">
      {/* 2026-10-20 视觉层级 + 维度审计（B9-5）：把 hero 给"24h 新增"（增长），
          1h 新增与趋势卡重复 → 合并成 delta；活跃数据与五表存量重复 → 标明是总量。 */}
      <KPICard label="24h 新增认知" size="hero" value={fmt(totalH24)} delta={`1h +${totalH1}`} deltaDir="up" trend={trendEvents} hint="曲线=近 24h 事件节奏" />
      <KPICard label="存量总量" value={fmt(totalActive)} delta={`${tableStats.length} 类资产`} />
      <KPICard label="反思聚合" value={fmt(reflectionStats.total)} delta={`avg ${(reflectionStats.avgCoverage * 100).toFixed(0)}%`} />
      <KPICard label="24h 错误" value={totalErrors} delta={totalErrors > 50 ? "需关注" : "正常"} deltaDir={totalErrors > 50 ? "down" : "up"} />
    </div>
  );
}