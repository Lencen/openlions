"use client";
// 概览首页 · token/任务趋势图 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
import { Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import ChartPanel from "@/components/common/ChartPanel";
import { useChartBase, withAlpha } from "@/components/EChart";
import { t } from "@/i18n";

export default function OverviewTrendCharts({ data, loadingCards }: { data: any; loadingCards: boolean }) {
  // 2026-10-15（round 76-FM）: 文字/网格/提示框接主题色（此前写死亮色 -> 暗色下偏暗 ✗）。
  const base = useChartBase();
  const pts = (data?.range?.points ?? []).map((p: any) => p.label);
  const tokens = data?.tokens;
  const tasks = data?.tasks;

  return (
    <div className="card-grid cols-2">
      <ChartPanel
        title={t('overview.token.trendTitle')}
        extra={<span className="tiny">{t('overview.token.trendExtra')}</span>}
        loading={loadingCards}
        height={230}
        option={{
          ...base,
          legend: { right: 0, top: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: "var(--fs-sm)", color: base.textStyle.color } },
          grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
          tooltip: { ...base.tooltip },
          xAxis: { ...base.xAxis, data: pts },
          yAxis: { ...base.yAxis, axisLabel: { color: base.xAxis.axisLabel.color, fontSize: "var(--fs-xs)", formatter: (v: number) => (v >= 10000 ? v / 10000 + "万" : String(v)) } },
          series: [
            {
              name: "token",
              type: "line",
              smooth: true,
              symbol: "none",
              // 2026-11-09 轮 A2：系列色改为主题 token（取值不变，原先由 EChart 的 HEX_TO_KEY 隐式映射）
              lineStyle: { color: base.colors.statusWarn, width: 2 },
              areaStyle: { color: withAlpha(base.colors.statusWarn, "0.14") },
              data: tokens?.trend ?? [],
            },
          ],
        }}
      />

      <ChartPanel
        title="改进任务完成 / 失败趋势"
        extra={
          <Tooltip title="2026-09-10 任务语义分层: 改进任务口径 = 机制修复类 (目标缺口 + 主题改进 + 平台复审); 验证/裁决与对话/问答任务不计入本口径">
            <span className="tiny">口径: 机制修复类 · 不含验证/对话</span>
          </Tooltip>
        }
        loading={loadingCards}
        height={230}
        option={{
          ...base,
          legend: { right: 0, top: 0, itemWidth: 10, itemHeight: 8, textStyle: { fontSize: "var(--fs-sm)", color: base.textStyle.color } },
          grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
          tooltip: { ...base.tooltip },
          xAxis: { ...base.xAxis, data: pts },
          yAxis: { ...base.yAxis },
          series: [
            { name: "完成", type: "bar", barMaxWidth: 14, itemStyle: { color: base.colors.statusOk, borderRadius: [3, 3, 0, 0] }, data: tasks?.trend ?? [] },
            { name: "失败", type: "line", smooth: true, symbol: "circle", symbolSize: 5, lineStyle: { color: base.colors.statusCrit, width: 2 }, itemStyle: { color: base.colors.statusCrit }, data: tasks?.failTrend ?? [] },
          ],
        }}
      />
    </div>
  );
}
