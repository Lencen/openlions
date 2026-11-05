"use client";
// 2026-11-05 P2 呈现层改造（批 4/5）：内联 style 清零 + 手写 .tbl 表 → 白名单表格组件。
//   这张表有"整行点击展开详情"（详情在下一行），白名单 DataTable（components/DataTable）不支持展开行，
//   故用同族的 components/common/DataTable（= primitives Table 的薄封装，支持 expandable/onRow）。
//   列（任务编号/类型/状态/标题/时间）、字段、取数端点与文案均未动；标题在展开时的强调色改由 data-open 承载。
import { useGlobalFilter } from "@/components/GlobalFilter";
import Link from "next/link";
import { useState } from "react";
import KPICard from "@/components/KPICard";
import { useApi } from "@/lib/api";
import { Alert, Empty, Skeleton } from "@/components/primitives";
import { t } from "@/i18n";
import ErrorAlert from "@/components/ErrorAlert";
import DataMoment from "@/components/DataMoment";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/common/DataTable";
import type { TableColumn } from "@/components/primitives";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

interface T { total?:number; items?:Array<{id:string;type?:string;status:string;title?:string;description?:string;createdAt?:string;targetType?:string;targetId?:string;measuredDelta?:number;actionType?:string}> }
interface S { data?:{tasks?:any} }
type ExecRow = NonNullable<T["items"]>[number];

// 2026-09-02: createdAt 只显示日期没时间 — 改成 MM-DD HH:mm:ss (本地时区)
const fmtDT = (iso?: string) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export default function ExecutionsPage() {
  const [expandedId, setExpandedId] = useState<string|null>(null);
  // 2026-10-13 round 76-BG: 接入全局时间范围(用户决策③)
  const f = useGlobalFilter();
  const { data, loading, error, mutate } = useApi<T>("/api/flywheel-tasks?status=DONE&limit=50&range=" + f.range + "&_n=" + f.nonce);
  const { data: stats } = useApi<S>("/api/flywheel-stats");
  const items = data?.items ?? [];
  const st = stats?.data;
  const taskStats = st?.tasks ?? {};
  const done = taskStats.DONE ?? 0;
  const failed = taskStats.FAILED ?? 0;

  // 列定义：与改前 <thead> 逐列对应（任务编号/类型/状态/标题/时间）
  const columns: TableColumn<ExecRow>[] = [
    { key: "id", title: t('field.taskId'), render: (_v, r) => <span className={"nowrap mono " + styles.cellSm}>{r.id.slice(0,12)}</span> },
    { key: "type", title: "类型", render: (_v, r) => <span className="nowrap">{r.type||r.actionType||"-"}</span> },
    { key: "status", title: "状态", render: (_v, r) => (
        <span className="nowrap"><span className={"badge " + (r.status==="DONE"?"badge-green":r.status==="FAILED"?"badge-red":"badge-yellow")}>{r.status}</span></span>
      ) },
    { key: "title", title: "标题", render: (_v, r) => (
        <span className={styles.titleCell} data-open={expandedId===r.id}>
          {r.title?.slice(0,60)||(r.id.slice(0,12)+"...")}
        </span>
      ) },
    { key: "createdAt", title: "时间", render: (_v, r) => (
        <span className={"nowrap mono " + styles.cellSm} title={r.createdAt ? new Date(r.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : ""}>{fmtDT(r.createdAt)}</span>
      ) },
  ];

  const toggleRow = (id: string) => setExpandedId(expandedId === id ? null : id);

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.bcDim}>飞轮引擎</span><span className="sep">/</span><span className="current">执行记录</span></div>
    <PageHeader><PageTitle>执行记录</PageTitle><div className="page-subtitle">{st?`${t('status.done')} ${done} · ${t('status.failed')} ${failed} · ${t('status.inProgress')} ${taskStats.IN_PROGRESS??0}`:"加载中..."}{/* 2026-10-16 round 77-AD（决策③逐源 + 77-M 机检清单）: 本页有 **2 个源** ——    /api/flywheel-tasks（下方任务列表）与 /api/flywheel-stats（这里三个计数）。    此前本页**没有时刻** ✗ -> 两组数字的新旧都无法判断。    本轮给 flywheel-tasks 补了顶层 asOf（stats 侧 77-P 已有）, 故这里是纯页面改动 ✓。 */}<DataMoment items={[{ label: "指标", at: (stats as any)?.asOf }, { label: "任务", at: (data as any)?.asOf }]} /></div></PageHeader>
    <div className="kpi-grid">
      <KPICard label={t('status.done')} value={done.toString()} />
      <KPICard label={t('status.failed')} value={failed.toString()} />
      <KPICard label={t('status.inProgress')} value={(taskStats.IN_PROGRESS??0).toString()} />
      <KPICard label={t('status.pending')} value={(taskStats.PENDING??0).toString()} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">任务执行流水 {loading&&"（加载中...）"}</span></div>
      {error ? <ErrorAlert title="执行记录加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} /> : null}
      {loading && !data && <div className={styles.skelPad}><Skeleton active title={false} paragraph={{rows:5}} /></div>}
      {!loading && !error && items.length === 0 && <Empty description="暂无执行记录" />}
      {items.length > 0 && !error && <>
        <TableCopyButton />
        <DataTable
          columns={columns}
          dataSource={items}
          rowKey="id"
          pagination={false}
          emptyTitle="暂无执行记录"
          onRow={(r: ExecRow) => ({ onClick: () => toggleRow(r.id), className: "clickable-row" })}
          expandable={{
            expandedRowKeys: expandedId ? [expandedId] : [],
            onExpandedRowsChange: (keys) => setExpandedId(keys.length ? String(keys[0]) : null),
            expandedRowRender: (r: ExecRow) => (
              <div className={styles.detail}>
                <div className={styles.detailRowFirst}><strong>完整描述:</strong> <span className={styles.descText}>{r.description||"(无描述)"}</span></div>
                {r.targetType && <div><strong>目标:</strong> <span className={styles.cellBase}>{r.targetType}: {r.targetId||"-"}</span></div>}
                {r.measuredDelta!==undefined && <div className={styles.detailRow}>
                  <strong>实测变化:</strong> <span data-tone={r.measuredDelta>0?"ok":"muted"}>{r.measuredDelta>0?"+":""}{r.measuredDelta.toFixed(4)}</span>
                </div>}
              </div>
            ),
          }}
        />
        </>}</div>
    {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className={"tiny " + styles.footLinks}>
      <span>相关视图：</span>
      <Link href="/flywheel/tasks">改进任务 →</Link>
      <Link href="/system/pipeline">流水线监控 →</Link>
    </div>
  </main></div>);
}
