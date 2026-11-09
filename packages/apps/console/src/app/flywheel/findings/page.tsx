"use client";
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 手写 .tbl 表 → 白名单 DataTable。
//   列/字段/文案/DiscussionPanel 全保留；展开详情从「表内一行 colSpan=4」改成表格下方一块面板，
//   触发器从整行可点改成「问题」列里的展开/收起按钮（键盘可达）。
//   取数（/api/flywheel-findings、/api/flywheel-stats）、按 id 去重、类别映射一字未改。
import Link from "next/link";
import { useState } from "react";
import KPICard from "@/components/KPICard";
import BarChart from "@/components/BarChart";
import { useApi } from "@/lib/api";
import DataMoment from "@/components/DataMoment";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { Empty, Skeleton } from "@/components/primitives";
import DiscussionPanel from "@/components/DiscussionPanel";
import ErrorAlert from "@/components/ErrorAlert";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

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

  const expanded = items.find((x) => x.id === expandedId) || null;
  const columns: DataColumn<(typeof items)[number]>[] = [
    { key: "id", title: "编号", width: 140, render: (r) => <span className={styles.monoSm + " nowrap"}>{r.id}</span> },
    {
      key: "category",
      title: "类别",
      render: (r) => <span className="badge badge-blue nowrap">{catLabels[r.category] || r.category}</span>,
    },
    {
      key: "what",
      title: "问题",
      width: 300,
      render: (r) => (
        <>
          <span className={styles.clip} data-active={expandedId === r.id ? "true" : undefined}>{r.what?.slice(0, 80)}</span>
          <button
            type="button"
            className={styles.rowToggle}
            aria-expanded={expandedId === r.id}
            onClick={(e) => { e.stopPropagation(); setExpandedId(expandedId === r.id ? null : r.id); }}
          >
            {expandedId === r.id ? "收起" : "展开"}
          </button>
        </>
      ),
    },
    {
      key: "why",
      title: "原因",
      width: 300,
      render: (r) => <span className={styles.clip + " " + styles.dimSm}>{r.why?.slice(0, 80) ?? "-"}</span>,
    },
  ];

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.crumbDim}>飞轮引擎</span><span className="sep">/</span><span className="current">结构化发现</span></div>
    <PageHeader><PageTitle>结构化发现</PageTitle><div className="page-subtitle">{st?`${st.findings?.total??0} 条 · 覆盖率 ${((st.structuredFindings?.rate??0)*100).toFixed(1)}%`:"加载中..."}</div></PageHeader>
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
    {/* 2026-11-05 P2: 原来用内联 marginLeft 贴边，改走 DataMoment 自带的 flush 属性。 */}
    <div className={"tiny " + styles.momentRow}>
      <DataMoment items={[{ label: "发现", at: data?.asOf }, { label: "统计", at: stats?.asOf }]} flush />
    </div>
    {Object.keys(byCat).length>0 && <div className="panel"><div className="panel-header"><span className="panel-title">按类别分布</span></div>
      <BarChart bars={Object.entries(byCat).map(([k,v]:[string,any])=>({label:catLabels[k]||k,value:Number(v),color:catColors[k]||"var(--text-muted)"}))} /></div>}
    <div className="panel"><div className="panel-header"><span className="panel-title">发现列表{!loading && !error ? ` (${items.length})` : ""}{!loading && !error && data?.meta?.total != null ? <span className={"tiny " + styles.headNote}>　所选范围（{data.meta.rangeLabel || "近 24 小时"}）· 已扫描 {data.meta.reflectionsScanned ?? "-"} 期反思</span> : null}</span></div>
      {/* 2026-10-13 (round 74-C): 补三态。原来只有"（加载中...）"文案, 失败与空结果都没有出口。 */}
      {error ? <ErrorAlert title="发现列表加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); }} /> : null}
      {loading && !data && <div className={styles.pad3}><Skeleton active title={false} paragraph={{rows:5}} /></div>}
      {!loading && !error && items.length === 0 && <Empty description="暂无结构化发现" />}
            {items.length > 0 && <><TableCopyButton />
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(r, i) => String(r.id ?? i)}
          // 2026-11-05 热修（uiux 批4/5 走查 P0-2）：整行点击展开/收起恢复（改前是 tr onClick）。
          //   键盘可达仍由「问题」列里的原生按钮承担；按钮自己 stopPropagation，避免与整行点击互相抵消。
          onRow={(r) => ({ onClick: () => setExpandedId(expandedId === r.id ? null : r.id) })}
        />
        {expanded && (
          <div className={styles.detailPanel}>
            <div className={styles.detailRow}><strong>问题：</strong> <span className={styles.detailBody}>{expanded.what}</span></div>
            <div className={styles.detailRow}><strong>原因：</strong> <span className={styles.detailBody}>{expanded.why||"-"}</span></div>
            {expanded.background && <div className={styles.detailRow}><strong>背景：</strong> <span className={styles.detailPre}>{expanded.background}</span></div>}
            {expanded.recommendation && <div><strong>建议：</strong> <span className={styles.detailBody}>{expanded.recommendation}</span></div>}
            {expanded.severity && <div className={styles.detailFoot}><span className="badge badge-yellow">严重度：{expanded.severity}</span></div>}
            {/* 2026-09-10: 通用讨论模块 (finding 实体) */}
            <div className={styles.detailDiscuss}><DiscussionPanel entityType="finding" entityId={expanded.id} title="发现讨论与协作" /></div>
          </div>
        )}
        </>}</div>
    {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className={"tiny " + styles.related}>
      <span>相关视图：</span>
      <Link href="/cognitive/knowledge">知识库 →</Link>
      <Link href="/flywheel/coverage">覆盖率 →</Link>
    </div>
  </main></div>);
}
