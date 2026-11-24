"use client";
// 0.5.1 B4 附录 /cognitive 认知看板 · Bento 改造（2026-11-15）
// 数据：/api/stats（KPI/质量/覆盖率，有 asOf）+ /api/flywheel-dashboard（趋势/最近事件，无 asOf）
// 口径：五表求和（当次数据）；trend.writes=[] 是取数失败 → n/a+原因，严禁 0。
import { useApi } from "@/lib/api";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import BentoState from "@/components/bento/BentoState";
import { Chips, KpiTile, usePhaseOverride } from "../system/_components/bento-kit";
import { fmtNum, fmtTime } from "@/lib/format";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import Link from "next/link";
import styles from "./page.module.css";

interface StatsData { asOf?: string; data?: { tables?: any; topics?: any; quality?: any; coverageDistribution?: Record<string, number> } }
interface DashData { trend?: { writes?: { hb: number; c: number }[]; error?: string }; recentEvents?: any[] }
type Phase = "loading" | "empty" | "error" | "unavailable" | "forbidden" | "ok";

const QUALITY_KINDS = ["memory", "knowledge", "practice", "reflection", "skill"] as const;
const KIND_LABEL: Record<string, string> = { memory: "记忆", knowledge: "知识", practice: "实践", reflection: "反思", skill: "技能" };
const COV_BUCKETS = ["0-0.2", "0.2-0.4", "0.4-0.6", "0.6-0.8", "0.8-1.0"];

export default function CognitiveDashboard() {
  const stats = useApi<StatsData>("/api/stats");
  const dash = useApi<DashData>("/api/flywheel-dashboard");
  const forced = usePhaseOverride();
  const s = stats.data?.data;
  const t = s?.tables;
  const topics = s?.topics;
  const q = s?.quality;
  const cov = s?.coverageDistribution ?? {};
  const writes = dash.data?.trend?.writes;

  const loading = stats.loading;
  const base: Phase = loading ? "loading" : stats.error ? "error" : !t ? "unavailable" : "ok";
  const phase: Phase = forced && forced !== "ok" ? (forced as Phase) : base;

  const totalAll = t ? Number(t.memory || 0) + Number(t.knowledge || 0) + Number(t.reflection || 0) + Number(t.practice || 0) + Number(t.skill || 0) : null;
  const qualityTotals = QUALITY_KINDS.reduce((acc, k) => {
    const d = q?.[k];
    if (!d) return acc;
    acc.high += Number(d.high || 0); acc.mid += Number(d.mid || 0); acc.low += Number(d.low || 0);
    return acc;
  }, { high: 0, mid: 0, low: 0 });
  const qualityTotal = qualityTotals.high + qualityTotals.mid + qualityTotals.low;
  const highPct = qualityTotal ? (qualityTotals.high / qualityTotal) * 100 : null;
  const writesEmpty = !writes || writes.length === 0;
  const writesError = dash.data?.trend?.error;
  const writesSum = writesEmpty ? 0 : writes!.reduce((a, x) => a + Number(x.c || 0), 0);
  const covTotal = COV_BUCKETS.reduce((a, k) => a + Number(cov[k] || 0), 0);

  if (phase !== "ok") {
    return (
      <main className="page">
        <h1 className={styles.srOnly}>认知看板</h1>
        <PageHeader><PageTitle>认知看板</PageTitle><div className="page-subtitle">统一大脑 · 记忆/知识/反思/实践/技能</div><Chips group="认知" page="看板" /></PageHeader>
        <BentoState phase={phase === "empty" ? "empty" : phase} title={phase === "empty" ? "无数据" : phase === "error" ? "认知看板加载失败" : phase === "unavailable" ? "认知统计不可得" : "加载中"} detail={phase === "error" ? "平台统计接口（stats）请求失败 · 状态码 " + (stats.status != null ? String(stats.status) : (String(stats.error?.message || "").match(/\d{3}/)?.[0] || "n/a（强制态无响应）")) + "；请稍后重试。" : phase === "unavailable" ? "平台统计接口（stats）未返回五表数据 · 不把取不到当 0。" : undefined} onRetry={() => { stats.mutate(); dash.mutate(); }} />
      </main>
    );
  }

  return (
    <main className="page" data-slot="cognitive-page">
      <h1 className={styles.srOnly}>认知看板</h1>
      <PageHeader>
        <PageTitle>认知看板</PageTitle>
        <div className="page-subtitle">统一大脑 · 所有 AI 共享的记忆/知识/反思/实践/技能 · 数据时刻 {stats.data?.asOf ? fmtTime(stats.data.asOf) : "n/a（接口未下发 asOf）"} · 趋势 n/a（趋势接口无 asOf）</div>
        <Chips group="认知" page="看板" />
      </PageHeader>

      <BentoGrid>
        <KpiTile span={3} label="五表总量" metric={totalAll == null ? { kind: "na", reason: "统计接口未返回 tables" } : { kind: "value", value: fmtNum(totalAll), hint: "五表求和 · 来源：平台统计接口" }} />
        <KpiTile span={3} label="主题数" metric={topics?.total == null ? { kind: "na", reason: "接口未返回主题数" } : { kind: "value", value: fmtNum(topics.total), hint: topics.avgCoverage != null ? "平均覆盖 " + (Number(topics.avgCoverage) * 100).toFixed(2) + "%" : "平均覆盖 n/a" }} />
        <KpiTile span={3} label="活性（24h 写入）" metric={writesError ? { kind: "na", reason: "趋势查询失败（接口已标记 error，不是 0）" } : writesEmpty ? { kind: "value", value: "0", hint: "24h 窗口内无写入" } : { kind: "value", value: fmtNum(writesSum), hint: "24h 写入合计 · 趋势接口" }} />
        <KpiTile span={3} label="高质量占比" metric={highPct == null ? { kind: "na", reason: "质量分布接口未返回" } : { kind: "value", value: highPct.toFixed(2) + "%", hint: "派生：high / (high+mid+low)，全量" }} />

        <BentoCard span={8} title="质量分布" sub="全量 · 五表 high/mid/low；派生占比在 KPI">
          <table className={styles.table}>
            <thead><tr><th>类型</th><th className={styles.num}>高</th><th className={styles.num}>中</th><th className={styles.num}>低</th><th className={styles.num}>合计</th></tr></thead>
            <tbody>
              {QUALITY_KINDS.map((k) => {
                const d = q?.[k];
                if (!d) return null;
                const sum = Number(d.high || 0) + Number(d.mid || 0) + Number(d.low || 0);
                return <tr key={k}><td>{KIND_LABEL[k]}</td><td className={styles.num}>{fmtNum(d.high)}</td><td className={styles.num}>{fmtNum(d.mid)}</td><td className={styles.num}>{fmtNum(d.low)}</td><td className={styles.num}>{fmtNum(sum)}</td></tr>;
              })}
            </tbody>
            <tfoot><tr><th>合计</th><th className={styles.num}>{fmtNum(qualityTotals.high)}</th><th className={styles.num}>{fmtNum(qualityTotals.mid)}</th><th className={styles.num}>{fmtNum(qualityTotals.low)}</th><th className={styles.num}>{fmtNum(qualityTotal)}</th></tr></tfoot>
          </table>
          <p className={styles.note}>高质量占比为派生口径（high / 全量质量行），非独立接口字段。</p>
        </BentoCard>

        <BentoCard span={4} title="主题覆盖" sub="全量 · 主题与平均覆盖率">
          <ul className={styles.kv}>
            <li><span>主题数</span><b>{topics?.total == null ? "n/a" : fmtNum(topics.total)}</b></li>
            <li><span>平均覆盖率</span><b>{topics?.avgCoverage == null ? "n/a（接口未下发）" : (Number(topics.avgCoverage) * 100).toFixed(2) + "%"}</b></li>
            <li><span>覆盖率桶合计</span><b>{fmtNum(covTotal)}</b></li>
            <li><span>校验</span><b>{topics?.total != null && covTotal !== Number(topics.total) ? "与主题数不一致，见桶" : "5 桶合计 = 主题数"}</b></li>
          </ul>
          <p className={styles.note}>两口径警告：本页只用五表求和 {totalAll == null ? "n/a" : fmtNum(totalAll)}（当次口径）；若出现 200,358 为另一口径，待查，不混称总量。</p>
        </BentoCard>

        <BentoCard span={12} title="覆盖率分布" sub="5 桶 · 合计应与主题数一致">
          <div className={styles.bars}>
            {COV_BUCKETS.map((k) => {
              const v = Number(cov[k] || 0);
              const pct = covTotal ? Math.round((v / covTotal) * 100) : 0;
              return <div key={k} className={styles.barRow}><span className={styles.barLabel}>{k}</span><div className={styles.barTrack}><div className={styles.barFill} style={{ width: pct + "%" }} /></div><span className={styles.barVal}>{fmtNum(v)}</span></div>;
            })}
          </div>
        </BentoCard>

        <BentoCard span={12} title="活性趋势与最近事件" sub="趋势接口无 asOf；空数组是取数失败，不是 0">
          {writesEmpty ? <BentoState phase={writesError ? "unavailable" : "empty"} title={writesError ? "24h 趋势 n/a" : "24h 窗口内无写入"} detail={writesError ? "趋势查询失败（接口已标记 error，不是 0）；最近事件仍按接口返回展示。" : "趋势接口返回空数组且无 error：24h 窗口内无写入，显示 0 不是取数失败。"} /> : (
            <div className={styles.bars}>
              {writes!.slice(-24).map((x) => <div key={x.hb} className={styles.barRow}><span className={styles.barLabel}>{new Date(x.hb * 3600000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</span><div className={styles.barTrack}><div className={styles.barFill} style={{ width: Math.min(100, Number(x.c || 0)) + "%" }} /></div><span className={styles.barVal}>{fmtNum(x.c)}</span></div>)}
            </div>
          )}
          <h3 className={styles.subhead}>最近事件</h3>
          {dash.data?.recentEvents?.length ? <ul className={styles.events}>{dash.data.recentEvents.slice(0, 8).map((e: any, i: number) => <li key={i}><span>{e.time || e.at ? fmtTime(e.time || e.at) : "n/a"}</span><b>{e.title || e.type || e.kind || "事件"}</b></li>)}</ul> : <p className={styles.note}>无事件（接口返回空集）。</p>}
        </BentoCard>

        <BentoCard span={12} title="相关视图" sub="认知资产与治理入口 · 只读">
          <p className={styles.links}><Link href="/cognitive/knowledge">知识库</Link><Link href="/cognitive/memory">记忆库</Link><Link href="/cognitive/practice">实践</Link><Link href="/cognitive/reflection">反思</Link><Link href="/cognitive/skills">技能</Link><Link href="/cognitive/knowledge?tab=governance">治理概览</Link></p>
          <p className={styles.note}>0.5.1 只读：本页不渲染任何写控件；数据来自平台统计接口与飞轮看板接口。</p>
        </BentoCard>
      </BentoGrid>
    </main>
  );
}