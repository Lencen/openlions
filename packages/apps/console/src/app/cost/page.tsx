"use client";
// 2026-09-10 商业化改版: Token 消耗页
// 口径: 只统计 token 数量, 不做金额折算。
// 数据源: FlywheelEvent WHERE stage='CALL_LLM' (sourceTitle: tok=N / tok≈N / chars≈N)
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { Alert } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi } from "@/lib/api";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { ErrorBlock } from "@/components/ui";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import CostMetrics, { CostHero } from "./_components/CostMetrics";
import CostTrendPanel from "./_components/CostTrendPanel";
import CostAttributionPanels from "./_components/CostAttributionPanels";
import CostTables from "./_components/CostTables";
import CostAgentChart from "./_components/CostAgentChart";
import CostTopCallsTable from "./_components/CostTopCallsTable";
import CostAgentTable from "./_components/CostAgentTable";
import CostCaliber from "./_components/CostCaliber";
import FeatureGate from "@/components/FeatureGate";
import styles from "./page.module.css";

export default function CostPage() {
  const f = useGlobalFilter();
  const { data, loading, error, mutate } = useApi<any>(f.withQuery("/api/token-usage") + "&_n=" + f.nonce);

  // 2026-11-06 D-03：页头移出「数据 / 授权」分支，先固定渲染，正文再由 错误 / 授权门 / 数据 决定。
  //   修前：error 分支自带一份页头、正常分支的页头被 FeatureGate 包住（授权门 loading 时整页只剩骨架），
  //   于是 SSR 首屏没有 page-header。现合并为一份；文案、面包屑、取数 / 接口 / 路由均未动。
  const header = (
    <>
      <div className="breadcrumb">
        <span className={styles.crumbDim}>服务</span>
        <span className="sep">/</span>
        <span className="current">成本</span>
      </div>
      <PageHeader>
        <PageTitle>成本</PageTitle>
        <div className="page-subtitle">模型调用量与分摊口径（只统计词元数量，不折算金额）</div>
      </PageHeader>
    </>
  );

  if (error) {
    return (
      <main className="page">
        {header}
        <ErrorBlock message={String(error?.message || "")} onRetry={mutate} />
      </main>
    );
  }

  const loadingAll = loading && !data;
  const byEntry = data?.byEntry ?? [];
  const byModel = data?.byModel ?? [];
  const byAgent = data?.byAgent ?? [];

  return (
    <main className="page">
      {header}
      <FeatureGate feature="console.analytics" label="分析">
        <CostHero data={data} agent={f.agent} />

        {data?.warnings?.length ? (
          <Alert type="info" showIcon className={styles.warnAlert} title="口径提示" description={data.warnings.join("；")} />
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
      </FeatureGate>
    </main>
  );
}
