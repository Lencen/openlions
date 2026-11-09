"use client";
// reflections 页 · 指标带
// 2026-11-05 页头口径统一（UIUX PAGE-HEADER-31 §3 #11）：面包屑/标题/一句说明已上移到 page.tsx，
//   本文件只剩指标带。文件名沿用 ReflectionsHeader（仅 page.tsx 引用），不改名以免扩大改动面。
import KPICard from "@/components/KPICard";
import { t } from "@/i18n";
import type { Stats } from "./reflectionsShared";

export default function ReflectionsHeader({ st }: { st: Stats["reflections"] }) {
  return (
    <div className="kpi-grid">
      <KPICard label="反思总量" value={st ? String(st.total ?? "?") : "…"} />
      <KPICard label={t('status.ok')} value={st ? String(st.ok ?? "?") : "…"} />
      <KPICard label={t('status.failed')} value={st ? String(st.failed ?? "?") : "…"} />
    </div>
  );
}
