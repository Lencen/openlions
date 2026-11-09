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
import { ErrorBlock, Pill } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import LineageLane from "./_components/LineageLane";
import LineageArtifactsTable from "./_components/LineageArtifactsTable";
import LineageBacklogPanel from "./_components/LineageBacklogPanel";
import LineageSourceMixPanel from "./_components/LineageSourceMixPanel";
import LineageConsumptionPanel from "./_components/LineageConsumptionPanel";
import LineageCompositionPanels from "./_components/LineageCompositionPanels";
import LineageDetailDrawer from "./_components/LineageDetailDrawer";
import styles from "./page.module.css";

// 2026-11-05 页头口径统一（PAGE-HEADER-31 §3）：原来用自写的 LineageHero（内含 PageHero）当页头，
//   换成白名单 PageHeader；标题 / 一句说明 / 面包屑逐字取表（数据 / 血缘）。取数、表格、抽屉与交互均未动。
function LineageHeader({ data, agent, theme }: { data?: any; agent?: string | null; theme?: string | null }) {
  return (
    <>
      <div className="breadcrumb">
        <span className={styles.crumbDim}>数据</span>
        <span className="sep">/</span>
        <span className="current">血缘</span>
      </div>
      <PageHeader>
        <PageTitle>血缘</PageTitle>
        <div className="page-subtitle">数据与产物的上下游关系</div>
      </PageHeader>
      {/* 2026-11-05：原 LineageHero 的 tags/meta（当前窗口 / 生效筛选 / 窗口内新增产物）不随 hero 一起丢，
          收成页头下一行；解析对象与改前一致（data.range.label、f.agent、f.theme、data.products.total）。 */}
      <div className={"tiny " + styles.headerMeta}>
        <Pill tone="info">{data?.range?.label || "近 24 小时"}</Pill>
        {agent ? <Pill tone="mute">{t('lineage.filterAgent', { id: agent })}</Pill> : null}
        {theme ? <Pill tone="mute">主题: {theme}</Pill> : null}
        <span>窗口内新增产物 {fmtNum(data?.products?.total)}</span>
      </div>
    </>
  );
}

export default function LineagePage() {
  const f = useGlobalFilter();
  const { data, loading, error, mutate } = useApi<any>(f.withQuery("/api/lineage") + "&_n=" + f.nonce);
  const [sel, setSel] = useState<{ type: string; id: string } | null>(null);
  const detailPath = sel ? `/api/lineage-detail?type=${sel.type}&id=${encodeURIComponent(sel.id)}` : null;
  const { data: detail, loading: detailLoading, error: detailError } = useLazyApi<any>(detailPath);

  if (error) {
    return (
      <main className="page">
        <LineageHeader data={undefined} />
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
      <LineageHeader data={data} agent={f.agent} theme={f.theme} />

      {data?.warnings?.length ? (
        <Alert type="warning" showIcon className={styles.warnAlert} title="部分数据源降级" description={data.warnings.join("；")} />
      ) : null}

      {/* ---------- 1. 端到端链路 ---------- */}
      <LineageLane stages={stages} loadingAll={loadingAll} />

      {/* ---------- 2. 产物血缘浏览器 ---------- */}
      <div className="card-grid main-side">
        <LineageArtifactsTable artifacts={artifacts} loadingAll={loadingAll} onSelect={setSel} />

        <div className={styles.sideCol}>
          <LineageBacklogPanel backlog={backlog} loadingAll={loadingAll} />
          <LineageSourceMixPanel sourceMix={sourceMix} loadingAll={loadingAll} />
          <LineageConsumptionPanel consumption={consumption} loadingAll={loadingAll} />
        </div>
      </div>

      {/* ---------- 3. 验证状态 + 产物构成 ---------- */}
      <LineageCompositionPanels data={data} byTable={byTable} consumption={consumption} loadingAll={loadingAll} />

      {/* ---------- 4. 详情抽屉 ---------- */}
      <LineageDetailDrawer sel={sel} detail={detail} detailLoading={detailLoading} detailError={detailError} onClose={() => setSel(null)} />

      <div className={"tiny " + styles.asOf}>
        {t('lineage.source')}{" "}
        {data?.asOf ? new Date(data.asOf).toLocaleString("zh-CN", { hour12: false }) : "-"}
      </div>
      {/* 2026-10-19 B5: 修前本页正文 0 条出链 ✗；补"相关视图"（每条都指向真实相关页, 非凑数）✓ */}
      <div className={"tiny " + styles.related}>
        <span>相关视图：</span>
        <Link href="/cognitive/knowledge">知识库 →</Link>
        <Link href="/flywheel/tasks">改进任务 →</Link>
      </div>
    </main>
  );
}
