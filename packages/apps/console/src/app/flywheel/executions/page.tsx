"use client";
import { useGlobalFilter } from "@/components/GlobalFilter";
import Link from "next/link";
import { interactiveProps } from "@/components/a11y";
import { Fragment, useState } from "react";
import KPICard from "@/components/KPICard";
import { useApi } from "@/lib/api";
import { Alert, Empty, Skeleton } from "@/components/primitives";
import { t } from "@/i18n";
import ErrorAlert from "@/components/ErrorAlert";
import DataMoment from "@/components/DataMoment";
import TableCopyButton from "@/components/TableCopyButton";

interface T { total?:number; items?:Array<{id:string;type?:string;status:string;title?:string;description?:string;createdAt?:string;targetType?:string;targetId?:string;measuredDelta?:number;actionType?:string}> }
interface S { data?:{tasks?:any} }

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
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>飞轮引擎</span><span className="sep">/</span><span className="current">执行记录</span></div>
    <div className="page-header"><div className="page-title">执行记录</div><div className="page-subtitle">{st?`${t('status.done')} ${done} · ${t('status.failed')} ${failed} · ${t('status.inProgress')} ${taskStats.IN_PROGRESS??0}`:"加载中..."}{/* 2026-10-16 round 77-AD（决策③逐源 + 77-M 机检清单）: 本页有 **2 个源** ——    /api/flywheel-tasks（下方任务列表）与 /api/flywheel-stats（这里三个计数）。    此前本页**没有时刻** ✗ -> 两组数字的新旧都无法判断。    本轮给 flywheel-tasks 补了顶层 asOf（stats 侧 77-P 已有）, 故这里是纯页面改动 ✓。 */}<DataMoment items={[{ label: "指标", at: (stats as any)?.asOf }, { label: "任务", at: (data as any)?.asOf }]} /></div></div>
    <div className="kpi-grid">
      <KPICard label={t('status.done')} value={done.toString()} />
      <KPICard label={t('status.failed')} value={failed.toString()} />
      <KPICard label={t('status.inProgress')} value={(taskStats.IN_PROGRESS??0).toString()} />
      <KPICard label={t('status.pending')} value={(taskStats.PENDING??0).toString()} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">任务执行流水 {loading&&"（加载中...）"}</span></div>
      {error ? <ErrorAlert title="执行记录加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} /> : null}
      {loading && !data && <div style={{padding: "var(--sp-3)"}}><Skeleton active title={false} paragraph={{rows:5}} /></div>}
      {!loading && !error && items.length === 0 && <Empty description="暂无执行记录" />}
      {items.length > 0 && !error && <>
        <TableCopyButton />
        <table className="tbl"><thead><tr><th>{t('field.taskId')}</th><th>类型</th><th>状态</th><th>标题</th><th>时间</th></tr></thead><tbody>
        {items.map((t,i)=>(
          // 2026-10-13 round 76-AX: 原来是**裸 <> fragment**(无 key) -> React 报 "Each child in a list should have a unique key"。
          <Fragment key={t.id}><tr {...interactiveProps(expandedId===t.id)} style={{cursor:"pointer"}} onClick={()=>setExpandedId(expandedId===t.id?null:t.id)}>
            <td className="nowrap mono" style={{fontSize: "var(--fs-sm)"}}>{t.id.slice(0,12)}</td>
            <td className="nowrap">{t.type||t.actionType||"-"}</td>
            <td className="nowrap"><span className={`badge ${t.status==="DONE"?"badge-green":t.status==="FAILED"?"badge-red":"badge-yellow"}`}>{t.status}</span></td>
            <td style={{color:expandedId===t.id?"var(--primary)":"inherit"}}>{t.title?.slice(0,60)||(t.id.slice(0,12)+"...")}</td>
            <td className="nowrap mono" style={{fontSize: "var(--fs-sm)"}} title={t.createdAt ? new Date(t.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : ""}>{fmtDT(t.createdAt)}</td>
          </tr>
          {expandedId===t.id && (
            <tr key={t.id+"-exp"}><td colSpan={5} style={{background:"var(--bg-hover)",padding: "var(--sp-3)"}}>
              <div style={{marginBottom: "var(--sp-2)"}}><strong>完整描述:</strong> <span style={{fontSize: "var(--fs-base)",whiteSpace:"pre-wrap"}}>{t.description||"(无描述)"}</span></div>
              {t.targetType && <div><strong>目标:</strong> <span style={{fontSize: "var(--fs-base)"}}>{t.targetType}: {t.targetId||"-"}</span></div>}
              {t.measuredDelta!==undefined && <div style={{marginTop: "var(--sp-1)"}}><strong>实测变化:</strong> <span style={{color:t.measuredDelta>0?"var(--status-ok)":"var(--text-muted)"}}>{t.measuredDelta>0?"+":""}{t.measuredDelta.toFixed(4)}</span></div>}
            </td></tr>
          )}
          </Fragment>
        ))}
      </tbody></table>
        </>}</div>
    {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/flywheel/tasks">改进任务 →</Link>
      <Link href="/system/pipeline">流水线监控 →</Link>
    </div>
  </main></div>);
}