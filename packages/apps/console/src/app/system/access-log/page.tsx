"use client";
import { Fragment, useState } from "react";
import Sparkline from "@/components/Sparkline";
import Link from "next/link";
import { interactiveProps } from "@/components/a11y";
import KPICard from "@/components/KPICard";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import { t } from "@/i18n";
import { statusLabel } from "@/config/systemLabels";
import TableCopyButton from "@/components/TableCopyButton";
import ErrorAlert from "@/components/ErrorAlert";
interface P { logs?:Array<{id:string;sourceType:string;sourcePath?:string;status:string;recordsSynced:number;recordsSkipped:number;errorMessage?:string|null;messageCount:number;runMode:string;startedAt:string;completedAt?:string}>; summary?:{total:number;completed:number;failed:number} }
export default function AccessLogPage() {
  const [expandedId, setExpandedId] = useState<string|null>(null);
  const { data, loading, error, mutate } = useApi<P>("/api/pipeline-history");
  const logs = (data?.logs ?? []).slice(0,50);
  const summary = data?.summary;
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>业务与系统</span><span className="sep">/</span><span className="current">访问日志</span></div>
    <div className="page-header"><div className="page-title">访问日志</div><div className="page-subtitle">流水线运行流水 · 异常统计</div></div>
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
        <div className="panel" style={{ marginBottom: "var(--sp-3)" }}>
          <div className="panel-header"><span className="panel-title">最近 {Math.min(20, (logs || []).length)} 次运行 · 同步记录数</span></div>
          <div style={{ padding: "var(--sp-3)" }}>
            <Sparkline data={(logs || []).slice(0, 20).map((l: any) => Number(l.recordsSynced) || 0).reverse()} width={620} height={48} />
          </div>
        </div>
      )}

      <TableCopyButton />
      <table className="tbl"><thead><tr><th>时间</th><th>模式</th><th>来源</th><th>同步</th><th>状态</th><th>详情</th></tr></thead><tbody>
        {logs.map((l,i)=>(
          <Fragment key={l.id}><tr key={l.id} {...interactiveProps(expandedId===l.id)} style={{cursor:"pointer"}} onClick={()=>setExpandedId(expandedId===l.id?null:l.id)}>
            <td className="nowrap mono" style={{fontSize: "var(--fs-xs)"}}>{l.startedAt?.slice(0,19).replace("T"," ")}</td>
            <td className="nowrap"><span className="badge badge-blue">{l.runMode}</span></td>
            <td className="nowrap" style={{fontSize: "var(--fs-sm)"}}>{l.sourceType}</td>
            <td className="num">{l.recordsSynced}</td>
            <td><span className={`badge ${l.status==="COMPLETED"?"badge-green":"badge-red"}`}>{statusLabel(l.status)}</span></td>
            <td style={{fontSize: "var(--fs-sm)",color:"var(--text-dim)"}}>{l.errorMessage?l.errorMessage.slice(0,60):t('status.ok')}</td>
          </tr>
          {expandedId===l.id && (
            <tr key={l.id+"-exp"}><td colSpan={6} style={{background:"var(--bg-hover)",padding: "var(--sp-3)"}}>
              <div><strong>编号：</strong> <span style={{fontFamily:"var(--font-mono)",fontSize: "var(--fs-sm)"}}>{l.id}</span></div>
              <div style={{marginTop: "var(--sp-1)"}}><strong>来源路径:</strong> <span style={{fontFamily:"var(--font-mono)",fontSize: "var(--fs-sm)"}}>{l.sourcePath||"-"}</span></div>
              <div style={{marginTop: "var(--sp-1)"}}><strong>消息数:</strong> {l.messageCount} · <strong>跳过:</strong> {l.recordsSkipped}</div>
              <div style={{marginTop: "var(--sp-1)"}}><strong>开始:</strong> {l.startedAt?.replace("T"," ").slice(0,19)} · <strong>完成:</strong> {l.completedAt?.replace("T"," ").slice(0,19)||"-"}</div>
              {l.errorMessage && <div style={{marginTop: "var(--sp-1)",color:"var(--status-crit)"}}><strong>错误:</strong> {l.errorMessage}</div>}
            </td></tr>
          )}
          </Fragment>
        ))}
        {!loading && !error && logs.length === 0 && <tr><td colSpan={6} style={{padding: "var(--sp-5)",color:"var(--text-dim)",textAlign:"center"}}>暂无运行记录</td></tr>}
      </tbody></table></div>
    {/* 2026-10-19 B5(方案 L3-2): 修前正文 0 出链 ✗; 与流水线监控同源(/api/pipeline-history) ✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/system/pipeline">流水线监控 →</Link>
      <Link href="/system/automation">自动化执行 →</Link>
    </div>
  </main></div>);
}