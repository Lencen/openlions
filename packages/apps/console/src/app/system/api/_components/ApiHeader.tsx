"use client";
// system/api 页 · 指标卡行
// 2026-11-05 页头口径统一（PAGE-HEADER-31 §3）：页头（面包屑 + 标题 + 一句说明）已上移到 page.tsx，
//   本文件只保留 KPI 卡行；四个计数的取值口径与下方 key 一字未改。
import KPICard from "@/components/KPICard";
import { t } from "@/i18n";

export function ApiKpiGrid({
  restCount,
  trpcCount,
  mcpCount,
  toolCount,
}: {
  restCount: number;
  trpcCount: number;
  mcpCount: number;
  toolCount: number;
}) {
  return (
    <div className="kpi-grid">
      <KPICard label={t('api.kpi.rest')} value={restCount.toString()} delta="/api/v1/*" />
      <KPICard label="内部接口组" value={trpcCount.toString()} delta="12 组" />
      <KPICard label={t('api.kpi.mcp')} value={mcpCount.toString()} delta="实时拉取工具" />
      <KPICard
        label={t('api.kpi.mcpTools')}
        value={toolCount.toString()}
        delta="跨所有服务"
      />
    </div>
  );
}
