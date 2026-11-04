"use client";
// lineage 页 · 数据来源构成图 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import ChartPanel from "@/components/common/ChartPanel";
import { chartBase } from "@/components/EChart";
import { t } from "@/i18n";
import { truncate } from "@/lib/format";

export default function LineageSourceMixPanel({ sourceMix, loadingAll }: { sourceMix: any[]; loadingAll: boolean }) {
  return (
    <ChartPanel
      title="数据来源构成"
      extra={<span className="tiny">{t('biz.sourceType.mix')}</span>}
      loading={loadingAll}
      empty={sourceMix.length === 0}
      emptyTitle="窗口内没有来源记录"
      height={Math.max(180, sourceMix.slice(0, 8).length * 30)}
      option={{
        ...chartBase,
        grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
        tooltip: { ...chartBase.tooltip, axisPointer: { type: "shadow" } },
        xAxis: { ...chartBase.xAxis, type: "value" },
        yAxis: { ...chartBase.yAxis, type: "category", data: sourceMix.slice(0, 8).map((s: any) => truncate(s.sourceType, 18)).reverse(), splitLine: { show: false } },
        series: [
          {
            type: "bar",
            barMaxWidth: 14,
            itemStyle: { color: "#7c3aed", borderRadius: [0, 3, 3, 0] },
            label: { show: true, position: "right", fontSize: "var(--fs-xs)", color: "#94a3b8" },
            data: sourceMix.slice(0, 8).map((s: any) => s.total).reverse(),
          },
        ],
      }}
    />
  );
}
