"use client";
import KPICard from "@/components/KPICard";
import Link from "next/link";
import BarChart from "@/components/BarChart";
import { useApi } from "@/lib/api";
import { Alert, Empty, Skeleton } from "@/components/primitives";
import { t } from "@/i18n";
import { healthDimLabel } from "@/config/systemLabels";
import TableCopyButton from "@/components/TableCopyButton";
import ErrorAlert from "@/components/ErrorAlert";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import DataTable from "@/components/DataTable";
import styles from "./page.module.css";

// 2026-11-05 P2 呈现层（批8）：
//   面包屑弱化色、骨架内边距、底部出链行下沉到 page.module.css；
//   健康度表由裸 table 标签（.tbl 类）换成白名单 DataTable（客户端组件，函数 props 安全）；
//   表格单元格在渲染时预算成 ReactNode（列只留 key/title/width/align），「总分」行加粗走 class。
//   取数（/api/flywheel-stats）、URL 参数、文案与 ErrorAlert 重试均未动。

interface S { data?:{
  coverage?:{avg:number;total:number};
  structuredFindings?:{covered:number;total:number;rate:number};
  findings?:{total:number;byCategory?:Record<string,number>;byStatus?:Record<string,number>};
  tasks?:Record<string,number>;
  reflections?:{total:number;ok:number;failed:number};
  health?:{completion:number;runtime:number;logic:number;dataMath:number;structure:number;quality:number;overall:number};
}}

// 2026-10-13 (round 74-S): 原为裸 hex -> 暗色/高对比主题下会错色。改走主题令牌。
const catColors: Record<string,string> = {COVERAGE_GAP:"var(--brand)",MISSED_TOPIC:"var(--danger)",STALE_INFO:"var(--warn)",DUPLICATE:"var(--info)",INCONSISTENCY:"var(--ok)",RECURRING:"var(--danger)",OTHER:"var(--text-3)"};

export default function CoveragePage() {
  // 2026-10-13 (round 74-S): 原来只取 data/loading, **error 没接** -> 接口失败时页面永远停在"加载中..."。
  const { data, loading, error, mutate } = useApi<S>("/api/flywheel-stats");
  const d = data?.data;
  const cov = d?.coverage;
  const findings = d?.findings;
  const health = d?.health;
  const byCat = findings?.byCategory ?? {};
  const byStatus = findings?.byStatus ?? {};
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.crumbDim}>飞轮引擎</span><span className="sep">/</span><span className="current">{t('biz.coverage.trend')}</span></div>
    <PageHeader><PageTitle>{t('biz.coverage.trend')}</PageTitle><div className="page-subtitle">{cov?t('biz.coverage.subtitle',{n:cov.total,avg:cov.avg.toFixed(4)}):"加载中..."}</div></PageHeader>
    {/* 2026-10-15（规范 §2）：原来只有一句报错文本, 没有下一步动作 ✗ -> 换成 ErrorAlert(带重试)。 */}
    {error ? (
      <ErrorAlert
        title="覆盖率数据加载失败"
        message={String((error as Error)?.message || error)}
        onRetry={() => { mutate(); }}
      />
    ) : null}
    <div className="kpi-grid">
      <KPICard label={t('biz.coverage.avg')} value={cov?cov.avg.toFixed(4):"..."} />
      <KPICard label={t('biz.coverage.topicTotal')} value={cov?cov.total.toString():"..."} />
      <KPICard label={t('biz.coverage.findingRate')} value={d?((d.structuredFindings?.rate??0)*100).toFixed(1)+"%":"..."} />
      <KPICard label={t('biz.coverage.healthScore')} value={health?health.overall.toString():"..."} />
    </div>
    <div className="grid-2">
      <div className="panel"><div className="panel-header"><span className="panel-title">{t('biz.coverage.byCategory')}</span></div>
        {Object.keys(byCat).length>0
          ? <BarChart bars={Object.entries(byCat).map(([k,v]:[string,any])=>({label:k,value:Number(v),color:catColors[k]||"var(--text-3)"}))} />
          : (loading ? <div className={styles.skeletonBox}><Skeleton active title={false} paragraph={{rows:4}} /></div> : <Empty description="无数据" />)}</div>
      <div className="panel"><div className="panel-header"><span className="panel-title">{t('biz.coverage.byStatus')}</span></div>
        {Object.keys(byStatus).length>0
          ? <BarChart bars={Object.entries(byStatus).map(([k,v]:[string,any])=>({label:k,value:Number(v),color:k==="RESOLVED"?"var(--status-ok)":k==="NEW"?"var(--status-warn)":"var(--text-muted)"}))} />
          : (loading ? <div className={styles.skeletonBox}><Skeleton active title={false} paragraph={{rows:4}} /></div> : <Empty description="无数据" />)}</div>
    </div>
    {health && <div className="panel"><div className="panel-header"><span className="panel-title">健康度评估</span></div>
      <TableCopyButton />
      <DataTable
        columns={[
          { key: "dim", title: "维度" },
          { key: "score", title: "分数", width: 96, align: "right" },
        ]}
        rows={(["completion","runtime","logic","dataMath","structure","quality","overall"] as const).map((k) => ({
          // 「总分」行加粗：原内联 fontWeight 三元 -> 单元格内 class（列定义里不放函数）
          dim: <span className={k === "overall" ? styles.cellStrong : undefined}>{healthDimLabel(k)}</span>,
          score: <span className={k === "overall" ? styles.cellStrong : undefined}>{health[k]}</span>,
        }))}
      /></div>}
    {/* 2026-10-19 B5: 修前本页正文 0 条出链 ✗；补"相关视图"（每条都指向真实相关页, 非凑数）✓ */}
    <div className={"tiny " + styles.footLinks}>
      <span>相关视图：</span>
      <Link href="/cognitive/knowledge">知识库 →</Link>
      <Link href="/flywheel/findings">结构化发现 →</Link>
    </div>
  </main></div>);
}
