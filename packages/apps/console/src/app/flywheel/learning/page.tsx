"use client";
// 2026-10-15（round 76-FU）《控制台数据展示规范》§5 第 ④ 项：「飞轮看得见的用户视角页」。
//   规范原话: 「面向用户讲『它在学』，与产品化三件套之一重合」。
//   本页刻意**不堆指标**(铁律 1: 一眼看到最重要那个数字), 结构是「结论 -> 关键指标 -> 明细」：
//     ① 一句话结论: 过去 24 小时学到了什么;
//     ② 四张卡: 记忆/知识/反思/实践 的 24h 新增(带单位「条」与**数据时刻**);
//     ③ 两块明细: 沉淀质量(结构化发现覆盖率) 与 最近学到的东西。
//   四态按规范区分: 加载中… / 真的 0 / —(不适用) / 未知(取不到)。
import { MetricCard, PageHero, Pill } from "@/components/ui";
import Link from "next/link";
import ErrorAlert from "@/components/ErrorAlert";
import { useApi } from "@/lib/api";
import DataMoment from "@/components/DataMoment";
import { fmtCompact, fmtNum, fmtPctOf, fmtState, fmtTime } from "@/lib/format";

type TableStat = { table: string; active: number; h24: number; h1: number };
type Dash = {
  tableStats?: TableStat[];
  themes?: Array<{ theme: string; count?: number; coverage?: number }>;
  timestamp?: string | number;
};
type Stats = {
  /** 77-P/Q: BFF 顶层新增的"数据时刻" */
  asOf?: string;
  data?: {
    reflections?: { total?: number; ok?: number; failed?: number };
    structuredFindings?: { covered?: number; total?: number; rate?: number };
  };
};

const PRETTY: Record<string, string> = { Memory: "记忆", Knowledge: "知识", Reflection: "反思", Practice: "实践", Skill: "技能" };

export default function LearningPage() {
  const { data, loading, error, mutate } = useApi<Dash>("/api/flywheel-dashboard");
  const { data: raw, error: statsErr, mutate: mutateStats } = useApi<Stats>("/api/flywheel-stats");
  const flags = { loading, error: !!error };
  const stats = raw?.data;
  const asOf = data?.timestamp;
  // 24h 新增: 只取我们对外讲的四类(记忆/知识/反思/实践), 且按固定顺序排版, 保证每次看到的位置一致。
  const ORDER = ["Memory", "Knowledge", "Reflection", "Practice"];
  const byName = new Map((data?.tableStats ?? []).map((t) => [t.table, t]));
  const items = ORDER.map((k) => ({ key: k, label: PRETTY[k] ?? k, stat: byName.get(k) }));
  const totalH24 = items.reduce((n, x) => n + (x.stat?.h24 ?? 0), 0);
  const anyData = !!data;

  if (error) {
    return (
      <main className="page">
        <PageHero title="它在学" subtitle="飞轮最近学到了什么" />
        <ErrorAlert title="学习数据加载失败" message={String((error as Error)?.message || error)} onRetry={() => { mutate(); mutateStats(); }} />
      </main>
    );
  }

  return (
    <main className="page">
      <PageHero
        title="它在学"
        subtitle="不看流程，只看它最近学到了什么 —— 记忆、知识、反思、实践各自长出来多少。"
        tags={<>
          <Pill tone="info">近 24 小时</Pill>
          {/* 2026-10-16（round 77-Q, 决策③逐源 + 77-M 机检清单）: 本页有 **2 个数据源** ——
              /api/flywheel-dashboard（四张卡的 24h 新增）与 /api/flywheel-stats（沉淀质量那块）。
              此前这里只用**看板的** timestamp ✗ -> 沉淀质量的数字戴着看板的时刻。
              实测两源各自都有时刻（看板 timestamp / 指标 asOf，后者是 77-P 补上的），故纯页面改动 ✓。
              注意: 四张卡的 asOf={asOf} 仍用**看板**的时刻 —— 那是它们真正的来源, 是正确的 ✓。 */}
          <DataMoment items={[{ label: "看板", at: data?.timestamp }, { label: "指标", at: raw?.asOf }]} />
        </>}
      />

      {/* ① 结论（铁律 1：先给一句话结论） */}
      <div className="panel" style={{ marginBottom: "var(--sp-4)" }}>
        <div className="panel-header"><span className="panel-title">一句话结论</span></div>
        <div style={{ padding: "var(--sp-3-5) var(--sp-4)", fontSize: "var(--fs-lg)", lineHeight: 1.7 }}>
          {!anyData ? (
            <span style={{ color: "var(--text-dim)" }}>{fmtState(undefined, flags)}</span>
          ) : totalH24 > 0 ? (
            <>过去 24 小时，它一共记住 / 想清楚 / 练到了 <b>{fmtNum(totalH24)}</b> 条新东西。</>
          ) : (
            <>过去 24 小时没有新增沉淀（这很正常：没有新的会话进来时，飞轮就没有可学的东西）。</>
          )}
        </div>
      </div>

      {/* ② 四张卡（带单位与数据时刻） */}
      <div className="metric-row">
        {items.map((x) => (
          <MetricCard
            key={x.key}
            label={x.label}
            value={fmtState(x.stat?.h24, flags)}
            unit="条"
            asOf={asOf}
            hint={x.stat ? `累计 ${fmtCompact(x.stat.active)} 条` : undefined}
            tone={x.key === "Memory" ? "info" : x.key === "Knowledge" ? "ok" : x.key === "Reflection" ? "warn" : "mute"}
          />
        ))}
      </div>

      {/* ③ 明细：沉淀质量 + 最近学到的东西 */}
      <div className="card-grid cols-2" style={{ marginTop: "var(--sp-4)" }}>
        <div className="panel">
          <div className="panel-header"><span className="panel-title">沉淀质量</span><span className="tiny">结构化发现覆盖率</span></div>
          <div style={{ padding: "var(--sp-3-5) var(--sp-4)", fontSize: "var(--fs-lg)", lineHeight: 1.9 }}>
            <div>反思总数 <b>{fmtState(stats?.reflections?.total, { loading, error: !!statsErr })}</b> 条（其中成功 {fmtState(stats?.reflections?.ok, { loading, error: !!statsErr })} 条）</div>
            <div>结构化发现覆盖 <b>{stats?.structuredFindings ? fmtPctOf(stats.structuredFindings.covered, stats.structuredFindings.total) : fmtState(undefined, { loading, error: !!statsErr })}</b></div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-header"><span className="panel-title">最近在关注的主题</span><span className="tiny">按飞轮统计</span></div>
          <div style={{ padding: "var(--sp-3-5) var(--sp-4)", fontSize: "var(--fs-lg)", lineHeight: 1.9 }}>
            {(data?.themes ?? []).length === 0 ? (
              <span style={{ color: "var(--text-dim)" }}>{fmtState(undefined, flags)}</span>
            ) : (
              (data?.themes ?? []).slice(0, 6).map((t, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "var(--sp-3)" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.theme}</span>
                  <span className="mono" style={{ color: "var(--text-dim)" }}>{t.count != null ? `覆盖 ${fmtNum(t.count)}` : ""}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      {/* 2026-10-19 B5(收尾): 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
      <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
        <span>相关视图：</span>
        <Link href="/cognitive/knowledge">沉淀的知识 →</Link>
        <Link href="/flywheel/reflections">飞轮反思 →</Link>
      </div>
    </main>
  );
}
