"use client";
// 概览首页 · 会话/产物趋势图 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import ChartPanel from "@/components/common/ChartPanel";
import { useChartBase } from "@/components/EChart";
import { TABLE_COLOR, TABLE_LABEL } from "./constants";

export default function OverviewFlowCharts({ data, loadingCards }: { data: any; loadingCards: boolean }) {
  // 2026-10-15（round 76-FM）: 文字/网格/提示框接主题色（此前写死亮色 -> 暗色下偏暗 ✗）。
  const base = useChartBase();
  const pts = (data?.range?.points ?? []).map((p: any) => p.label);
  const s = data?.sessions;
  const prod = data?.products;

  return (
    <div className="card-grid cols-2">
      <ChartPanel
        title="会话流入趋势"
        extra={<span className="tiny">左轴: 会话数 · 右轴: 消息数</span>}
        loading={loadingCards}
        height={240}
        option={{
          ...base,
          legend: { right: 0, top: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: "var(--fs-sm)", color: base.textStyle.color } },
          grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
          tooltip: { ...base.tooltip },
          xAxis: { ...base.xAxis, data: pts },
          yAxis: [
            { ...base.yAxis, name: "会话", nameTextStyle: { fontSize: "var(--fs-xs)", color: base.xAxis.axisLabel.color } },
            { ...base.yAxis, name: "消息", nameTextStyle: { fontSize: "var(--fs-xs)", color: base.xAxis.axisLabel.color }, splitLine: { show: false } },
          ],
          series: [
            { name: "新建会话", type: "bar", barMaxWidth: 14, itemStyle: { color: "#2563eb", borderRadius: [3, 3, 0, 0] }, data: s?.trend ?? [] },
            { name: "消息数", type: "line", yAxisIndex: 1, smooth: true, symbol: "none", lineStyle: { color: "#0d9488", width: 2 }, areaStyle: { color: "rgba(13,148,136,0.10)" }, data: s?.messageTrend ?? [] },
          ],
        }}
      />

      <ChartPanel
        title="认知产物落库趋势"
        extra={<span className="tiny">按产物类型堆叠</span>}
        loading={loadingCards}
        height={240}
        option={{
          ...base,
          legend: { right: 0, top: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: "var(--fs-sm)", color: base.textStyle.color } },
          grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
          tooltip: { ...base.tooltip },
          xAxis: { ...base.xAxis, data: pts },
          yAxis: { ...base.yAxis },
          series: (["Memory", "Knowledge", "Practice", "Skill"] as const).map((t) => ({
            name: TABLE_LABEL[t],
            type: "bar",
            stack: "prod",
            barMaxWidth: 18,
            itemStyle: { color: TABLE_COLOR[t] },
            data: prod?.byTable?.[t]?.trend ?? [],
          })),
        }}
      />
    </div>
  );
}
