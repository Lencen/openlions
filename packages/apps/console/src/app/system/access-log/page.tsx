"use client";
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 手写 .tbl 表 → 白名单 DataTable。
//   取数（/api/pipeline-history）、字段、列、文案、路由语义一字未改。
//   展开详情从「表内一行 colSpan=6」改成表格下方一块详情面板（字段与文案不变，
//   触发从「整行可点」改成「详情」列里的展开/收起按钮，键盘同样可达）。
import { useState } from "react";
import Sparkline from "@/components/Sparkline";
import Link from "next/link";
import KPICard from "@/components/KPICard";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import { t } from "@/i18n";
import { statusLabel } from "@/config/systemLabels";
import TableCopyButton from "@/components/TableCopyButton";
import ErrorAlert from "@/components/ErrorAlert";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

interface LogRow {
  id: string; sourceType: string; sourcePath?: string; status: string;
  recordsSynced: number; recordsSkipped: number; errorMessage?: string | null;
  messageCount: number; runMode: string; startedAt: string; completedAt?: string;
}
interface P { logs?: LogRow[]; summary?: { total: number; completed: number; failed: number } }

export default function AccessLogPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { data, loading, error, mutate } = useApi<P>("/api/pipeline-history");
  const logs = (data?.logs ?? []).slice(0, 50);
  const summary = data?.summary;
  const expanded = logs.find((l) => l.id === expandedId) || null;

  const columns: DataColumn<LogRow>[] = [
    {
      key: "startedAt",
      title: "时间",
      render: (l) => (
        <span className={"mono nowrap " + styles.cellXs}>{l.startedAt?.slice(0, 19).replace("T", " ")}</span>
      ),
    },
    {
      key: "runMode",
      title: "模式",
      render: (l) => <span className="badge badge-blue nowrap">{l.runMode}</span>,
    },
    {
      key: "sourceType",
      title: "来源",
      render: (l) => <span className={styles.cellSm + " nowrap"}>{l.sourceType}</span>,
    },
    { key: "recordsSynced", title: "同步", align: "right", render: (l) => l.recordsSynced },
    {
      key: "status",
      title: "状态",
      render: (l) => (
        <span className={"badge " + (l.status === "COMPLETED" ? "badge-green" : "badge-red")}>{statusLabel(l.status)}</span>
      ),
    },
    {
      key: "detail",
      title: "详情",
      render: (l) => (
        <span className={styles.cellDim}>
          {l.errorMessage ? l.errorMessage.slice(0, 60) : t("status.ok")}
          <button
            type="button"
            className={styles.rowToggle}
            aria-expanded={expandedId === l.id}
            onClick={(e) => { e.stopPropagation(); setExpandedId(expandedId === l.id ? null : l.id); }}
          >
            {expandedId === l.id ? "收起" : "展开"}
          </button>
        </span>
      ),
    },
  ];

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.crumbDim}>业务与系统</span><span className="sep">/</span><span className="current">访问日志</span></div>
    <PageHeader><PageTitle>访问日志</PageTitle><div className="page-subtitle">流水线运行流水 · 异常统计</div></PageHeader>
    <div className="kpi-grid">
      <KPICard label="总运行" value={summary?summary.total.toString():"..."} />
      <KPICard label="成功" value={summary?summary.completed.toString():"..."} />
      <KPICard label="失败" value={summary?summary.failed.toString():"..."} />
      <KPICard label="成功率" value={summary?((summary.completed/summary.total)*100).toFixed(1)+"%":"..."} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">运行日志 {loading&&"（加载中...）"}</span></div>
      {error ? <ErrorAlert title="运行日志加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} /> : null}      {/* 2026-10-19 B7: 修前 0 个 svg ✗ —— 加"最近 20 次运行同步量"迷你趋势(时间正序);
          同源 /api/pipeline-history ✓, 复用既有 Sparkline(不引图表库 ✗)。 */}
      {(logs || []).length > 1 && (
        <div className={"panel " + styles.sparkPanel}>
          <div className="panel-header"><span className="panel-title">最近 {Math.min(20, (logs || []).length)} 次运行 · 同步记录数</span></div>
          <div className={styles.sparkPad}>
            <Sparkline data={(logs || []).slice(0, 20).map((l: any) => Number(l.recordsSynced) || 0).reverse()} width={620} height={48} />
          </div>
        </div>
      )}

      <TableCopyButton />
      <DataTable
        columns={columns}
        rows={logs}
        rowKey={(l, i) => l.id || i}
        // 2026-11-05 热修（uiux 批4/5 走查 P0-2）：整行点击展开/收起恢复；键盘路径仍是「详情」列的原生按钮。
        onRow={(l) => ({ onClick: () => setExpandedId(expandedId === l.id ? null : l.id) })}
        loading={loading && !data}
        error={error ? String((error as Error)?.message || error) : null}
        onRetry={() => { mutate(); }}
        empty={{ title: "暂无运行记录" }}
      />

      {expanded && (
        <div className={styles.detailPanel}>
          <div><strong>编号：</strong> <span className={styles.monoSm}>{expanded.id}</span></div>
          <div className={styles.detailRow}><strong>来源路径:</strong> <span className={styles.monoSm}>{expanded.sourcePath||"-"}</span></div>
          <div className={styles.detailRow}><strong>消息数:</strong> {expanded.messageCount} · <strong>跳过:</strong> {expanded.recordsSkipped}</div>
          <div className={styles.detailRow}><strong>开始:</strong> {expanded.startedAt?.replace("T"," ").slice(0,19)} · <strong>完成:</strong> {expanded.completedAt?.replace("T"," ").slice(0,19)||"-"}</div>
          {expanded.errorMessage && <div className={styles.detailRow + " " + styles.detailErr}><strong>错误:</strong> {expanded.errorMessage}</div>}
        </div>
      )}
    </div>
    {/* 2026-10-19 B5(方案 L3-2): 修前正文 0 出链 ✗; 与流水线监控同源(/api/pipeline-history) ✓ */}
    <div className={"tiny " + styles.related}>
      <span>相关视图：</span>
      <Link href="/system/pipeline">流水线监控 →</Link>
      <Link href="/system/automation">自动化执行 →</Link>
    </div>
  </main></div>);
}
