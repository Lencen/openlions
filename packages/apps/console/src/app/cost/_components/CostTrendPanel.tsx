"use client";
// cost 页 · 趋势图 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import ChartPanel from "@/components/common/ChartPanel";
import { useChartBase, withAlpha } from "@/components/EChart";
import { t } from "@/i18n";

export default function CostTrendPanel({ data, loadingAll }: { data: any; loadingAll: boolean }) {
  // 2026-10-15（round 76-FL）: 文字/网格/提示框接**主题色**（此前写死亮色 -> 暗色下偏暗看不清 ✗）。
  // 2026-11-09 轮 A2: 系列色也从 hex 改为 base.colors.* —— 取值与改动前**完全一致**
  //   （此前靠 EChart 的 HEX_TO_KEY 在渲染时映射成同名 token），改完源码即 token，不再依赖隐式映射。
  const base = useChartBase();
  const pts = data?.trend?.points?.map((p: any) => p.label) ?? [];
  return (
    <ChartPanel
      title={t("cost.trend.title")}
      extra={<span className="tiny">{t("cost.trend.extra")}</span>}
      loading={loadingAll}
      height={280}
      option={{
        ...base,
        legend: { right: 0, top: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: "var(--fs-sm)", color: base.textStyle.color } },
        grid: { left: 8, right: 8, top: 34, bottom: 8, containLabel: true },
        tooltip: { ...base.tooltip },
        xAxis: { ...base.xAxis, data: pts },
        yAxis: [
          { ...base.yAxis, name: t("cost.unit"), nameTextStyle: { fontSize: "var(--fs-xs)", color: base.xAxis.axisLabel.color }, axisLabel: { ...base.yAxis.axisLabel, fontSize: "var(--fs-xs)", formatter: (v: number) => (v >= 10000 ? v / 10000 + "万" : String(v)) } },
          { ...base.yAxis, name: "调用次数", nameTextStyle: { fontSize: "var(--fs-xs)", color: base.xAxis.axisLabel.color }, splitLine: { show: false } },
        ],
        series: [
          {
            name: "调用次数", type: "bar", yAxisIndex: 1, barMaxWidth: 12,
            itemStyle: { color: withAlpha(base.colors.primary, "0.35"), borderRadius: [3, 3, 0, 0] },
            data: data?.trend?.calls ?? [],
          },
          {
            name: t("cost.series.measured"), type: "line", smooth: true, symbol: "none",
            lineStyle: { color: base.colors.statusWarn, width: 2 },
            areaStyle: { color: withAlpha(base.colors.statusWarn, "0.14") },
            data: data?.trend?.tokens ?? [],
          },
          {
            name: t("cost.series.agent"), type: "line", smooth: true, symbol: "none",
            lineStyle: { color: base.colors.tableKnowledge, width: 2, type: "dashed" },
            data: data?.trend?.agentTokens ?? [],
          },
          // 估算量单独一条线 (不进主序列, 不并入总量)
          ...((data?.trend?.estimatedTokens ?? []).some((v: number) => v > 0)
            ? [{
                name: t("cost.series.estimated"), type: "line" as const, smooth: true, symbol: "none",
                lineStyle: { color: base.colors.textMuted, width: 2, type: "dotted" as const },
                data: data?.trend?.estimatedTokens ?? [],
              }]
            : []),
        ],
      }}
    />
  );
}
