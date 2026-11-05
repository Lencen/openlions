"use client";
import KPICard from "@/components/KPICard";
import Link from "next/link";
import BarChart from "@/components/BarChart";
import { useApi } from "@/lib/api";
import { Alert } from "@/components/primitives";
import { t } from "@/i18n";
import { DASH, fmtState, fmtTime } from "@/lib/format";
import { statusLabel } from "@/config/systemLabels";
import { useRef, useState } from "react";
import TableCopyButton from "@/components/TableCopyButton";
import ErrorAlert from "@/components/ErrorAlert";
import DataMoment from "@/components/DataMoment";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
interface S {
  /** 76-GB: BFF 顶层新增的"数据时刻" */
  asOf?: string; result?: { data?: { total: number; byStatus: Record<string,number>; bySource: Record<string,number>; byAgent: Array<{agent_id:string;count:number}>; pending24h: number; totalSizeKb: number } } }
interface L { result?: { data?: { items?: Array<{session_uid:string;agent_id:string;source:string;title:string|null;message_count:number;status:string;uploaded_at:string;updated_at:string}>; total:number } } }
const fmt = (n:number) => n.toLocaleString();
// 2026-10-26：活库状态键是 DONE（stats 换源后确认）。原来只认 PROCESSED →
//   这一页 9,899 条已提炼会落到兜底灰/无徽标。DONE 与 PROCESSED 等价处理，保留旧键兜历史。
const DONE_KEYS = new Set(["DONE", "PROCESSED"]);
const color = (k:string) => DONE_KEYS.has(k) ? "var(--status-ok)" : k === "PENDING" ? "var(--status-warn)" : k === "FAILED" ? "var(--status-crit)" : "var(--text-muted)";
function badgeClass(status: string): string {
  if (status === "DONE" || status === "PROCESSED") return "badge badge-green";
  if (status === "PENDING") return "badge badge-yellow";
  if (status === "FAILED") return "badge badge-red";
  return "badge badge-blue";
}
export default function SessionsPage() {
  const { data, loading, error } = useApi<S>("/api/session-stats");
  const [page, setPage] = useState(1);
  // 2026-10-15（规范 §2「每张表提供复制/导出」）：会话列表表加复制/导出。
  const sessionTableRef = useRef<HTMLTableElement | null>(null);
  const pageSize = 10;
  const { data: listData, error: listError } = useApi<L>("/api/session-list?page=" + page + "&pageSize=" + pageSize);
  const st = data?.result?.data;
  const items = listData?.result?.data?.items ?? [];
  const total = listData?.result?.data?.total ?? 0;
  const byStatus = st?.byStatus ?? {};
  const bySource = st?.bySource ?? {};
  const byAgent = st?.byAgent ?? [];
  const bars = Object.entries(byStatus).map(([k,v]) => ({ label: statusLabel(k), value: v, color: color(k) }));
  const srcBars = Object.entries(bySource).map(([k,v]) => ({ label: k, value: v, color: "var(--brand)" }));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>智能体与能力</span><span className="sep">/</span><span className="current">会话归档</span></div>
    <PageHeader><PageTitle>会话归档</PageTitle><div className="page-subtitle">会话档案 · {loading && "（加载中...）"}{/* 2026-10-16 round 77-AG（决策③逐源）: 2 个源 —— /api/session-stats(KPI 三张卡) 与 /api/session-list(下方列表); 此前只标前者 ✗。 */}<DataMoment items={[{ label: "会话", at: (data as any)?.asOf }, { label: "列表", at: (listData as any)?.asOf }]} /></div></PageHeader>
    <div className="kpi-grid">
      {/* 2026-10-15（round 76-EP，规范铁律 2/§1）：原来 `st?.pending24h ?? 0` 在**取不到时显示 0** ✗，
          与「真的是 0」分不清；改成四态区分（加载中 / 未知 / —）。 */}
      <KPICard label="会话总数" value={fmtState(st?.total, { loading, error: !!error })} />
      <KPICard label={t('status.pending24h')} value={fmtState(st?.pending24h, { loading, error: !!error })} />
      <KPICard label="存储(MB)" value={fmtState(st?.totalSizeKb == null ? undefined : Math.round(st.totalSizeKb / 1024), { loading, error: !!error })} />
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">状态分布</span></div>
      {bars.length > 0 ? <BarChart bars={bars} /> : <div style={{padding: "var(--sp-5)",color:"var(--text-muted)"}}>{error ? "统计加载失败（可点上方重试）" : "加载中..."}</div>}</div>
    <div className="panel"><div className="panel-header"><span className="panel-title">来源分布</span></div>
      {srcBars.length > 0 ? <BarChart bars={srcBars} /> : <div style={{padding: "var(--sp-5)",color:"var(--text-muted)"}}>{error ? "统计加载失败（可点上方重试）" : "加载中..."}</div>}</div>
    <div className="panel"><div className="panel-header"><span className="panel-title">按智能体分布</span></div>
      <table className="tbl"><thead><tr><th>智能体编号</th><th>会话数</th><th>占比</th></tr></thead><tbody>
        {byAgent.map((a,i) => (<tr key={i}><td className="mono">{a.agent_id}</td><td className="num">{a.count.toLocaleString()}</td><td className="num">{st?.total ? ((a.count/st.total)*100).toFixed(1) + "%" : DASH}</td></tr>))}
      </tbody></table></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">会话列表 (最近 {pageSize})</span></div>
      {/* 2026-10-15（规范 §2）：原来只有一句报错文本, 没有下一步动作 ✗ -> 换成 ErrorAlert(带重试)。 */}
      {listError ? (
        <ErrorAlert
          title="会话列表加载失败"
          message={String((listError as Error)?.message || listError)}
          onRetry={() => window.location.reload()}
        />
      ) : null}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--sp-1-5)" }}>
        <TableCopyButton target={sessionTableRef} exportedName="agents-sessions.csv" />
      </div>
      <table className="tbl" ref={sessionTableRef}><thead><tr><th>{t('common.session')}</th><th>{t('common.agent')}</th><th>来源</th><th>标题</th><th>消息</th><th>状态</th><th>更新时间</th></tr></thead><tbody>
        {items.map((s,i) => (<tr key={i}>
          <td className="mono" style={{fontSize: "var(--fs-sm)"}}>{s.session_uid ? s.session_uid.slice(0,48) : "-"}</td>
          <td className="mono">{s.agent_id}</td>
          <td>{s.source}</td>
          <td style={{maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.title ?? "-"}</td>
          <td className="num">{s.message_count}</td>
          <td><span className={badgeClass(s.status)}>{s.status}</span></td>
          <td className="mono" style={{fontSize: "var(--fs-sm)"}}>{(s.updated_at ?? s.uploaded_at ?? "").slice(0,10)}</td>
        </tr>))}
        {!loading && !listError && items.length === 0 && <tr><td colSpan={7} style={{padding: "var(--sp-4)",color:"var(--text-dim)",textAlign:"center"}}>暂无会话数据</td></tr>}
      </tbody></table>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop: "var(--sp-2-5)",fontSize: "var(--fs-md)"}}>
        {/* 2026-10-13 round 76-DY: 加载中不要显示「共 0 条 · 第 1/1 页」(实测就绪后是 4,429 / 443) -> 假空计数。 */}
        <span style={{color:"var(--text-dim)"}}>{loading ? "共 … 条 · 第 …/… 页" : `共 ${total.toLocaleString()} 条 · 第 ${page}/${pages} 页`}</span>
        <span>
          <button disabled={page <= 1} onClick={() => setPage(page-1)} style={{marginRight: "var(--sp-2)",padding: "var(--sp-1) var(--sp-2-5)",borderRadius: "var(--radius-sm)",border:"1px solid var(--border)",background:"transparent",color:"var(--text)"}}>上一页</button>
          <button disabled={page >= pages} onClick={() => setPage(page+1)} style={{padding: "var(--sp-1) var(--sp-2-5)",borderRadius: "var(--radius-sm)",border:"1px solid var(--border)",background:"transparent",color:"var(--text)"}}>下一页</button>
        </span>
      </div>
    </div>
    {/* 2026-10-19 B5: 修前本页正文 0 条出链 ✗；补"相关视图"（每条都指向真实相关页, 非凑数）✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/sessions">会话中心 →</Link>
      <Link href="/agents/session-browser">会话浏览器 →</Link>
    </div>
  </main></div>);
}