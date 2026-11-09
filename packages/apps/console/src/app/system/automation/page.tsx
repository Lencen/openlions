"use client";
// 2026-11-05 P2 批6（呈现层）：内联 style 清零 + 两张手写 .tbl 裸表 → 白名单 @/components/DataTable。
//   · 定时任务表（5 列：名称/频率/cron/描述/状态）列与数据一条不少；
//   · 最近执行记录表（4 列：时间/模式/同步数/状态）保留「整行点击展开详情」——
//     白名单 DataTable 只做列渲染、没有 onRow/展开行，所以整行点击在页面层用事件委托实现（同 /system/guards 的做法），
//     键盘可达由时间列的原生 <button> 承担（Enter/Space + aria-expanded），
//     展开内容（编号 / 来源 / 完成）原样显示在表格下方的详情块里，字段一条不少。
//   注意：未动用 E1 例外表（可展开的公共表封装，只减不增）。
//   取数（/api/pipeline-history）、文案、KPI 与导出（TableCopyButton）均未动。
import { useState } from "react";
import type { MouseEvent } from "react";
import Link from "next/link";
import { statusLabel, sourceTypeLabel, runModeLabel } from "@/config/systemLabels";
import KPICard from "@/components/KPICard";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import { t } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";
import ErrorAlert from "@/components/ErrorAlert";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";
interface P { logs?:Array<{id:string;sourceType:string;status:string;recordsSynced:number;runMode:string;startedAt:string;completedAt?:string}>; summary?:{total:number;completed:number;failed:number} }
type LogRow = NonNullable<P["logs"]>[number];
type CronRow = { name: string; schedule: string; cron: string; desc: string };
export default function AutomationPage() {
  const [expandedId, setExpandedId] = useState<string|null>(null);
  const { data, loading, error, mutate } = useApi<P>("/api/pipeline-history");
  const logs = (data?.logs ?? []).slice(0,20);
  const summary = data?.summary;
  const crons = [
    { name: "lions-pipeline-hermes", schedule: "每 15 分钟", cron: "*/15 * * * *", desc: t('automation.job1') },
    { name: "lions-sync-cron", schedule: "每 10 分钟", cron: "*/10 * * * *", desc: t('automation.job2', { n: 4 }) },
    { name: "lions-daily-reflect", schedule: "每天 23:50", cron: "50 23 * * *", desc: t('automation.job3') },
  ];
  const expanded = logs.find((l) => l.id === expandedId) ?? null;
  const toggle = (id: string) => setExpandedId(expandedId === id ? null : id);
  // 2026-11-05 P2 批6：整行可点 → 展开/收起。白名单 DataTable 没有 onRow，这里在页面层做事件委托；
  //   点在按钮/链接/输入框上不触发（时间列那个按钮自己处理），空态/错误态行不触发。
  function onTableClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null;
    if (!target || target.closest("a,button,input,select,textarea,label,[role=menu]")) return;
    const tr = target.closest("tbody tr") as HTMLTableRowElement | null;
    if (!tr || tr.classList.contains("dt-state-row")) return;
    const body = tr.parentElement;
    if (!body) return;
    const i = Array.prototype.indexOf.call(body.children, tr);
    const l = logs[i];
    if (l && l.id) toggle(l.id);
  }
  // 定时任务表：与改前表头逐列对应
  const cronColumns: DataColumn<CronRow>[] = [
    { key: "name", title: t('automation.col.name'), render: (c) => <b className="nowrap">{c.name}</b> },
    { key: "schedule", title: t('automation.col.freq'), render: (c) => <span className="nowrap">{c.schedule}</span> },
    { key: "cron", title: t('automation.col.cron'), render: (c) => <span className={"nowrap mono " + styles.sm}>{c.cron}</span> },
    { key: "desc", title: t('automation.col.desc'), render: (c) => <span className={styles.smDim}>{c.desc}</span> },
    { key: "status", title: t('automation.col.status'), render: () => <span className="badge badge-green">{t('status.scheduled')}</span> },
  ];
  // 最近执行记录表：与改前表头逐列对应
  const logColumns: DataColumn<LogRow>[] = [
    { key: "startedAt", title: "时间", render: (l) => (
      <button type="button" className={styles.rowToggle} data-open={expandedId === l.id ? "true" : "false"} aria-expanded={expandedId === l.id} aria-controls="exec-detail" onClick={() => toggle(l.id)} title="展开/收起这条执行记录的详情">
        <span className={"mono " + styles.xs}>{l.startedAt?.slice(0,19).replace("T"," ")}</span>
        <span className={styles.caret} aria-hidden="true">▸</span>
      </button>
    ) },
    { key: "runMode", title: "模式", render: (l) => <span className="nowrap">{runModeLabel(l.runMode)}</span> },
    { key: "recordsSynced", title: "同步数", align: "right", render: (l) => <span className="mono">{l.recordsSynced}</span> },
    { key: "status", title: "状态", render: (l) => <span className={`badge ${l.status==="COMPLETED"?"badge-green":"badge-red"}`}>{statusLabel(l.status)}</span> },
  ];
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.bcDim}>业务与系统</span><span className="sep">/</span><span className="current">{t('automation.title')}</span></div>
    <PageHeader><PageTitle>{t('automation.title')}</PageTitle><div className="page-subtitle">{t('automation.subtitle')}</div></PageHeader>
    <div className="kpi-grid">
      <KPICard label={t('automation.kpi')} value={crons.length.toString()} />
      <KPICard label="总执行" value={summary?summary.total.toString():"..."} />
      <KPICard label="成功率" value={summary?((summary.completed/summary.total)*100).toFixed(1)+"%":"..."} />
      <KPICard label="失败" value={summary?summary.failed.toString():"0"} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">{t('automation.list')}</span></div>
      <TableCopyButton />
      <DataTable columns={cronColumns} rows={crons} rowKey={(c) => c.name} /></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">最近执行记录 {loading&&"（加载中...）"}</span></div>
      {error ? <ErrorAlert title="执行记录加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} /> : null}
      <TableCopyButton />
      <div className={styles.logList} onClick={onTableClick}>
        <DataTable
          columns={logColumns}
          rows={logs}
          rowKey={(l) => l.id}
          loading={loading}
          empty={{ title: error ? "执行记录加载失败（见上方提示）" : "暂无执行记录" }}
        />
      </div>
      {/* 2026-11-05 P2 批6：展开详情（原折叠 tr 的 td 里的两行内容，字段一条不少）。
          容器常驻 + hidden 切换，保证时间列按钮的 aria-controls="exec-detail" 始终指向存在的节点。 */}
      <div className={styles.detailBox} id="exec-detail" hidden={!expanded}>
        <div><strong>编号：</strong> <span className={"mono " + styles.sm}>{expanded?.id}</span></div>
        <div className={styles.detailLine}><strong>来源:</strong> {expanded ? sourceTypeLabel(expanded.sourceType) : "-"} · <strong>完成:</strong> {expanded ? (expanded.completedAt?.replace("T"," ").slice(0,19)||"-") : "-"}</div>
      </div>
    </div>
    {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className={"tiny " + styles.footLinks}>
      <span>相关视图：</span>
      <Link href="/system/pipeline">流水线监控 →</Link>
      <Link href="/system/access-log">访问日志 →</Link>
    </div>
  </main></div>);
}
