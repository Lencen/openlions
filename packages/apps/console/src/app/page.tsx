"use client";
// 2026-09-10 商业化改版: 概览首页
// 一屏回答人类决策者最关心的 6 件事: 会话流入 / 提炼产物 / 任务完成失败 / 活跃 Agent / token 消耗 / 质量分
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { useApi } from "@/lib/api";
import DataMoment from "@/components/DataMoment";
import DataHealth from "@/components/DataHealth";
import { t } from "@/i18n";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { ErrorBlock } from "@/components/ui";
import OverviewHero, { OverviewHeroPlain } from "./_components/OverviewHero";
import OverviewMetrics from "./_components/OverviewMetrics";
import OverviewFlowCharts from "./_components/OverviewFlowCharts";
import OverviewTrendCharts from "./_components/OverviewTrendCharts";
import OverviewQualityPanels from "./_components/OverviewQualityPanels";
import OverviewRecentPanels from "./_components/OverviewRecentPanels";
import OverviewDailyCard from "./_components/OverviewDailyCard";
import OverviewOneScreen from "./_components/OverviewOneScreen";

export default function OverviewPage() {
  const f = useGlobalFilter();
  const { data, loading, error, mutate } = useApi<any>(f.withQuery("/api/overview") + "&_n=" + f.nonce);
  // 2026-09-15 日结卡: 数据不随全局筛选变化, 固定取最近 14 期 (接口只读 mind 库)
  const daily = useApi<any>("/api/daily-reflection?limit=14");
  // 2026-10-21 前端对账：查询失败要能被看见——否则 PG 方言错误会以"0"的样子伪装成真数据。
  const { data: dbh } = useApi<any>("/api/db-health");

  if (error) {
    return (
      <main className="page">
        <OverviewHeroPlain />
        <ErrorBlock message={String(error?.message || "")} onRetry={mutate} />
      </main>
    );
  }

  const loadingCards = loading && !data;

  return (
    <main className="page">
      <OverviewHero data={data} agent={f.agent} theme={f.theme} onRefresh={mutate} />

      {/* 2026-10-25 R8(CLS)：数据健康提示改为**固定槽位**。
          改前两条 Alert 是「有故障才出现」，出现时把下面整块下推 —— CLS 探针实测最大单次位移
          0.0444/0.0433，直接吃掉 G10 的 0.01 目标。现在槽位常驻、高度固定（44px），
          健康时一行绿字、降级时一行黄字 + 技术详情折叠；内容变化不再引起位移。 */}
      <DataHealth failures={Number(dbh?.failures || 0)} sample={String(dbh?.samples?.[0]?.error || "")}
        warnings={Array.isArray(data?.warnings) ? data.warnings : []} />

      {/* ---------- 一屏看懂：业务链 + 需要你决定（2026-10-20 人类要求"前面也做成一屏能看懂"） ---------- */}
      <OverviewOneScreen data={data} loading={loadingCards} />

      {/* ---------- 以下是分析/运维用的明细，默认收起，避免首屏被数字淹没（数据一条没删） ---------- */}
      <details className="os-more">
        <summary>展开更多数据（分析 / 运维用）</summary>

        {/* ---------- 日结: 昨天发生了什么 / 哪里不对 / 今天关注什么 ---------- */}
        <OverviewDailyCard data={daily.data} loading={daily.loading} />

        {/* ---------- 核心 6 指标 ---------- */}
        <OverviewMetrics data={data} loadingCards={loadingCards} />

        {/* ---------- 趋势 ---------- */}
        <OverviewFlowCharts data={data} loadingCards={loadingCards} />
        <OverviewTrendCharts data={data} loadingCards={loadingCards} />

        {/* ---------- 质量 + 积压 ---------- */}
        <OverviewQualityPanels data={data} loadingCards={loadingCards} />

        {/* ---------- 最近任务 + 事件 ---------- */}
        <OverviewRecentPanels data={data} loadingCards={loadingCards} />
      </details>

      {/* 2026-10-16（round 77-N: 决策③「逐源」+ 77-M 机检清单第 1 项）:
          本页有 **2 个数据源**（/api/overview 与 /api/daily-reflection），而这里此前只显示 overview 的 asOf ✗
          —— 日结卡片的数字因此戴着总览的时刻（又一次"借时刻"）。
          改法: **保留原有的出处说明 t(overview.source)**（那是一整句来源描述, 不能丢 ✗）
                **追加**逐源 <DataMoment>（实测两个接口各自都有 asOf, daily-reflection 本来就有, 故无需改 BFF ✓）。
          自纠: 我第一次写成了"用 DataMoment 替换整行", 会把那句出处说明**删掉** ✗ —— 已改回"保留+追加" ✓。 */}
      <div className="tiny" style={{ textAlign: "right" }}>
        {t('overview.source')}{" "}
        <DataMoment
          items={[{ label: "总览", at: data?.asOf }, { label: "日结", at: daily.data?.asOf }]}
          style={{ marginLeft: 0 }}
          showPrefix={false}
        /* 出处那句 t(overview.source) 自己就以「…数据时间」结尾, 故这里不再重复「数据时刻:」前缀 */
        />
      </div>
    </main>
  );
}