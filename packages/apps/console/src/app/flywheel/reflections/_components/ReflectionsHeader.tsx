"use client";
// reflections 页 · 面包屑 / 页头 / KPI 卡 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import KPICard from "@/components/KPICard";
import { t } from "@/i18n";
import type { Stats } from "./reflectionsShared";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "../page.module.css";

export default function ReflectionsHeader({
  loading,
  rowsCount,
  st,
  stats,
}: {
  loading: boolean;
  rowsCount: number;
  st: Stats["reflections"];
  stats: Stats | null;
}) {
  return (
    <>
      <div className="breadcrumb"><span className={styles.reflCrumbDim}>飞轮引擎</span><span className="sep">/</span><span className="current">反思</span></div>
      <PageHeader><PageTitle>反思(主题 / 日结)</PageTitle>
        <div className="page-subtitle">{loading ? "加载中…" : rowsCount + " 条 · 全库 " + t('status.ok') + " " + (st?.ok ?? "?") + " / " + t('status.failed') + " " + (st?.failed ?? "?") + " · 发现覆盖 " + (((stats?.structuredFindings?.rate ?? 0) * 100).toFixed(1)) + "%"}</div></PageHeader>
      <div className="kpi-grid">
        <KPICard label="反思总量" value={st ? String(st.total ?? "?") : "…"} />
        <KPICard label={t('status.ok')} value={st ? String(st.ok ?? "?") : "…"} />
        <KPICard label={t('status.failed')} value={st ? String(st.failed ?? "?") : "…"} />
      </div>
    </>
  );
}
