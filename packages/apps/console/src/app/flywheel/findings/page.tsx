"use client";
import { interactiveProps } from "@/components/a11y";
import Link from "next/link";
import { Fragment, useState } from "react";
import KPICard from "@/components/KPICard";
import BarChart from "@/components/BarChart";
import { useApi } from "@/lib/api";
import DataMoment from "@/components/DataMoment";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { Alert, Empty, Skeleton } from "@/components/primitives";
import DiscussionPanel from "@/components/DiscussionPanel";
import ErrorAlert from "@/components/ErrorAlert";
import TableCopyButton from "@/components/TableCopyButton";

interface F { success?:boolean; data?:Array<{id:string;category:string;what:string;why?:string;background?:string;recommendation?:string;severity?:string}>; meta?:any; /** 77-S: BFF 顶层新增的数据时刻 */ asOf?:string }
interface S { data?:{findings?:{total:number;byCategory?:any;byActionType?:any;byStatus?:any};structuredFindings?:{covered:number;total:number;rate:number}}; /** 77-S: BFF 顶层新增的数据时刻 */ asOf?:string }

export default function FindingsPage() {
  const [expandedId, setExpandedId] = useState<string|null>(null);
  // 2026-10-13 round 76-CA: 接入顶栏时间范围(③)。
  const f = useGlobalFilter();
  // 2026-10-13 (round 74-C): 原来只取 data/loading, **error 完全没接** -> 请求失败时永远停在"加载中..."。
  const { data, loading, error, mutate } = useApi<F>("/api/flywheel-findings?limit=50&range=" + f.range + "&_n=" + f.nonce);
  const { data: stats } = useApi<S>("/api/flywheel-stats");
  // 2026-10-13 round 76-AX: 上游 /api/v1/flywheel/findings 是**按"发现 × 关联任务"展开**的, 同一 id 会重复出现
  //   (实测 20 行里只有 5 个唯一 id)。本页只展示发现本体, 这里按 id 去重 —— 否则同一发现显示 4 遍,
  //   并触发 React "two children with the same key" 警告(45 条)。
  const items = (() => {
    const raw = data?.data ?? [];
    const seen = new Set<string>();
    const out: typeof raw = [];
    for (const f of raw) {
      if (f?.id) { if (seen.has(f.id)) continue; seen.add(f.id); }
      out.push(f);
    }
    return out;
  })();
  const st = stats?.data;
  const byCat = st?.findings?.byCategory ?? {};
  // 2026-10-13 (round 74-C): 原为**裸 hex**(与令牌同族但不一致) -> 暗色/高对比主题下会错色。改走主题令牌。
  const catColors: Record<string,string> = {COVERAGE_GAP:"var(--brand)",MISSED_TOPIC:"var(--danger)",STALE_INFO:"var(--warn)",DUPLICATE:"var(--info)",INCONSISTENCY:"var(--ok)",OTHER:"var(--text-3)"};
  // 类别是后端枚举 (数据)，界面上换成业务说法，不直接露出 COVERAGE_GAP 这类代码。
  const catLabels: Record<string,string> = {COVERAGE_GAP:"覆盖缺口",MISSED_TOPIC:"遗漏主题",STALE_INFO:"信息过期",DUPLICATE:"重复",INCONSISTENCY:"前后不一致",OTHER:"其他"};
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{color:"var(--text-dim)"}}>飞轮引擎</span><span className="sep">/</span><span className="current">结构化发现</span></div>
    <div className="page-header"><div className="page-title">结构化发现</div><div className="page-subtitle">{st?`${st.findings?.total??0} 条 · 覆盖率 ${((st.structuredFindings?.rate??0)*100).toFixed(1)}%`:"加载中..."}</div></div>
    <div className="kpi-grid">
      <KPICard label="发现总量" value={st?.findings?.total?.toString()??"..."} />
      <KPICard label="覆盖率" value={st?((st.structuredFindings?.rate??0)*100).toFixed(1)+"%":"..."} />
      {/* 2026-10-13 round 76-DQ: 这两张卡**没有加载守卫** —— 加载中显示"类别数 **0**", 就绪后才是 7(实测), 属假计数。
          同页的"发现总量/覆盖率"早已用 loading 守卫显示"…", 这里补齐。 */}
      <KPICard label="类别数" value={loading ? "..." : Object.keys(byCat).length.toString()} />
      <KPICard label="已处理" value={loading ? "..." : (byCat.RESOLVED??0).toString()} />
    </div>
    {/* 2026-10-16（round 77-S, 决策③逐源 + 77-M 机检清单）: 本页有 2 个数据源 ——
        /api/flywheel-findings?limit=50…（发现列表本体, 见下方表格）与 /api/flywheel-stats（统计口径, 见页头副标题的"条·覆盖"）。
        此前本页**完全没有**时刻 -> 两组数字都无法判断新旧。
        本轮先给 /api/flywheel-findings 补了顶层 asOf（统计侧 77-P 已有）, 故这里是纯页面改动。
        注意: /api/flywheel-stats 的 asOf 是**顶层**键, 不是 st(=stats.data) 里的字段 ✓。 */}
    <div className="tiny" style={{ textAlign: "right", color: "var(--text-dim)", marginBottom: "var(--sp-3)" }}>
      <DataMoment items={[{ label: "发现", at: data?.asOf }, { label: "统计", at: stats?.asOf }]} style={{ marginLeft: 0 }} />
    </div>
    {Object.keys(byCat).length>0 && <div className="panel"><div className="panel-header"><span className="panel-title">按类别分布</span></div>
      <BarChart bars={Object.entries(byCat).map(([k,v]:[string,any])=>({label:catLabels[k]||k,value:Number(v),color:catColors[k]||"var(--text-muted)"}))} /></div>}
    <div className="panel"><div className="panel-header"><span className="panel-title">发现列表{!loading && !error ? ` (${items.length})` : ""}{!loading && !error && data?.meta?.total != null ? <span className="tiny" style={{ color: "var(--text-dim)", fontWeight: 400 }}>　所选范围（{data.meta.rangeLabel || "近 24 小时"}）· 已扫描 {data.meta.reflectionsScanned ?? "-"} 期反思</span> : null}</span></div>
      {/* 2026-10-13 (round 74-C): 补三态。原来只有"（加载中...）"文案, 失败与空结果都没有出口。 */}
      {error ? <ErrorAlert title="发现列表加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} /> : null}
      {loading && !data && <div style={{padding: "var(--sp-3)"}}><Skeleton active title={false} paragraph={{rows:5}} /></div>}
      {!loading && !error && items.length === 0 && <Empty description="暂无结构化发现" />}
            {items.length > 0 && <><TableCopyButton />
        <table className="tbl"><thead><tr><th>编号</th><th>类别</th><th>问题</th><th>原因</th></tr></thead><tbody>
        {items.map((f,i)=>(
          // 2026-10-13 round 76-AX: 原来 key={f.id} —— 若个别条目缺 id 会出现多个 undefined 同名 key(React 报重复 key)。
          <Fragment key={String(f.id ?? i)}><tr {...interactiveProps(expandedId===f.id)} style={{cursor:"pointer"}} onClick={()=>setExpandedId(expandedId===f.id?null:f.id)}>
            <td className="nowrap mono" style={{fontSize: "var(--fs-sm)"}}>{f.id}</td>
            <td className="nowrap"><span className="badge badge-blue">{catLabels[f.category]||f.category}</span></td>
            <td style={{color:expandedId===f.id?"var(--primary)":"inherit",maxWidth:"300px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.what?.slice(0,80)}</td>
            <td style={{maxWidth:"300px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize: "var(--fs-base)",color:"var(--text-dim)"}}>{f.why?.slice(0,80)??"-"}</td>
          </tr>
          {expandedId===f.id && (
            <tr><td colSpan={4} style={{background:"var(--bg-hover)",padding: "var(--sp-3)"}}>
              <div style={{marginBottom: "var(--sp-2)"}}><strong>问题：</strong> <span style={{fontSize: "var(--fs-base)"}}>{f.what}</span></div>
              <div style={{marginBottom: "var(--sp-2)"}}><strong>原因：</strong> <span style={{fontSize: "var(--fs-base)"}}>{f.why||"-"}</span></div>
              {f.background && <div style={{marginBottom: "var(--sp-2)"}}><strong>背景：</strong> <span style={{fontSize: "var(--fs-base)",whiteSpace:"pre-wrap"}}>{f.background}</span></div>}
              {f.recommendation && <div><strong>建议：</strong> <span style={{fontSize: "var(--fs-base)"}}>{f.recommendation}</span></div>}
              {f.severity && <div style={{marginTop: "var(--sp-1)"}}><span className="badge badge-yellow">严重度：{f.severity}</span></div>}
              {/* 2026-09-10: 通用讨论模块 (finding 实体) */}
              <div style={{marginTop: "var(--sp-3)"}}><DiscussionPanel entityType="finding" entityId={f.id} title="发现讨论与协作" /></div>
            </td></tr>
          )}
          </Fragment>
        ))}
      </tbody></table></>}</div>
    {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/cognitive/knowledge">知识库 →</Link>
      <Link href="/flywheel/coverage">覆盖率 →</Link>
    </div>
  </main></div>);
}