"use client";
// cost 页 · 按智能体聚合图 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import ChartPanel from "@/components/common/ChartPanel";
import { useChartBase } from "@/components/EChart";
import { t } from "@/i18n";
import { fmtCompact } from "@/lib/format";

export default function CostAgentChart({ byAgent, loadingAll }: { byAgent: any[]; loadingAll: boolean }) {
  // 2026-10-15（round 76-FS）: 文字色接主题（此前写死亮色 -> 暗色下偏暗 ✗）。
  //   series 里的 #0d9488/#cbd5e1 是**系列色**(哪根柱是谁), 保留不动 ✓。
  const base = useChartBase();
  return (
    <ChartPanel
      title={t("cost.byAgent.title")}
      tone="var(--status-ok)"
      extra={<span className="tiny">{t("cost.byAgent.extra")}</span>}
      loading={loadingAll}
      empty={byAgent.length === 0}
      emptyTitle={t("cost.byAgent.empty")}
      height={Math.max(180, byAgent.length * 34)}
      option={{
        ...base,
        grid: { left: 8, right: 70, top: 8, bottom: 8, containLabel: true },
        tooltip: { ...base.tooltip, axisPointer: { type: "shadow" } },
        xAxis: { ...base.xAxis, type: "value", axisLabel: { ...base.xAxis.axisLabel, fontSize: "var(--fs-xs)", formatter: (v: number) => (v >= 10000 ? v / 10000 + "万" : String(v)) } },
        yAxis: { ...base.yAxis, type: "category", data: byAgent.slice(0, 10).map((a: any) => a.agentId).reverse(), splitLine: { show: false } },
        series: [
          {
            name: t("cost.byEntry.measured"), type: "bar", barMaxWidth: 16,
            itemStyle: { color: "#0d9488", borderRadius: [0, 3, 3, 0] },
            label: { show: true, position: "right", fontSize: "var(--fs-xs)", color: base.textStyle.color, formatter: (p: any) => (p.value ? fmtCompact(p.value) : "") },
            data: byAgent.slice(0, 10).map((a: any) => a.totalTokens).reverse(),
          },
          ...(byAgent.some((a: any) => a.estimatedTokens > 0)
            ? [{
                name: t("cost.byEntry.estimated"), type: "bar" as const, barMaxWidth: 10,
                itemStyle: { color: "#cbd5e1", borderRadius: [0, 3, 3, 0] },
                data: byAgent.slice(0, 10).map((a: any) => a.estimatedTokens).reverse(),
              }]
            : []),
        ],
      }}
    />
  );
}
