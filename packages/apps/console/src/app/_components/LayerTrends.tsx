"use client";
// 2026-10-20 第二屏：各层业务趋势（人类："向下第二屏是不是要把每层的业务数据趋势表现一下"）
// 按业务分层给 4 张趋势卡，每张只回答一个问题、只画一条线：
//   ① 原始输入：每小时新增会话   ② 提炼：每小时新增认知   ③ 资产：五表存量+质量   ④ 取用/行动：模型调用 + 任务
// 数据全部来自既有 /api/overview（sessions.trend / products.byTable[].trend / tasks.trend / quality），零新接口。
// 缺数据就写"暂无"，不画 0（规范铁律 2）。
import Sparkline from "@/components/Sparkline";
import { useApi } from "@/lib/api";
import { fmtNum } from "@/lib/format";

type Card = { key: string; icon: string; title: string; series: number[]; num: string; sub: string; extra?: { k: string; v: string }[] };

export default function LayerTrends({ data }: { data: any }) {
  // 2026-10-21 前端对账：overview.products.total 是"区间新增"，不是存量；
  //   ③ 卡要显示"存量"必须取 /api/stats 全量（PG 实测 343,934 量级，与 24h 新增 2,244 完全不同）。
  const { data: stats } = useApi<any>("/api/stats");
  if (!data) return null;
  const s = data.sessions || {}, p = data.products || {}, t = data.tasks || {};
  const stg = stats?.data?.tables;
  const totalAll: number | null = stg ? (Object.values(stg) as any[]).reduce((a: number, v: any) => a + (Number(v) || 0), 0) : null;
  const q = data.quality?.byTable || {};
  const tables = Object.values(p.byTable || {}) as any[];
  const assetTrend = Array.from({ length: 24 }, (_, i) => tables.reduce((acc: number, x: any) => acc + (Number(x?.trend?.[i]) || 0), 0));
  // 2026-10-21 对账：页面上"新增"用精确计数（各表 n 求和），趋势桶只负责画线（会丢最后一个不完整小时）
  const added24 = tables.reduce((a: number, x: any) => a + (Number(x?.n) || 0), 0);
  const assetSum = assetTrend.reduce((a, b) => a + b, 0);
  // 存量曲线：以"当前总量 − 近24h新增"为起点，按小时累加 → 单调上升，和"每小时新增"是两条不同的线
  const baseline = Math.max(0, Number(totalAll ?? p.total ?? 0) - assetSum);
  let run = baseline;
  const stockTrend = assetTrend.map((n) => (run += n));
  const qv = Object.values(q) as any[];
  const avgQ = qv.length ? qv.reduce((acc: number, v: any) => acc + (Number(v?.avg) || 0), 0) / qv.length : 0;
  const consumeTrend: number[] = data.trend?.events || data.llmStats?.trend || [];
  const taskTrend: number[] = t.trend || [];

  const cards: Card[] = [
    { key: "input", icon: "💬", title: "① 原始输入", series: s.trend || [], num: fmtNum(s.newSessions ?? 0), sub: "近 24h 会话 · 流入消息 " + fmtNum(s.inflowMessages ?? 0) },
    { key: "distill", icon: "⚙️", title: "② 提炼产出", series: assetTrend, num: fmtNum(added24), sub: "近 24h 新增认知资产 · 五表（含反思）合计" },
    { key: "asset", icon: "🧠", title: "③ 活跃资产存量（累计）", series: stockTrend, num: totalAll != null ? fmtNum(totalAll) : "—", sub: "五表活跃量 · 平均质量 " + (avgQ ? avgQ.toFixed(2) : "—"), extra: tables.slice(0, 4).map((x: any) => ({ k: String(x.table || ""), v: fmtNum(x.n ?? 0) })) },
    { key: "consume", icon: "🧲", title: "④ 取用与行动", series: consumeTrend.length ? consumeTrend : taskTrend, num: fmtNum(t.running ?? 0), sub: "运行中任务 · 已完成 " + fmtNum(t.done ?? 0) },
  ];

  return (
    <section className="lt-wrap">
      <div className="lt-head">
        <span className="lt-title">各层业务趋势（近 24 小时）</span>
        <span className="lt-hint">每一层只看一条线：涨=这一层在产出，平=停住了</span>
      </div>
      <div className="lt-grid">
        {cards.map((c) => (
          <div className="lt-card" key={c.key}>
            <div className="lt-card-top">
              <span className="lt-icon">{c.icon}</span>
              <span className="lt-name">{c.title}</span>
            </div>
            <div className="lt-num">{c.num}</div>
            <div className="lt-spark">
              {c.series.filter((n) => Number.isFinite(n)).length >= 2
                ? <Sparkline data={c.series.map((n) => Number(n) || 0)} width={280} height={44} />
                : <span className="lt-empty">暂无时序数据</span>}
            </div>
            <div className="lt-sub">{c.sub}</div>
            {c.extra ? (
              <div className="lt-extra">
                {/* 2026-10-22 修重复 key：表的 table 名可能缺失/重复（实测 warning 4 条），加索引保证唯一 */}
                {c.extra.map((e, i) => <span key={(e.k || "t") + "-" + i}><b>{e.v}</b> {e.k}</span>)}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}