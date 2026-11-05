"use client";
import { Fragment, useState } from "react";
import Link from "next/link";
import { statusLabel, sourceTypeLabel, runModeLabel } from "@/config/systemLabels";
import { interactiveProps } from "@/components/a11y";
import KPICard from "@/components/KPICard";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import { t } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";
import ErrorAlert from "@/components/ErrorAlert";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
interface P { logs?:Array<{id:string;sourceType:string;status:string;recordsSynced:number;runMode:string;startedAt:string;completedAt?:string}>; summary?:{total:number;completed:number;failed:number} }
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
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>业务与系统</span><span className="sep">/</span><span className="current">{t('automation.title')}</span></div>
    <PageHeader><PageTitle>{t('automation.title')}</PageTitle><div className="page-subtitle">{t('automation.subtitle')}</div></PageHeader>
    <div className="kpi-grid">
      <KPICard label={t('automation.kpi')} value={crons.length.toString()} />
      <KPICard label="总执行" value={summary?summary.total.toString():"..."} />
      <KPICard label="成功率" value={summary?((summary.completed/summary.total)*100).toFixed(1)+"%":"..."} />
      <KPICard label="失败" value={summary?summary.failed.toString():"0"} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">{t('automation.list')}</span></div>
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>{t('automation.col.name')}</th><th>{t('automation.col.freq')}</th><th>{t('automation.col.cron')}</th><th>{t('automation.col.desc')}</th><th>{t('automation.col.status')}</th></tr></thead><tbody>
        {crons.map((c,i)=>(<tr key={i}>
          <td className="nowrap"><b>{c.name}</b></td>
          <td className="nowrap">{c.schedule}</td>
          <td className="nowrap mono" style={{fontSize: "var(--fs-sm)"}}>{c.cron}</td>
          <td style={{fontSize: "var(--fs-sm)",color:"var(--text-dim)"}}>{c.desc}</td>
          <td><span className="badge badge-green">{t('status.scheduled')}</span></td>
        </tr>))}
      </tbody></table></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">最近执行记录 {loading&&"（加载中...）"}</span></div>
      {error ? <ErrorAlert title="执行记录加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} /> : null}
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>时间</th><th>模式</th><th>同步数</th><th>状态</th></tr></thead><tbody>
        {logs.map((l,i)=>(
          <Fragment key={l.id}><tr key={l.id} {...interactiveProps(expandedId===l.id)} style={{cursor:"pointer"}} onClick={()=>setExpandedId(expandedId===l.id?null:l.id)}>
            <td className="nowrap mono" style={{fontSize: "var(--fs-xs)"}}>{l.startedAt?.slice(0,19).replace("T"," ")}</td>
            <td className="nowrap">{runModeLabel(l.runMode)}</td>
            <td className="num">{l.recordsSynced}</td>
            <td><span className={`badge ${l.status==="COMPLETED"?"badge-green":"badge-red"}`}>{statusLabel(l.status)}</span></td>
          </tr>
          {expandedId===l.id && (
            <tr key={l.id+"-exp"}><td colSpan={4} style={{background:"var(--bg-hover)",padding: "var(--sp-3)"}}>
              <div><strong>编号：</strong> <span style={{fontFamily:"var(--font-mono)",fontSize: "var(--fs-sm)"}}>{l.id}</span></div>
              <div style={{marginTop: "var(--sp-1)"}}><strong>来源:</strong> {sourceTypeLabel(l.sourceType)} · <strong>完成:</strong> {l.completedAt?.replace("T"," ").slice(0,19)||"-"}</div>
            </td></tr>
          )}
          </Fragment>
        ))}
        {!loading && !error && logs.length === 0 && <tr><td colSpan={4} style={{padding: "var(--sp-5)",color:"var(--text-dim)",textAlign:"center"}}>暂无执行记录</td></tr>}
      </tbody></table></div>
    {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/system/pipeline">流水线监控 →</Link>
      <Link href="/system/access-log">访问日志 →</Link>
    </div>
  </main></div>);
}