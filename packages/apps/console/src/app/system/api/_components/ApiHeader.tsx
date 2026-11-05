"use client";
// system/api 页 · 页头 + 指标卡行 (从 page.tsx 抽出, 页面瘦身)
import KPICard from "@/components/KPICard";
import { t } from "@/i18n";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "../page.module.css";

export function ApiHeader({
  loading,
  restCount,
  trpcCount,
  mcpCount,
  toolCount,
}: {
  loading: boolean;
  restCount: number;
  trpcCount: number;
  mcpCount: number;
  toolCount: number;
}) {
  return (
    <>
      <div className="breadcrumb">
        <span className={styles.crumbDim}>业务与系统</span>
        <span className="sep">/</span>
        <span className="current">{t('api.crumb')}</span>
      </div>
      <PageHeader>
        <PageTitle>{t('api.title')}</PageTitle>
        <div className="page-subtitle">
          {loading
            ? "加载中..."
            : t('api.meta', { rest: restCount, trpc: trpcCount, mcp: mcpCount, tools: toolCount })}
        </div>
      </PageHeader>
    </>
  );
}

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
