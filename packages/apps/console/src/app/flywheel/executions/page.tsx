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
  const { data, loading, error, mutate } = useApi<T>("/api/flywheel-tasks?status=DONE&limit=50&range=7d&_n=" + f.nonce);
  const { data: stats } = useApi<S>("/api/flywheel-stats");
  const items = data?.items ?? [];
  const st = stats?.data;
  const taskStats = st?.tasks ?? {};
  const done = taskStats.DONE ?? 0;
  const failed = taskStats.FAILED ?? 0;

  // 列定义：与改前 <thead> 逐列对应（任务编号/类型/状态/标题/时间）
  const columns: TableColumn<ExecRow>[] = [
    { key: "id", title: t('field.taskId'), render: (_v, r) => <span className={"nowrap mono " + styles.cellSm}>{r.id.slice(0,12)}</span> },
    { key: "status", title: "状态", render: (_v, r) => (
        <span className="nowrap"><span className={"badge " + (r.status==="DONE"?"badge-green":r.status==="FAILED"?"badge-red":"badge-yellow")}>{r.status}</span></span>
      ) },
    { key: "title", title: "标题", render: (_v, r) => (
        <span className={styles.titleCell} data-open={expandedId===r.id}>
          {r.title?.slice(0,60)||(r.id.slice(0,12)+"...")}
        </span>
      ) },
    { key: "agentId", title: "智能体", render: (_v, r) => <span className="mono">{(r as any).assignedAgent ?? (r as any).agentId ?? "n/a（接口未返回）"}</span> },
    { key: "durationMs", title: "耗时", render: (_v, r) => <span className="mono">{(r as any).durationMs != null ? Math.round((r as any).durationMs / 1000) + "s" : "n/a（接口未返回）"}</span> },
    { key: "result", title: "结果", render: (_v, r) => <span className="nowrap">{r.status === "DONE" ? "成功" : r.status === "FAILED" ? "失败" : r.status === "PENDING" ? "待处理" : "n/a"}</span> },
    { key: "createdAt", title: "时间", render: (_v, r) => (
        <span className={"nowrap mono " + styles.cellSm} title={r.createdAt ? new Date(r.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : ""}>{fmtDT(r.createdAt)}</span>
      ) },
  ];

  const toggleRow = (id: string) => setExpandedId(expandedId === id ? null : id);

  return (<div className="layout-with-sidebar"><main className={"main " + styles.b2main} data-slot="flywheel-executions-page">
    <div className="breadcrumb"><span className={styles.bcDim}>飞轮引擎</span><span className="sep">/</span><span className="current">执行记录</span></div>
    <PageHeader><PageTitle>执行记录</PageTitle><div className="page-subtitle">{st?`${t('status.done')} ${done} · ${t('status.failed')} ${failed} · ${t('status.inProgress')} ${taskStats.IN_PROGRESS == null ? "n/a" : taskStats.IN_PROGRESS}`:"加载中..."}{/* 2026-10-16 round 77-AD（决策③逐源 + 77-M 机检清单）: 本页有 **2 个源** ——    /api/flywheel-tasks（下方任务列表）与 /api/flywheel-stats（这里三个计数）。    此前本页**没有时刻** ✗ -> 两组数字的新旧都无法判断。    本轮给 flywheel-tasks 补了顶层 asOf（stats 侧 77-P 已有）, 故这里是纯页面改动 ✓。 */}<span className="tiny">数据时刻：指标 {((stats as any)?.asOf) ? new Date((stats as any).asOf).toLocaleString("zh-CN", { hour12: false }) : "n/a（接口未下发 asOf）"} · 任务 {((data as any)?.asOf) ? new Date((data as any).asOf).toLocaleString("zh-CN", { hour12: false }) : "n/a（接口未下发 asOf）"}</span></div></PageHeader>
      <div className={styles.chips} aria-label="页面层级"><span>#</span><span>飞轮</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>
      <div className={styles.b2grid}>
    <div className={"kpi-grid " + styles.slotS12} data-slot="flywheel-executions-kpi">
      <KPICard label={t('status.done')} value={st ? done.toString() : "…"} />
      <KPICard label={t('status.failed')} value={st ? failed.toString() : "…"} />
      <KPICard label={t('status.inProgress')} value={taskStats.IN_PROGRESS == null ? "n/a" : String(taskStats.IN_PROGRESS)} />
      <KPICard label={t('status.pending')} value={taskStats.PENDING == null ? "n/a" : String(taskStats.PENDING)} />
    </div>
    <div className={"panel " + styles.slotS12}><div className="panel-header"><span className="panel-title">任务执行流水（窗口 7d（默认）；返回 {items.length} 条，真总量 {(data as any)?.scopeCounts?.ALL?.count?.toLocaleString?.("zh-CN") ?? "n/a"}）{loading&&"（加载中...）"}</span></div>
      {error ? <ErrorAlert title="执行记录加载失败" message="执行记录数据接口请求失败（网络错误或响应状态码异常），请重试；状态码见控制台。" onRetry={() => { mutate(); }} /> : null}
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
  </div></main></div>);
}