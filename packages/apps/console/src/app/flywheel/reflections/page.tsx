"use client";
// 2026-09-14 页面瘦身: 列表与详情抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import type { Refl, Stats } from "./_components/reflectionsShared";
import ReflectionsHeader from "./_components/ReflectionsHeader";
import ReflectionsListTable from "./_components/ReflectionsListTable";
import { useGlobalFilter } from "@/components/GlobalFilter";
import ErrorAlert from "@/components/ErrorAlert";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import { t } from "@/i18n";
import styles from "./page.module.css";

export default function ReflectionsPage() {
  // 2026-10-13 round 76-CA: 接入顶栏时间范围(③)。
  const f = useGlobalFilter();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, Refl>>({});
  // 2026-10-13 round 76-CE: 列表与统计改用 useApi(path, { pollMs: 0 }) ——
  //   它自带**序号守卫**(只接受最新一次响应)与非 2xx 错误通道, 于是**不必再手写 fetch + alive 守卫**
  //   (76-CA 给本页手写过一版; 76-CD 给 useApi 加了 pollMs 之后就可以删掉了)。
  const { data: listData, error: listError, loading, mutate } = useApi<{ items?: Refl[] }>(
    "/api/flywheel-reflections?limit=100&range=" + f.range + "&_n=" + f.nonce, { pollMs: 0 });
  const { data: statsData } = useApi<{ data?: Stats }>("/api/flywheel-stats", { pollMs: 0 });
  const items: Refl[] = listData?.items ?? [];
  const stats = statsData?.data ?? null;
  // 2026-10-13 (round 75-C): 该页原来**没有错误通道**, 主列表加载失败被 catch {} 静默 -> 页面像"没有数据"。
  const err = listError ? String((listError as Error)?.message || listError) : null;

  const loadDetail = async (id: string) => {
    try {
      const res = await fetch("/api/flywheel-reflections?detail=" + encodeURIComponent(id), { cache: "no-store" });
      const d = await res.json();
      setDetail((p) => ({ ...p, [id]: d }));
    } catch {}
  };
  const open = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!detail[id]) await loadDetail(id);
  };
  // 2026-09-10 建议2: 放行后刷新详情(不折叠)
  const reload = async (id: string) => { await loadDetail(id); };
  const st = stats?.reflections;
  const rows = items;
  return (
    <div className="layout-with-sidebar"><main className="main">
      {/* 2026-11-05 页头口径统一（UIUX PAGE-HEADER-31 §3 #11）：面包屑 / 标题 / 一句说明上移到本文件，
          ReflectionsHeader 只剩指标带。标题与说明逐字取自口径表；副标题尾部保留改前就有的
          条数与成功/失败/覆盖（口径未变），不新增别的统计。 */}
      <div className="breadcrumb"><span className={styles.reflCrumbDim}>飞轮</span><span className="sep">/</span><span className="current">反思</span></div>
      <PageHeader>
        <PageTitle>反思</PageTitle>
        <div className="page-subtitle">反思条目与提炼结果{loading ? " · 加载中…" : " · " + rows.length + " 条 · 全库 " + t('status.ok') + " " + (st?.ok ?? "?") + " / " + t('status.failed') + " " + (st?.failed ?? "?") + " · 发现覆盖 " + (((stats?.structuredFindings?.rate ?? 0) * 100).toFixed(1)) + "%"}</div>
      </PageHeader>
      <ReflectionsHeader st={st} />
      {err ? <div className={styles.pageErrWrap}><ErrorAlert title="反思列表加载失败" message={err} onRetry={() => { mutate(); }} /></div> : null}
      <ReflectionsListTable rows={rows} loading={loading} expandedId={expandedId} detail={detail} onOpen={open} onReload={reload} />
      {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className={"tiny " + styles.relatedLinks}>
        <span>相关视图：</span>
        <Link href="/cognitive/reflection">反思资产 →</Link>
        <Link href="/flywheel/tasks">反思→任务 →</Link>
      </div>
    </main></div>
  );
}
