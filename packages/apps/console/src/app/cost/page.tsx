"use client";
// 2026-09-10 商业化改版: Token 消耗页
// 口径: 只统计 token 数量, 不做金额折算。
// 数据源: FlywheelEvent WHERE stage='CALL_LLM' (sourceTitle: tok=N / tok≈N / chars≈N)
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { Alert } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi } from "@/lib/api";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { ErrorBlock } from "@/components/ui";
import CostMetrics, { CostHero } from "./_components/CostMetrics";
import CostTrendPanel from "./_components/CostTrendPanel";
import CostAttributionPanels from "./_components/CostAttributionPanels";
import CostTables from "./_components/CostTables";
import CostAgentChart from "./_components/CostAgentChart";
import CostTopCallsTable from "./_components/CostTopCallsTable";
import CostAgentTable from "./_components/CostAgentTable";
import CostCaliber from "./_components/CostCaliber";
import FeatureGate from "@/components/FeatureGate";

export default function CostPage() {
  const f = useGlobalFilter();
  const { data, loading, error, mutate } = useApi<any>(f.withQuery("/api/token-usage") + "&_n=" + f.nonce);

  if (error) {
    return (
      <main className="page">
        <CostHero data={undefined} agent={f.agent} minimal />
        <ErrorBlock message={String(error?.message || "")} onRetry={mutate} />
      </main>
    );
  }

  const loadingAll = loading && !data;
  const byEntry = data?.byEntry ?? [];
  const byModel = data?.byModel ?? [];
  const byAgent = data?.byAgent ?? [];

  return (
    <FeatureGate feature="console.analytics" label="分析">
    <main className="page">
      <CostHero data={data} agent={f.agent} />

      {data?.warnings?.length ? (
        <Alert type="info" showIcon style={{ marginBottom: "var(--sp-4)" }} title="口径提示" description={data.warnings.join("；")} />
      ) : null}

      <CostMetrics data={data} loadingAll={loadingAll} />
      <CostTrendPanel data={data} loadingAll={loadingAll} />
      <CostAttributionPanels data={data} byEntry={byEntry} byModel={byModel} loadingAll={loadingAll} />
      <CostTables data={data} byEntry={byEntry} loadingAll={loadingAll} />

      <div className="card-grid cols-2">
        <CostAgentChart byAgent={byAgent} loadingAll={loadingAll} />
        <CostTopCallsTable data={data} loadingAll={loadingAll} />
        <CostAgentTable data={data} byAgent={byAgent} loadingAll={loadingAll} />
      </div>

      <CostCaliber data={data} />
    </main>
    </FeatureGate>
  );
}
