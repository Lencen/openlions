"use client";
import KPICard from "@/components/KPICard";
import Link from "next/link";
import BarChart from "@/components/BarChart";
import { useApi } from "@/lib/api";
import { useState } from "react";
import { Alert, Button, Input } from "@/components/primitives";
import { serviceLabel, healthDimLabel, statusLabel } from "@/config/systemLabels";
import { t } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";
import ErrorAlert from "@/components/ErrorAlert";
import { fmtTime } from "@/lib/format";
import DataMoment from "@/components/DataMoment";
interface S {
  /** 76-GB: BFF 顶层新增的"数据时刻" */
  asOf?: string; result?: { data?: { total: number; byStatus: Record<string,number> } } }
interface F {
  /** 77-P: BFF 顶层新增的"数据时刻" */
  asOf?: string; data?: { reflections?:{total:number;ok:number;failed:number}; structuredFindings?:{covered:number;total:number;rate:number}; coverage?:{avg:number;total:number}; findings?:{total:number;byCategory?:Record<string,number>;byStatus?:Record<string,number>}; tasks?:Record<string,number>; health?:{completion:number;runtime:number;logic:number;dataMath:number;structure:number;quality:number;overall:number} } }

export default function HealthPage() {
  const { data: sess, error: sessErr } = useApi<S>("/api/session-stats");
  const { data: fw, error: fwErr } = useApi<F>("/api/flywheel-stats");
  const st = sess?.result?.data;
  const fwd = fw?.data;
  // 2026-10-13 round 76-V: 原来在浏览器直连 http://localhost:3000/ 等服务 -> 被 CORS 拦(12 条 console error),
  //   于是「服务存活检查」恒显示离线。改用服务端 /api/service-ping(已有, server 端 ping, 避开 CORS)。
  const { data: pingData, loading: pingLoading, error: pingErr } = useApi<{ services: { name: string; code: number; ms: number; alive: boolean }[]; /** 77-K/P: BFF 顶层新增的"数据时刻" */ asOf?: string }>("/api/service-ping");
  const pings: Record<string, { code: number; ms: number; alive: boolean }> = {};
  for (const pg of pingData?.services ?? []) pings[pg.name] = { code: pg.code, ms: pg.ms, alive: pg.alive };

  // 2026-10-13 round 76-BU: 卡死任务清理(从 selfimproving /health 搬来的**写操作**; 支持先预演)
  const [stuckMin, setStuckMin] = useState(30);
  const [stuckBusy, setStuckBusy] = useState<null | "dry" | "run">(null);
  const [stuckMsg, setStuckMsg] = useState<string | null>(null);
  async function cleanupStuck(dryRun: boolean) {
    setStuckBusy(dryRun ? "dry" : "run"); setStuckMsg(null);
    try {
      const r = await fetch("/api/cleanup-stuck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thresholdMin: stuckMin, dryRun }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(String(j?.error || ("请求失败（状态码 " + r.status + "）")));
      const d: any = j?.data ?? {};
      if (dryRun) {
        const sample = Array.isArray(d.sample) && d.sample.length ? "；示例：" + d.sample.slice(0, 3).map((s: any) => s.taskId + "（" + s.stuckMin + "分）").join("、") : "";
        setStuckMsg("预演：" + (d.count ?? 0) + " 个卡死执行（阈值 " + (d.thresholdMin ?? stuckMin) + " 分钟）" + sample);
      } else {
        setStuckMsg("已清理 " + (d.cleaned ?? 0) + " 个（阈值 " + (d.thresholdMin ?? stuckMin) + " 分钟）" + (d.message ? " · " + d.message : ""));
      }
    } catch (e) { setStuckMsg("失败：" + String((e as Error)?.message || e)); }
    finally { setStuckBusy(null); }
  }
  const tasksByStatus = fwd?.tasks ?? {};
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>业务与系统</span><span className="sep">/</span><span className="current">健康检查</span></div>
    <div className="page-header"><div className="page-title">健康检查</div><div className="page-subtitle">服务存活 · 飞轮健康度 · 会话档案 · 数据库完整性<DataMoment items={[{ label: "会话", at: sess?.asOf }, { label: "飞轮", at: fw?.asOf }, { label: "服务", at: pingData?.asOf, loading: pingLoading }]} /></div></div>
    {/* 2026-10-15（规范 §2）：原来只有一句报错文本, 没有下一步动作 ✗ -> 换成 ErrorAlert(带重试)。 */}
    {(sessErr || fwErr || pingErr) ? (
      <ErrorAlert
        title="健康数据加载失败"
        message={String(((sessErr || fwErr) as Error)?.message || (sessErr || fwErr))}
        onRetry={() => window.location.reload()}
        extra={<a className="btn btn-sm" href="/system">去看服务状态</a>}
      />
    ) : null}
    <div className="kpi-grid">
      <KPICard label="会话档案" value={st?.total?.toLocaleString()??"..."} />
      <KPICard label="飞轮反思" value={fwd?.reflections?.total?.toLocaleString()??"..."} />
      <KPICard label="覆盖率" value={fwd?((fwd.structuredFindings?.rate??0)*100).toFixed(1)+"%":"..."} />
      <KPICard label="健康分" value={fwd?.health?.overall?.toString()??"..."} />
    </div>

        {/* 2026-10-19 B5(方案 L3-2): 修前本页**正文 0 条出链** ✗ —— 看到"失败/覆盖"却点不进去。
            这里补三条**真实下钻**: 失败任务(飞轮任务支持 status 过滤 ✓)、反思明细、覆盖率明细。 */}
        <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginBottom: "var(--sp-3)" }}>
          <span>下钻：</span>
          <Link href="/flywheel/executions">看失败的执行记录 →</Link>
          <Link href="/cognitive/reflection">看反思明细 →</Link>
          <Link href="/flywheel/coverage">看覆盖率构成 →</Link>
        </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">服务存活检查</span></div>
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>服务</th><th>{t('field.httpCode')}</th><th>延迟</th><th>状态</th></tr></thead><tbody>
        {Object.keys(pings).length === 0 ? (
          <tr><td colSpan={4} style={{ padding: "var(--sp-3)", color: "var(--text-dim)" }}>{pingLoading ? "检查中…（服务端逐个 ping，约数秒）" : "暂无数据"}</td></tr>
        ) : Object.entries(pings).map(([name, info]) => (
          <tr key={name}><td className="nowrap">{serviceLabel(name)}</td>
            <td className="num">{info.code || "-"}</td>
            <td className="num">{info.ms}ms</td>
            <td><span className={`badge ${info.alive?"badge-green":"badge-red"}`}>{info.alive?"在线":"离线"}</span></td>
          </tr>
        ))}
      </tbody></table></div>
    <div className="grid-2">
      <div className="panel"><div className="panel-header"><span className="panel-title">会话档案状态分布</span></div>
        <TableCopyButton />
        <table className="tbl"><tbody>
          {st?.byStatus && Object.entries(st.byStatus).sort((a,b)=>b[1]-a[1]).map(([k,v],i)=>(
            <tr key={i}><td><span className={`badge ${k==="FAILED"?"badge-red":k==="PENDING"?"badge-yellow":"badge-green"}`}>{statusLabel(k)}</span></td><td className="num">{v.toLocaleString()}</td></tr>
          ))}
        </tbody></table></div>
      {Object.keys(tasksByStatus).length>0 && <div className="panel"><div className="panel-header"><span className="panel-title">飞轮任务状态</span></div>
        <BarChart bars={Object.entries(tasksByStatus).map(([k,v]:[string,any])=>({label:statusLabel(k),value:Number(v),color:k==="DONE"?"var(--status-ok)":k==="FAILED"?"var(--status-crit)":k==="IN_PROGRESS"?"var(--status-warn)":"var(--text-muted)"}))} /></div>}
    </div>    {/* 2026-10-19 B7: 修前本页 main 内 0 个 svg ✗ —— 健康度只有表格, 没有"哪一维拖后腿"的直观对比。补一组条 ✓ */}
    {fwd?.health && (
      <div className="panel" style={{ marginBottom: "var(--sp-3)" }}>
        <div className="panel-header"><span className="panel-title">健康度维度分布</span></div>
        <div style={{ padding: "var(--sp-3)" }}>
          <BarChart bars={Object.entries(fwd.health).map(([k, v]: [string, any]) => ({
            label: healthDimLabel(k),
            value: Math.round(Number(v) || 0),
            color: k === "overall" ? "var(--primary)" : (Number(v) < 60 ? "var(--status-crit)" : "var(--status-ok)"),
          }))} />
        </div>
      </div>
    )}

    {fwd?.health && <div className="panel"><div className="panel-header"><span className="panel-title">飞轮健康度评估</span></div>
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>维度</th><th>分数</th></tr></thead><tbody>
        {Object.entries(fwd.health).map(([k,v]:[string,any])=>(<tr key={k}><td style={{fontWeight:k==="overall"?"600":"400"}}>{healthDimLabel(k)}</td><td className="num" style={{fontWeight:k==="overall"?"600":"400"}}>{v}</td></tr>))}
      </tbody></table></div>}
    <div className="panel"><div className="panel-header"><span className="panel-title">卡死任务清理</span>
      <span className="tiny" style={{ color: "var(--text-dim)" }}>把长时间无进展的执行标记为失败，并让任务重新排队</span></div>
      <div style={{ padding: "var(--sp-3-5)", display: "flex", gap: "var(--sp-2-5)", alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>超时阈值（分钟）
          <Input type="number" value={stuckMin} onChange={(e: any) => setStuckMin(Math.min(1440, Math.max(5, Number(e.target.value) || 30)))} style={{ width: 120 }} /></label>
        <Button disabled={stuckBusy !== null} onClick={() => cleanupStuck(true)}>{stuckBusy === "dry" ? "预演中…" : "先预演"}</Button>
        <Button type="primary" disabled={stuckBusy !== null} onClick={() => cleanupStuck(false)}>{stuckBusy === "run" ? "清理中…" : "执行清理"}</Button>
      </div>
      {stuckMsg && <div style={{ padding: "0 var(--sp-3-5) var(--sp-3-5)" }}><Alert type={stuckMsg.startsWith("失败") ? "error" : "success"} message={stuckMsg} /></div>}
    </div>
  </main></div>);
}