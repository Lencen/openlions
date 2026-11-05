"use client";
// 2026-11-05 P2 呈现层改造（批 4/5）：内联 style 清零 + 手写 .tbl 表换成白名单表格组件。
//   取数（/api/pipeline-history、/api/flywheel-dashboard）、字段、列（编号/模式/来源/同步/跳过/消息/状态/开始时间）、
//   路由与文案均未动。这张表有"整行点击展开详情"，白名单 DataTable（components/DataTable）不支持展开行，
//   故用同族的 components/common/DataTable（= primitives Table 的薄封装，支持 expandable/onRow），
//   展开详情仍在原行下方，字段一条不少。
import { useState } from "react";
import Link from "next/link";
import { statusLabel, sourceTypeLabel, runModeLabel } from "@/config/systemLabels";
import KPICard from "@/components/KPICard";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";
import ErrorAlert from "@/components/ErrorAlert";
import DataMoment from "@/components/DataMoment";
import DataTable from "@/components/common/DataTable";
import type { TableColumn } from "@/components/primitives";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";
interface P { logs?: Array<{id:string;sourceType:string;sourcePath?:string;status:string;recordsSynced:number;recordsSkipped:number;errorMessage?:string|null;messageCount:number;runMode:string;startedAt:string;completedAt?:string;createdAt:string}>; summary?:{total:number;completed:number;failed:number} }

type LogRow = NonNullable<P["logs"]>[number];

export default function PipelinePage() {
  const [expandedId, setExpandedId] = useState<string|null>(null);
  const { data, loading, error, mutate } = useApi<P>("/api/pipeline-history");
  const { data: dash, error: dashErr } = useApi<{ cronSchedule?: unknown[]; /** 77-AF: 看板自带的"数据时刻" */ timestamp?: string }>("/api/flywheel-dashboard");
  const logs = data?.logs ?? [];
  const summary = data?.summary;

  // 列定义：与改前 <thead> 逐列对应（编号/模式/来源/同步/跳过/消息/状态/开始时间）
  const columns: TableColumn<LogRow>[] = [
    { key: "id", title: "编号", render: (_v, l) => <span className={"nowrap mono " + styles.cellXs}>{l.id?.slice(0,12)}</span> },
    { key: "runMode", title: "模式", render: (_v, l) => <span className="nowrap"><span className="badge badge-blue">{runModeLabel(l.runMode)}</span></span> },
    { key: "sourceType", title: "来源", render: (_v, l) => <span className={"nowrap " + styles.cellSm}>{sourceTypeLabel(l.sourceType)}</span> },
    { key: "recordsSynced", title: "同步", align: "right", render: (_v, l) => l.recordsSynced },
    { key: "recordsSkipped", title: "跳过", align: "right", render: (_v, l) => <span className={styles.dim}>{l.recordsSkipped}</span> },
    { key: "messageCount", title: "消息", align: "right", render: (_v, l) => l.messageCount },
    { key: "status", title: "状态", render: (_v, l) => (
        <span className={"badge " + (l.status==="COMPLETED"?"badge-green":l.status==="FAILED"?"badge-red":"badge-yellow")}>{statusLabel(l.status)}</span>
      ) },
    { key: "startedAt", title: "开始时间", render: (_v, l) => <span className={"nowrap mono " + styles.cellXs}>{l.startedAt?.slice(0,19).replace("T"," ")}</span> },
  ];

  const toggleRow = (id: string) => setExpandedId(expandedId === id ? null : id);

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.bcDim}>业务与系统</span><span className="sep">/</span><span className="current">流水线监控</span></div>
    <PageHeader><PageTitle>流水线监控</PageTitle><div className="page-subtitle">{loading?"（加载中...）":`${logs.length} 条运行记录`}{/* 2026-10-16 round 77-AF: 2 个源各带自己的时刻 —— 本接口(77-AF 补的顶层 asOf) + flywheel-dashboard 的 timestamp。 */}<DataMoment items={[{ label: "管道", at: (data as any)?.asOf }, { label: "定时", at: (dash as any)?.timestamp }]} /></div></PageHeader>
    {/* 2026-10-15（规范 §2）：原来只有一句报错文本, 没有下一步动作 ✗ -> 换成 ErrorAlert(带重试)。 */}
    {(error || dashErr) ? (
      <ErrorAlert
        title="流水线数据加载失败"
        message={String(((error || dashErr) as Error)?.message || (error || dashErr))}
        onRetry={() => { mutate(); }}
      />
    ) : null}
    <div className="kpi-grid">
      <KPICard label="总运行数" value={summary?summary.total.toString():"..."} />
      <KPICard label="成功" value={summary?summary.completed.toString():"..."} />
      <KPICard label="失败" value={summary?summary.failed.toString():"..."} />
      <KPICard label="定时任务" value={dash?.cronSchedule?.length ?? "..."} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">运行历史</span></div>
      {/* 2026-10-15（规范 §2）：这张表提供复制/导出（自动定位模式, 无需 ref）。 */}
      <div className={styles.copyRow}>
        <TableCopyButton exportedName="pipeline-history.csv" />
      </div>
      <DataTable
        columns={columns}
        dataSource={logs.slice(0,50)}
        rowKey="id"
        pagination={false}
        emptyTitle="暂无运行记录"
        onRow={(l: LogRow) => ({ onClick: () => toggleRow(l.id), className: "clickable-row" })}
        expandable={{
          // 展开态仍由页面持有（点击整行或行首展开键都行），详情仍在原行下方
          expandedRowKeys: expandedId ? [expandedId] : [],
          onExpandedRowsChange: (keys) => setExpandedId(keys.length ? String(keys[0]) : null),
          expandedRowRender: (l: LogRow) => (
            <div className={styles.detail}>
              <div><strong>完整编号：</strong> <span className={styles.detailMono}>{l.id}</span></div>
              <div className={styles.detailRow}><strong>来源路径:</strong> <span className={styles.detailMono}>{l.sourcePath||"-"}</span></div>
              <div className={styles.detailRow}><strong>开始:</strong> {l.startedAt?.replace("T"," ").slice(0,19)} · <strong>完成:</strong> {l.completedAt?.replace("T"," ").slice(0,19)||"-"}</div>
              {l.errorMessage && <div className={styles.detailErr}><strong>错误:</strong> {l.errorMessage}</div>}
            </div>
          ),
        }}
      />
    </div>
    {/* 2026-10-19 B5(方案 L3-2): 修前本页正文 0 条出链 ✗。它和"访问日志/自动化执行"用的是**同一个接口**(/api/pipeline-history), 是同一份数据的三个切面 -> 互链是真导航 ✓ */}
    <div className={"tiny " + styles.footLinks}>
      <span>相关视图：</span>
      <Link href="/system/access-log">访问日志 →</Link>
      <Link href="/system/automation">自动化执行 →</Link>
      <Link href="/system/rotation">轮转记录 →</Link>
    </div>
  </main></div>);
}
