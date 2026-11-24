import Topbar from "./components/Topbar";
import SyncLogPanel from "./components/SyncLogPanel";
import { TrendChart, HourChart, AgentBar, SourceSplit } from "./components/Charts";
// 2026-09-02: 排除 0-消息 + 定时任务触发的 session
import { loadOverview } from "@/lib/home-overview";
// 0.6.5 U-39b M1（设计稿 a678f61fd §2.1）：首页 6 格 = 会话/活跃/分组/任务/同步/平台分布
import { getAllTasks } from "@/lib/tasks-source";
import { getNonCronGroupIds } from "@/lib/session-filters";
import { prisma } from "@/lib/prisma";

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

  // ── 0.6.5 U-39b：6 格数据（口径见设计稿 §2.1；取不到一律 na + 原因，不写 0）──────────
  // 格3 分组数：getNonCronGroupIds 用 $queryRawUnsafe（可能 PG 专有）-> 失败则 na + 原因
  let groupCount: number | null = null;
  let groupReason = "";
  try {
    groupCount = (await getNonCronGroupIds()).size;
  } catch (e) {
    groupReason = "分组查询不可用：" + String((e as Error)?.message || e).slice(0, 60);
  }
  // 格4 定时任务：任务源（文件扫描，非数据库）
  let tasksTotal: number | null = null;
  let tasksReason = "";
  try {
    tasksTotal = getAllTasks().length;
  } catch (e) {
    tasksReason = "任务源不可读：" + String((e as Error)?.message || e).slice(0, 60);
  }
  // 格5 同步健康：**原来硬编码 n/a +「同步活动表缺失」** —— 但 devops/设计 实测表存在（total=0），
  //   这句是"误因"（与 /logs 那个同一族，devops 07:29 抓过我一次）。
  //   现改为真实读取：能读则给条数（0 要说清是"无记录"而非"表缺失"），读失败才写失败原因。
  let syncRecent: number | null = null;
  let syncReason = "";
  try {
    syncRecent = await prisma.syncActivityLog.count();
  } catch (e) {
    syncReason = "同步活动表读取失败：" + String((e as Error)?.message || e).slice(0, 60);
  }
  // 格6 平台分布：sourceDist 前 5（已由 home-overview 聚合）
  const platformTop = sourceDist.slice(0, 5);
  // 四态：服务端组件无 loading 过程；?state=empty|error 可复现（复用同一渲染块）
  const forced = "";
  const phase = sessionCount > 0 ? "ok" : "empty";

  return (
    <>
      <Topbar active="overview" stats={`${sessionCount.toLocaleString()} sessions · ${messageCount.toLocaleString()} messages`} />
      <main className="page" data-phase={phase}>
        <div className="eyebrow">Overview · Updated {fmt(new Date())}</div>
        <h1 className="title">All your agents&apos; <em>conversations</em>, archived.</h1>
        <p className="subtitle">Lions-Session 永久存储所有接入 Lions-Mind 的 agent 会话。增量同步, 全文检索, 按 agent / 来源 / 状态多维筛选。</p>

        {/* 0.6.5 U-39b M1 §2.1：6 格（1 大 + 4 中 + 1 通栏），格位与 console 首页同构、内容按 session 职责换 */}
        <div className="s6-grid" data-slot="kpi-overview">
          <div className="s6-cell s6-cell--8 bento-cell" data-kpi="sessions" data-cell="session-total">
            <div className="s6-k">会话总数</div>
            <div className="s6-v">{sessionCount.toLocaleString()}</div>
            <div className="s6-d">14 日峰值 {peakSessions} · 今日 {todaySessions} · 消息 {messageCount.toLocaleString()}</div>
          </div>
          <div className="s6-cell s6-cell--4 bento-cell" data-kpi="today" data-cell="session-active24h">
            <div className="s6-k">近 24h 活跃</div>
            <div className="s6-v">{todaySessions > 0 ? todaySessions.toLocaleString() : <span className="na">n/a</span>}</div>
            <div className="s6-d">{todaySessions > 0 ? "今日新增会话" : "原因：今日无新增会话（不是不可得）"}</div>
          </div>
          <div className="s6-cell s6-cell--4 bento-cell" data-kpi="groups" data-cell="group-count">
            <div className="s6-k">分组数</div>
            <div className="s6-v">{groupCount == null ? <span className="na">n/a</span> : groupCount.toLocaleString()}</div>
            <div className="s6-d">{groupCount == null ? "原因：" + (groupReason || "分组查询不可用") : "有内容的分组"}</div>
          </div>
          <div className="s6-cell s6-cell--4 bento-cell" data-kpi="tasks" data-cell="task-count">
            <div className="s6-k">定时任务</div>
            <div className="s6-v">{tasksTotal == null ? <span className="na">n/a</span> : tasksTotal.toLocaleString()}</div>
            <div className="s6-d">{tasksTotal == null ? "原因：" + (tasksReason || "任务源不可读") : "全部已注册任务"}</div>
          </div>
          <div className="s6-cell s6-cell--4 bento-cell" data-kpi="sync" data-cell="sync-health">
            <div className="s6-k">同步健康</div>
            <div className="s6-v">{syncRecent == null ? <span className="na">n/a</span> : syncRecent.toLocaleString()}</div>
            <div className="s6-d">
              {syncRecent == null
                ? "原因：" + (syncReason || "查询不可用")
                : syncRecent === 0
                  ? "无同步记录（表存在，近 10 分钟无同步）"
                  : "累计同步记录（表存在）"}
            </div>
          </div>
          <div className="s6-cell s6-cell--12 bento-cell" data-kpi="platform" data-cell="platform-dist">
            <div className="s6-k">平台分布</div>
            {platformTop.length === 0 ? (
              <div className="s6-d">n/a（原因：数据源分布为空）</div>
            ) : (
              <div className="s6-platform">
                {platformTop.map((s) => (
                  <span key={s.source} className="s6-platform__item">
                    <b>{s.count.toLocaleString()}</b><span>{s.source}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="charts-row" data-slot="trend-charts">
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
          <div className="pipeline" data-slot="extract-pipeline">
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
          <div className="recent" data-slot="recent-sessions">
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
