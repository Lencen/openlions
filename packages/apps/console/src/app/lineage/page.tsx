"use client";
// 2026-09-10 商业化改版: 数据血脉页
// 回答三个问题: ① 数据怎么入的 ② 怎么变的/怎么存的 ③ 怎么被用的 (认领注入)
// 交互: 左侧产物列表点开 → 右侧抽屉展示该条产物的来源回溯 (sourceType/sourceId → 会话/任务/agent)、质量、验证、使用记录
// 2026-09-14 页面瘦身: 各分节抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { useApi, useLazyApi } from "@/lib/api";
import { t } from "@/i18n";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { ErrorBlock } from "@/components/ui";
import LineageHero from "./_components/LineageHero";
import LineageLane from "./_components/LineageLane";
import LineageArtifactsTable from "./_components/LineageArtifactsTable";
import LineageBacklogPanel from "./_components/LineageBacklogPanel";
import LineageSourceMixPanel from "./_components/LineageSourceMixPanel";
import LineageConsumptionPanel from "./_components/LineageConsumptionPanel";
import LineageCompositionPanels from "./_components/LineageCompositionPanels";
import LineageDetailDrawer from "./_components/LineageDetailDrawer";

export default function LineagePage() {
  const f = useGlobalFilter();
  const { data, loading, error, mutate } = useApi<any>(f.withQuery("/api/lineage") + "&_n=" + f.nonce);
  const [sel, setSel] = useState<{ type: string; id: string } | null>(null);
  const detailPath = sel ? `/api/lineage-detail?type=${sel.type}&id=${encodeURIComponent(sel.id)}` : null;
  const { data: detail, loading: detailLoading, error: detailError } = useLazyApi<any>(detailPath);

  if (error) {
    return (
      <main className="page">
        <LineageHero data={undefined} minimal />
        <ErrorBlock message={String(error?.message || "")} onRetry={mutate} />
      </main>
    );
  }

  const loadingAll = loading && !data;
  const stages = data?.stages ?? [];
  const consumption = data?.consumption;
  const backlog = data?.backlog;
  const byTable = data?.products?.byTable ?? {};
  const sourceMix = data?.sourceMix ?? [];
  const artifacts = data?.artifacts ?? [];

  return (
    <main className="page">
      <LineageHero data={data} agent={f.agent} theme={f.theme} />

      {data?.warnings?.length ? (
        <Alert type="warning" showIcon style={{ marginBottom: "var(--sp-4)" }} title="部分数据源降级" description={data.warnings.join("；")} />
      ) : null}

      {/* ---------- 1. 端到端链路 ---------- */}
      <LineageLane stages={stages} loadingAll={loadingAll} />

      {/* ---------- 2. 产物血缘浏览器 ---------- */}
      <div className="card-grid main-side">
        <LineageArtifactsTable artifacts={artifacts} loadingAll={loadingAll} onSelect={setSel} />

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <LineageBacklogPanel backlog={backlog} loadingAll={loadingAll} />
          <LineageSourceMixPanel sourceMix={sourceMix} loadingAll={loadingAll} />
          <LineageConsumptionPanel consumption={consumption} loadingAll={loadingAll} />
        </div>
      </div>

      {/* ---------- 3. 验证状态 + 产物构成 ---------- */}
      <LineageCompositionPanels data={data} byTable={byTable} consumption={consumption} loadingAll={loadingAll} />

      {/* ---------- 4. 详情抽屉 ---------- */}
      <LineageDetailDrawer sel={sel} detail={detail} detailLoading={detailLoading} detailError={detailError} onClose={() => setSel(null)} />

      <div className="tiny" style={{ textAlign: "right" }}>
        {t('lineage.source')}{" "}
        {data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
      </div>
      {/* 2026-10-19 B5: 修前本页正文 0 条出链 ✗；补"相关视图"（每条都指向真实相关页, 非凑数）✓ */}
      <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
        <span>相关视图：</span>
        <Link href="/cognitive/knowledge">知识库 →</Link>
        <Link href="/flywheel/tasks">改进任务 →</Link>
      </div>
    </main>
  );
}
