"use client";
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 手写 .tbl 表 → 白名单 DataTable。
//   列/字段/文案不变；动态色走 data-tone，动态条宽走 5% 一档的 .pXX 档位类。
//   取数（/api/stats、/api/flywheel-dashboard）与全部业务文案一字未改。
import KPICard from "@/components/KPICard";
import EntryCard from "@/components/EntryCard";
import BarChart from "@/components/BarChart";
import Sparkline from "@/components/Sparkline";
import { getSubmodules } from "@/config/submodules";
import { artifactLabel, entityLabel } from "@/config/artifactTypes";
import { useApi } from "@/lib/api";
import { Empty } from "@/components/primitives";
import ErrorAlert from "@/components/ErrorAlert";
import { fmtTime , UNKNOWN } from "@/lib/format";
import TableCopyButton from "@/components/TableCopyButton";
import DataMoment from "@/components/DataMoment";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

interface StatsData {
  /** 77-J: BFF 顶层新增的"数据时刻"(本页数字的真正来源) */
  asOf?: string; success: boolean; data: { tables: any; topics: any; quality: any; coverageDistribution: Record<string, number> } }
interface DashData {
  /** 76-GC: 飞轮看板自带的"数据时刻" */
  timestamp?: string; tableStats: { table: string; active: number; h24: number }[]; trend: { writes: { hb: number; c: number }[] } }

function fmt(n: number) { return n.toLocaleString() }

/** 百分比 → 5% 一档的档位类 */
function pctClass(p: number): string {
  const step = Math.min(100, Math.max(0, Math.round(p / 5) * 5));
  return styles["p" + step] || styles["p0"];
}

function toHourly(rows: { hb: number; c: number }[] | undefined, nowMs: number): number[] {
  const arr = new Array(24).fill(0);
  if (!rows) return arr;
  const curHour = Math.floor(nowMs / 3600000);
  for (const r of rows) {
    const idx = 23 - (curHour - r.hb);
    if (idx >= 0 && idx < 24) arr[idx] = r.c;
  }
  return arr;
}

type QualityKey = "memory" | "knowledge" | "reflection" | "practice" | "skill";
type QualityRow = { key: QualityKey; label: string; high: number; mid: number; low: number; pct: number };

export default function CognitiveDashboard() {
  const subs = getSubmodules("cognitive");
  const { data, loading, error, mutate } = useApi<StatsData>("/api/stats");
  const { data: dash, error: dashErr, mutate: mutateDash } = useApi<DashData>("/api/flywheel-dashboard");
  const s = data?.data; const t = s?.tables; const topics = s?.topics; const q = s?.quality;
  const cov = s?.coverageDistribution ?? {};
  const writes24 = toHourly(dash?.trend?.writes, Date.now());
  const writesSum = writes24.reduce((a: number, b: number) => a + b, 0);
  const totalAll = t ? t.memory + t.knowledge + t.reflection + t.practice + t.skill : 0;

  const tableBars = t ? [
    { label: artifactLabel("Memory"), value: t.memory, color: "var(--table-memory)" },
    { label: artifactLabel("Knowledge"), value: t.knowledge, color: "var(--table-knowledge)" },
    { label: artifactLabel("Practice"), value: t.practice, color: "var(--table-practice)" },
    { label: artifactLabel("Reflection"), value: t.reflection, color: "var(--table-reflection)" },
    { label: artifactLabel("Skill"), value: t.skill, color: "var(--table-skill)" },
  ] : [];
  const covBars = [
    { label: "0-0.2", value: cov["0-0.2"] ?? 0, color: "var(--cov-0-2)" },
    { label: "0.2-0.4", value: cov["0.2-0.4"] ?? 0, color: "var(--cov-0-4)" },
    { label: "0.4-0.6", value: cov["0.4-0.6"] ?? 0, color: "var(--cov-0-6)" },
    { label: "0.6-0.8", value: cov["0.6-0.8"] ?? 0, color: "var(--cov-0-8)" },
    { label: "0.8-1.0", value: cov["0.8-1.0"] ?? 0, color: "var(--cov-1-0)" },
  ];

  // 质量表行（与改前逐行 map 的口径一致：缺该类型就跳过；total 至少 1）
  const qualityRows: QualityRow[] = (["memory", "knowledge", "reflection", "practice", "skill"] as const)
    .filter((k) => !!q?.[k])
    .map((k) => {
      const d = q[k];
      const total = d.high + d.mid + d.low || 1;
      return {
        key: k,
        label: entityLabel(k.charAt(0).toUpperCase() + k.slice(1)),
        high: d.high,
        mid: d.mid,
        low: d.low,
        pct: (d.high + d.mid * 0.5) / total,
      };
    });

  const qualityColumns: DataColumn<QualityRow>[] = [
    { key: "label", title: "类型", render: (r) => <span className="nowrap">{r.label}</span> },
    { key: "high", title: "高", align: "right", render: (r) => <span className={styles.okText}>{r.high.toLocaleString()}</span> },
    { key: "mid", title: "中", align: "right", render: (r) => <span className={styles.warnText}>{r.mid.toLocaleString()}</span> },
    { key: "low", title: "低", align: "right", render: (r) => <span className={styles.critText}>{r.low.toLocaleString()}</span> },
    {
      key: "pct",
      title: "质量概览",
      width: 180,
      render: (r) => (
        <>
          <div className={"mini-bar " + styles.miniBarTrack}>
            <div
              className={"mini-bar-fill " + styles.miniBarFill + " " + pctClass(r.pct * 100)}
              data-tone={r.pct >= 0.6 ? "ok" : r.pct >= 0.4 ? "warn" : "crit"}
            />
          </div>
          <span className={styles.capSm}>{Math.round(r.pct * 100)}% 有效质量</span>
        </>
      ),
    },
  ];

  return (
    <div className="layout"><main className="main">
      <PageHeader><PageTitle>记忆与知识</PageTitle>
      <div className="page-subtitle">统一大脑 · 所有 AI 共享的记忆/知识/反思/实践/技能<DataMoment items={[{ label: "表格", at: data?.asOf }, { label: "反思", at: dash?.timestamp }]} /></div></PageHeader>
      {(error || dashErr) ? <ErrorAlert title="认知看板加载失败" message={String((error || dashErr)?.message || (error || dashErr))} onRetry={() => { mutate(); mutateDash(); }} /> : null}

      <div className="trend-grid">
        <div className="trend-card trend-card-hero">
          <div className="trend-label"><span>认知数据总量</span></div>
          <div className="trend-val">{loading ? "..." : fmt(totalAll)}</div>
          <div className={styles.trendCaption}>5 表活跃总和</div>
          <Sparkline data={writes24} color="var(--table-memory)" />
        </div>
        <div className="trend-card">
          {/* 2026-10-13 round 76-DM: 原来标签行右侧又放了同一个 +{fmt(writesSum)}, 与下面的大数字**完全重复** -> 去掉。 */}
          <div className="trend-label"><span>24h 写入</span></div>
          {/* 2026-10-13 round 76-DQ: 加载中显示 **+0**(实际 +1,025), 属假计数 -> 补 loading 守卫。 */}
          <div className={"trend-val " + styles.trendVal} data-tone="primary">{loading ? "..." : "+" + fmt(writesSum)}</div>
          <Sparkline data={writes24} color="var(--table-knowledge)" />
        </div>
        <div className="trend-card">
          <div className="trend-label"><span>主题覆盖</span></div>
          <div className="trend-val">{topics ? fmt(topics.total) : "..."}</div>
          <div className={styles.trendCaption}>平均覆盖率 {topics ? (topics.avgCoverage * 100).toFixed(1) + "%" : "..."}</div>
          <div className={"mini-bar " + styles.miniBarFull}>
            <div className={"mini-bar-fill " + pctClass(Math.min(100, (topics?.avgCoverage ?? 0) * 100))} />
          </div>
        </div>
        <div className="trend-card">
          <div className="trend-label"><span>数据健康</span></div>
          {/* 2026-10-13 round 76-DS: `q` 未加载时 `q?.emptyHash === 0` 为 **false** -> 显示 [0 空 Hash] + [待清理],
              是**误报警**(让用户以为有垃圾要清)。加载中应显示 …。 */}
          <div className={"trend-val " + styles.trendVal} data-tone={loading ? "dim" : q?.emptyHash === 0 ? "ok" : "warn"}>
            {loading ? "…" : q?.emptyHash === 0 ? "✓ 干净" : `${fmt(q?.emptyHash ?? 0)} 空 Hash`}
          </div>
          <div className={styles.trendCaption}>{loading ? "检测中" : q?.emptyHash === 0 ? "无需修复" : "待清理"}</div>
          <div className={"mini-bar " + styles.miniBarFull}>
            <div
              className={"mini-bar-fill " + styles.miniBarFill + " " + pctClass(q?.emptyHash === 0 ? 100 : 40)}
              data-tone={q?.emptyHash === 0 ? "ok" : "warn"}
            />
          </div>
        </div>
      </div>

      <div className="dashboard-section"><div className="dashboard-section-title">子模块入口</div>
      <div className="entry-grid">{subs.map(s => <EntryCard key={s.id} sub={s} />)}</div></div>

      <div className="grid-2">
        <div className="panel"><div className="panel-header"><span className="panel-title">5 表数据分布</span></div>
        {tableBars.length > 0 ? <BarChart bars={tableBars} /> : loading ? <div className={"skeleton " + styles.skelBlock} /> : <Empty description="暂无数据" />}</div>
        {/* 2026-10-20 维度审计（B9-2）：覆盖率分布口径不清 —— 补一句"覆盖率高=被引用得多"，
          并给"低分资产"一个治理入口（原来只有分布、没有下一步动作）。 */}
      <div className="panel"><div className="panel-header">
        <span className="panel-title">覆盖率分布</span>
        <span className={styles.headNote}>口径：0–1，越高表示这条资产被引用/使用的次数越多</span>
      </div>
        {covBars.some(b => b.value > 0) ? <BarChart bars={covBars} /> : loading ? <div className={"skeleton " + styles.skelBlock} /> : <Empty description="暂无数据" />}</div>
      </div>

      <div className="panel"><div className="panel-header">
        <span className="panel-title">数据质量分布（质量分：高 ≥0.7 / 中 ≥0.4 / 低 &lt;0.4，仅活跃数据）</span>
        <span className={styles.warmNote}>
          低分合计 {((q?.memory?.low || 0) + (q?.knowledge?.low || 0) + (q?.practice?.low || 0) + (q?.reflection?.low || 0) + (q?.skill?.low || 0)).toLocaleString()} 条 ·{" "}
          <a href="/cognitive/knowledge/governance">去治理 →</a>
        </span>
      </div>
        {qualityRows.length > 0 ? <><TableCopyButton />
            <DataTable
              columns={qualityColumns}
              rows={qualityRows}
              rowKey={(r) => r.key}
            />
            </> : loading ? <div className={"skeleton " + styles.skelBlockSm} /> : <Empty description="暂无数据" />}
      </div>
    </main></div>
  );
}
