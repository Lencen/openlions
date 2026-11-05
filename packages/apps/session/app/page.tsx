import Topbar from "./components/Topbar";
import SyncLogPanel from "./components/SyncLogPanel";
import { TrendChart, HourChart, AgentBar, SourceSplit } from "./components/Charts";
// 2026-09-02: 排除 0-消息 + 定时任务触发的 session
import { loadOverview } from "@/lib/home-overview";

export const dynamic = "force-dynamic";

export default async function Home() {
  const now = new Date(); now.setUTCHours(0,0,0,0);

  // ord-20261104-046：8 条查询合并为 1 条 CTE + 60s 缓存（口径不变，见 lib/home-overview.ts）
  const ov = await loadOverview();
  const { sessionCount, messageCount, byAgent, byStatus, recentSessions, trend, hourDist, agent7d, sourceDist } = ov;

  // 14d trend / hourly distribution 已由 SQL 聚合（见 home-overview.ts）
  // 7d agent / source 分布已由 SQL 聚合（见 home-overview.ts）

  const fmt = (d: Date | null) =>
    d ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai",  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d instanceof Date ? d : new Date(d)) : "—";

  // Phase C 2026-08-31: EXTRACTED 统计 DONE (Session 表实际用 DONE, 之前查 PROCESSED/EXTRACTED 永远 0)
  const extracted = byStatus.find(s => s.extractStatus === "DONE")?._count || 0;
  const pending = byStatus.find(s => s.extractStatus === "PENDING")?._count || 0;
  const failed = byStatus.find(s => s.extractStatus === "FAILED")?._count || 0;
  const peakSessions = Math.max(...trend.map(t => t.sessions), 0);
  const todaySessions = trend[trend.length - 1]?.sessions || 0;
  const a7Sum = agent7d.reduce((s,a) => s+a.sessions, 0);
  const a7Top = agent7d[0];
  // Phase C 2026-08-31: avgMsg = 平均每 session 消息数 (之前取第一个非空 status 的 count, 逻辑错误)
  const avgMsg = sessionCount > 0 ? (messageCount / sessionCount).toFixed(1) : "0";

  return (
    <>
      <Topbar active="overview" stats={`${sessionCount.toLocaleString()} sessions · ${messageCount.toLocaleString()} messages`} />
      <main className="page">
        <div className="eyebrow">Overview · Updated {fmt(new Date())}</div>
        <h1 className="title">All your agents&apos; <em>conversations</em>, archived.</h1>
        <p className="subtitle">Lions-Session 永久存储所有接入 Lions-Mind 的 agent 会话。增量同步, 全文检索, 按 agent / 来源 / 状态多维筛选。</p>

        <div className="kpi-row">
          <div className="kpi-cell">
            <div className="label">SESSIONS</div>
            <div className="value">{sessionCount.toLocaleString()}</div>
            <div className="hint">14d peak {peakSessions} · today {todaySessions}</div>
          </div>
          <div className="kpi-cell">
            <div className="label">MESSAGES</div>
            <div className="value">{messageCount.toLocaleString()}</div>
            <div className="hint">avg {avgMsg} / extracted</div>
          </div>
          <div className="kpi-cell">
            <div className="label">EXTRACTED</div>
            <div className="value">{extracted}</div>
            <div className="hint">{pending.toLocaleString()} pending · {failed} failed</div>
          </div>
          <div className="kpi-cell">
            <div className="label">AGENTS</div>
            <div className="value">{byAgent.length}</div>
            <div className="hint">7d active: {a7Top ? `${a7Top.agentId.replace("agent-","")} ${a7Top.sessions}` : "—"}{a7Sum > (a7Top?.sessions||0) ? ` · 其他 ${a7Sum - (a7Top?.sessions||0)}` : ""}</div>
          </div>
        </div>

        <div className="charts-row">
          <div className="chart-card chart-card--wide">
            <div className="chart-card__head">
              <h3>14-day trend</h3>
              <span className="chart-card__hint">sessions / messages, by day</span>
            </div>
            <TrendChart trend={trend} />
          </div>
          <div className="chart-card">
            <div className="chart-card__head">
              <h3>Hourly distribution</h3>
              <span className="chart-card__hint">UTC hours, all sessions</span>
            </div>
            <HourChart hourDist={hourDist} />
          </div>
        </div>

        <div className="charts-row">
          <div className="chart-card">
            <div className="chart-card__head">
              <h3>Agent activity · 7d</h3>
              <span className="chart-card__hint">sessions per agent</span>
            </div>
            <AgentBar agents={agent7d} />
          </div>
          <div className="chart-card">
            <div className="chart-card__head">
              <h3>Source split</h3>
              <span className="chart-card__hint">by data source</span>
            </div>
            <SourceSplit sources={sourceDist} />
          </div>
        </div>

        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Pipeline</h2>
            <span className="section__hint">extract status, all-time</span>
          </div>
          <div className="pipeline">
            {byStatus.map((s) => (
              <div key={s.extractStatus || "x"} className={`pipeline__cell pipeline__cell--${(s.extractStatus || "none").toLowerCase()}`}>
                <div className="pipeline__count">{s._count}</div>
                <div className="pipeline__label">{s.extractStatus || "NONE"}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Recent sessions</h2>
            <a href="/sessions" className="section__more">View all →</a>
          </div>
          <div className="recent">
            {recentSessions.map((s) => (
              <a key={s.id} href={`/sessions/${s.id}`} className="recent__row">
                <span className={`tag tag--agent tag--${s.agentId || "unknown"}`}>{s.agentId?.replace("agent-","") || "—"}</span>
                <span className="tag tag--src">{s.channel || s.source || "—"}</span>
                <span className="recent__title">{s.title || "Untitled"}</span>
                <span className="recent__meta">{s.messageCount} msgs</span>
                <span className={`tag tag--st tag--st-${(s.extractStatus || "none").toLowerCase()}`}>{s.extractStatus || "NONE"}</span>
                <span className="recent__time">{fmt(s.lastMessageAt)}</span>
              </a>
            ))}
            {recentSessions.length === 0 && <div className="recent__empty">No sessions yet</div>}
          </div>
        </section>

        {/* 2026-09-01: 数据同步日志实时滚动 (cron 每 10 分钟) */}
        <SyncLogPanel />
      </main>
    </>
  );
}
