"use client";
import { Fragment, useState } from "react";
import Link from "next/link";
import { statusLabel, sourceTypeLabel, runModeLabel } from "@/config/systemLabels";
import { interactiveProps } from "@/components/a11y";
import KPICard from "@/components/KPICard";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";
import ErrorAlert from "@/components/ErrorAlert";
import DataMoment from "@/components/DataMoment";
interface P { logs?: Array<{id:string;sourceType:string;sourcePath?:string;status:string;recordsSynced:number;recordsSkipped:number;errorMessage?:string|null;messageCount:number;runMode:string;startedAt:string;completedAt?:string;createdAt:string}>; summary?:{total:number;completed:number;failed:number} }
export default function PipelinePage() {
  const [expandedId, setExpandedId] = useState<string|null>(null);
  const { data, loading, error, mutate } = useApi<P>("/api/pipeline-history");
  const { data: dash, error: dashErr } = useApi<{ cronSchedule?: unknown[]; /** 77-AF: 看板自带的"数据时刻" */ timestamp?: string }>("/api/flywheel-dashboard");
  const logs = data?.logs ?? [];
  const summary = data?.summary;
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>业务与系统</span><span className="sep">/</span><span className="current">流水线监控</span></div>
    <div className="page-header"><div className="page-title">流水线监控</div><div className="page-subtitle">{loading?"（加载中...）":`${logs.length} 条运行记录`}{/* 2026-10-16 round 77-AF: 2 个源各带自己的时刻 —— 本接口(77-AF 补的顶层 asOf) + flywheel-dashboard 的 timestamp。 */}<DataMoment items={[{ label: "管道", at: (data as any)?.asOf }, { label: "定时", at: (dash as any)?.timestamp }]} /></div></div>
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
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--sp-1-5)" }}>
        <TableCopyButton exportedName="pipeline-history.csv" />
      </div>
      <table className="tbl"><thead><tr><th>编号</th><th>模式</th><th>来源</th><th>同步</th><th>跳过</th><th>消息</th><th>状态</th><th>开始时间</th></tr></thead><tbody>
        {logs.slice(0,50).map((l,i)=>(
          // 2026-10-13 round 76-BA: 原来是裸 <> fragment(无 key) -> Enter 展开时 React 报 "Each child in a list should have a unique key"。
          <Fragment key={l.id}><tr {...interactiveProps(expandedId===l.id)} style={{cursor:"pointer"}} onClick={()=>setExpandedId(expandedId===l.id?null:l.id)}>
            <td className="nowrap mono" style={{fontSize: "var(--fs-xs)"}}>{l.id?.slice(0,12)}</td>
            <td className="nowrap"><span className="badge badge-blue">{runModeLabel(l.runMode)}</span></td>
            <td className="nowrap" style={{fontSize: "var(--fs-sm)"}}>{sourceTypeLabel(l.sourceType)}</td>
            <td className="num">{l.recordsSynced}</td>
            <td className="num" style={{color:"var(--text-dim)"}}>{l.recordsSkipped}</td>
            <td className="num">{l.messageCount}</td>
            <td><span className={`badge ${l.status==="COMPLETED"?"badge-green":l.status==="FAILED"?"badge-red":"badge-yellow"}`}>{statusLabel(l.status)}</span></td>
            <td className="nowrap mono" style={{fontSize: "var(--fs-xs)"}}>{l.startedAt?.slice(0,19).replace("T"," ")}</td>
          </tr>
          {expandedId===l.id && (
            <tr key={l.id+"-exp"}><td colSpan={8} style={{background:"var(--bg-hover)",padding: "var(--sp-3)"}}>
              <div><strong>完整编号：</strong> <span style={{fontFamily:"var(--font-mono)",fontSize: "var(--fs-sm)"}}>{l.id}</span></div>
              <div style={{marginTop: "var(--sp-1)"}}><strong>来源路径:</strong> <span style={{fontFamily:"var(--font-mono)",fontSize: "var(--fs-sm)"}}>{l.sourcePath||"-"}</span></div>
              <div style={{marginTop: "var(--sp-1)"}}><strong>开始:</strong> {l.startedAt?.replace("T"," ").slice(0,19)} · <strong>完成:</strong> {l.completedAt?.replace("T"," ").slice(0,19)||"-"}</div>
              {l.errorMessage && <div style={{marginTop: "var(--sp-1)",color:"var(--status-crit)"}}><strong>错误:</strong> {l.errorMessage}</div>}
            </td></tr>
          )}
          </Fragment>
        ))}
        {!loading && !error && logs.length === 0 && <tr><td colSpan={8} style={{padding: "var(--sp-5)",color:"var(--text-dim)",textAlign:"center"}}>暂无运行记录</td></tr>}
      </tbody></table></div>
    {/* 2026-10-19 B5(方案 L3-2): 修前本页正文 0 条出链 ✗。它和"访问日志/自动化执行"用的是**同一个接口**(/api/pipeline-history), 是同一份数据的三个切面 -> 互链是真导航 ✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/system/access-log">访问日志 →</Link>
      <Link href="/system/automation">自动化执行 →</Link>
      <Link href="/system/rotation">轮转记录 →</Link>
    </div>
  </main></div>);
}