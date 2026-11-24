"use client";

// / — 0.5 D6-D12 总览（按 demo slot 还原，2026-11-13）
// slot：s8 hero(4 stat + 30d line + 3 chip) + s4 需要人决策 + s3 智能体在线 + s5 实时活动 + s4 认知资产 + s4 成本 + s8 最近会话
// 数据：真实优先；无源槽位原位 n/a+原因（不删槽/不换卡/不改栅格）。demo 示例值禁入。
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
// 0.6.2 D-05-05：四看板骨架 — 复用 components/bento（BentoCard/BentoGrid/BentoKpi/BentoState）
import { BentoCard } from "@/components/bento";
import styles from "./page.module.css";

interface Board {
  ok?: boolean; asOf?: string; reason?: string;
  agents?: { total: number | null; active: number | null } | null;
  sessions?: { total: number | null } | null;
  flywheel?: { pending: number; processing: number; backlog: number } | null;
  data?: { memory: number | null; knowledge: number | null; practice: number | null; skill: number | null; reflection: number | null; total: number } | null;
  tools?: { active: number; registered: number } | null;
  services?: { count: number } | null;
  unavailable?: Array<{ field?: string; reason?: string }>;
}
interface TodoStats { ok?: boolean; open?: number; doing?: number; asOf?: string; }
interface Todo { id?: string; title?: string; status?: string; ownerType?: string; ownerId?: string | null; dueAt?: string | number; priority?: string; }
interface InboxItem { message_id?: string; from?: string; text?: string; created_at?: string; delivery_status?: string; }
interface SessionRow { id?: string; agent_id?: string; title?: string; message_count?: number; status?: string; last_message_at?: string; updated_at?: string; }

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : null);
const fmt = (v?: string) => { if (!v) return "—"; const d = new Date(v); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const short = (s?: string, len = 42) => { const t = String(s || "").replace(/\s+/g, " "); return t.length > len ? t.slice(0, len - 1) + "…" : t; };

export default function OverviewPage({ forcedState = null }: { forcedState?: string | null }) {
  const router = useRouter();
  // 2026-11-19 F6/B-01：服务端传入 ?state= 强制态（page.tsx 解析 searchParams）；非法值忽略。
  const FORCED = forcedState === "empty" || forcedState === "error" || forcedState === "unavailable" || forcedState === "forbidden" ? forcedState : null;
  const [b, setB] = useState<Board | null>(null);
  const [todo, setTodo] = useState<TodoStats | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  // 待办明细取数失败时的业务中文原因（与"无待办"区分：不写 0，也不笼统写"接口未返回"）
  const [todoNote, setTodoNote] = useState("");
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [phase, setPhase] = useState<"loading" | "ok" | "error" | "forbidden" | "unavailable" | "empty">(FORCED ?? "loading");
  const [err, setErr] = useState(FORCED ? "（复现模式：?state=" + FORCED + "）" : "");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);
  // 0.6.4 U-56b B-03：会话流入 30 天趋势（[team] 06:43 契约：按 UTC 自然日、缺日不补 0）
  const [trendS, setTrendS] = useState<Array<{ day: string; n: number }> | null>(null);
  const [trendSReason, setTrendSReason] = useState("");

  useEffect(() => {
    // 2026-11-19 F6/B-01：?state= 已提到服务端（page.tsx 读 searchParams -> forcedState），
    //   SSR 首屏即为该态（curl/截图/判据可直接判定），不再依赖 hydrate 后的 window.location。
    //   强制态下不取数、不改态 —— 保证「看到的 = URL 要求的」。
    if (FORCED) return;
    let alive = true; setPhase("loading"); setErr("");
    // 趋势独立取数：失败/无数据都保留 na + 原因（设计 判据⑤：不得画空线、不得假 0 线）
    fetch("/api/flywheel/assets/trend?asset=session&days=30", { cache: "no-store" })
      .then((x) => (x.ok ? x.json() : null))
      .then((j) => {
        if (!alive || !j) return;
        if (Array.isArray(j.trend) && j.trend.length > 0) { setTrendS(j.trend); setTrendSReason(""); }
        else { setTrendS(null); setTrendSReason(String(j.reason || "30 天趋势未采集")); }
      })
      .catch(() => { if (alive) { setTrendS(null); setTrendSReason("趋势请求失败（网络/服务不可用）"); } });
    (async () => {
      try {
        const [br, tr, to, inb, sl] = await Promise.all([
          fetch("/api/board-overview", { cache: "no-store" }),
          fetch("/api/todo-stats", { cache: "no-store" }).catch(() => null),
          fetch("/api/todos?status=OPEN&limit=20", { cache: "no-store" }).catch(() => null),
          fetch("/api/macs/session-inbox", { cache: "no-store" }).catch(() => null),
          fetch("/api/session-list", { cache: "no-store" }).catch(() => null),
        ]);
        if (!alive) return;
        if (br.status === 401 || br.status === 403) { setPhase("forbidden"); return; }
        if (!br.ok) { setErr("总览接口 " + br.status); setPhase("error"); return; }
        const bj: Board = await br.json();
        if (bj.ok !== true) { setErr(bj.reason || "总览不可得"); setPhase("unavailable"); return; }
        const hasAny = !!bj.agents || !!bj.sessions || !!bj.data || !!bj.tools || !!bj.flywheel || !!bj.services;
        if (!hasAny) { setPhase("empty"); return; }
        setB(bj);
        if (tr && tr.ok) { const j = await tr.json(); if (alive && j?.ok === true) setTodo(j); }
        // 待办明细：失败（503/ok:false）与"确实没有 OPEN 待办"必须区分——前者给业务中文原因，后者给"0 行"说明；都不写 0
        if (to) {
          try {
            const j = await to.json();
            if (alive) {
              const rows = Array.isArray(j?.rows) ? j.rows : [];
              const e = String(j?.error || "");
              setTodos(rows);
              setTodoNote(
                j?.ok === false
                  ? (e.indexOf("timestamp") >= 0 ? "待办明细取数失败（时间字段口径异常），仅有总数；不写 0" : "待办明细取数失败（只读明细报错），仅有总数；不写 0")
                  : (rows.length ? "" : "只读库本轮没有未完成的待办明细"),
              );
            }
          } catch {
            if (alive) { setTodos([]); setTodoNote("待办明细取数失败（明细查询未响应），仅有总数；不写 0"); }
          }
        } else if (alive) {
          setTodos([]);
          setTodoNote("待办明细取数失败（明细查询未响应），仅有总数；不写 0");
        }
        if (inb && inb.ok) { const j = await inb.json(); if (alive) setInbox(Array.isArray(j?.items) ? j.items : []); }
        if (sl && sl.ok) { const j = await sl.json(); if (alive) setSessions(Array.isArray(j?.result?.data?.items) ? j.result.data.items : []); }
        if (alive) setPhase("ok");
      } catch {
        if (alive) { setErr("总览请求失败（网络/服务不可用）"); setPhase("error"); }
      }
    })();
    return () => { alive = false; };
  }, [nonce, FORCED]);

  const humanTodos = todos.filter((t) => String(t.ownerType || "").toLowerCase() === "human").slice(0, 4);
  const decisions = humanTodos.length ? humanTodos : todos.slice(0, 4);
  // s8 最近会话：按最近活动倒序取前 6 条（无数据则整格 n/a + 原因，不造样例）
  const recentSessions = [...sessions]
    .sort((x, y) => String(y.last_message_at || y.updated_at || "").localeCompare(String(x.last_message_at || x.updated_at || "")))
    .slice(0, 6);
  const totalAgents = b?.agents?.total ?? null;
  const activeAgents = b?.agents?.active ?? null;
  const onlineDots = Math.min(8, activeAgents ?? 0);

  return (
    <main className="page" data-phase={phase}>
      <PageHeader>
        <PageTitle>总览</PageTitle>
        <div className="page-subtitle">默认落地页：今天要看的 6 件事 + 全平台规模与健康</div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级">
        <span>#</span><span>看板</span><span>现有</span><span className={styles.crumbOn}>只读</span>
      </div>

      {phase === "loading" && <div className={styles.state}>加载中…</div>}
      {phase === "forbidden" && <div className={styles.state}><b>无权限</b><p>当前账号没有查看总览的权限（401/403）。</p></div>}
      {phase === "unavailable" && <div className={styles.state}><b>总览不可得</b><p>{err || "只读聚合不可用"}</p><button className="btn" onClick={reload}>重试</button></div>}
      {phase === "empty" && <div className={styles.state}><b>暂无数据</b><p>六域接口正常返回但当前无数据（empty）。</p></div>}
      {phase === "error" && <div className={styles.state}><b>加载失败</b><p>{err}</p><button className="btn" onClick={reload}>重试</button></div>}

      {phase === "ok" && (
        <div className={styles.bento}>
          {/* s8 hero */}
          {/* 0.6.4 U-56b 板①-1（设计 06:25 差异①）：设计稿下钻为「—」（无下钻）。
              原实现与格2「未完成待办」都跳 /todo -> 两格点下去同一页，用户会以为点错。
              /todo 不读 query 参数（筛选是页内 state），故「?filter=all」方案无效 -> 采用设计稿原意：本格不可点。 */}
          <section className={styles.card + " " + styles.s8 + " " + styles.hero + ""}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>今天要看的 6 件事</h2><p className={styles.cardSub}>数据时刻 {fmt(b?.asOf)} · 5 分钟聚合</p></div>
              <span className={styles.tagOk}>只读</span>
            </div>
            <div className={styles.statGrid}>
              <div className={styles.stat}><span className={styles.statK}>会话流入 · 30m</span><span className={styles.statVXl + " " + styles.na}>n/a</span><span className={styles.statD}>无 30 分钟流入口径（不写 0）</span></div>
              <div className={styles.stat}><span className={styles.statK}>活跃智能体</span><span className={styles.statVXl}>{n(activeAgents) ?? "n/a"}<em className={styles.tiny}> / {n(totalAgents) ?? "n/a"}</em></span><span className={styles.statD}>{activeAgents != null && totalAgents != null ? "在线口径：ACTIVE / 注册" : "不可得"}</span></div>
              <div className={styles.stat}><span className={styles.statK}>待办 · 需人决策</span><span className={styles.statVXl}>{n(todo?.open) ?? "n/a"}<em className={styles.tiny}>（需人决策 n/a）</em></span><span className={styles.statD}>需人决策无字典口径；OPEN 来自只读库</span></div>
              <div className={styles.stat}><span className={styles.statK}>今日成本</span><span className={styles.statVXl + " " + styles.na}>n/a</span><span className={styles.statD}>无单价/成本表（不写 ¥0）</span></div>
            </div>
            <div className={styles.lineSlot}>
              <div className={styles.lineHead}>
                <span className="tiny">会话流入 · 近 30 天（次/日）</span>
                <span className="tiny" data-trend-summary={trendS ? "ok" : "na"} data-trend-state={trendS ? "ok" : "na"}>
                  {trendS
                    ? "合计 " + trendS.reduce((s, x) => s + x.n, 0).toLocaleString("zh-CN") + " 次 · 有数据 " + trendS.length + " 天"
                    : "n/a"}
                </span>
              </div>
              {trendS ? (
                /* 迷你折线：纯 SVG，不引图表库；缺日不补 0（契约：序列只含有数据的日子） */
                <svg className={styles.spark} viewBox="0 0 300 40" preserveAspectRatio="none" role="img" aria-label="会话流入近 30 天折线">
                  <polyline
                    fill="none" stroke="var(--brand)" strokeWidth="1.5"
                    points={trendS.map((x, i) => {
                      const max = Math.max(1, ...trendS.map((y) => y.n));
                      const px = trendS.length === 1 ? 150 : (i / (trendS.length - 1)) * 300;
                      const py = 38 - (x.n / max) * 34;
                      return px.toFixed(1) + "," + py.toFixed(1);
                    }).join(" ")}
                  />
                </svg>
              ) : (
                <div className={styles.stateMini} data-trend-state="na">
                  {trendSReason || "30 天趋势未采集（无只读接口；不伪造曲线）"}
                </div>
              )}
            </div>
            <div className={styles.chips}>
              <span className={styles.chipRo}>待办 ≠ 改进任务</span>
              <span className={styles.chipRo}>看板只读 · 无写控件</span>
              <span className={styles.chipRw}>写操作：before/after + 二次确认 + 审计</span>
            </div>
            <p className={styles.foot}>数据源：六域只读聚合 + 待办统计（只读库）· 最后更新 {fmt(b?.asOf)}</p>
          </section>

          {/* s4 需要人决策 */}
          <section role="link" tabIndex={0} aria-label="整格可点：进入/todo" onClick={() => router.push("/todo")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/todo"); } }} className={styles.card + " " + styles.s4 + ""}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>需要人决策</h2><p className={styles.cardSub}>需人决策口径 n/a（无字典口径）· 未完成 {n(todo?.open) ?? "n/a"} 项</p></div>
              <Link className={styles.more} href="/todo">待办看板 →</Link>
            </div>
            {decisions.length ? (
              <ul className={styles.list}>
                {decisions.map((t, i) => (
                  <li key={t.id || i}>
                    <span className={styles.dot + " " + (String(t.priority || "").toUpperCase() === "P0" ? styles.dotCrit : styles.dotWarn)} />
                    <div className={styles.liMain}><span className={styles.liTitle}>{short(t.title || t.id, 34)}</span><span className={styles.liMeta}>{t.id || "—"} · {t.ownerId || t.ownerType || "—"}</span></div>
                    <span className={styles.liRight}>{t.dueAt ? fmt(String(t.dueAt)) : "—"}</span>
                  </li>
                ))}
              </ul>
            ) : <div className={styles.stateMini}>{todoNote || "无可展示的人决策待办（需人决策无字典口径）"}</div>}
            <p className={styles.foot}>来自会话中创建的任务；需人决策口径 n/a</p>
          </section>

          {/* D-05-05 格③ 活跃智能体 span4 */}
          <section role="link" tabIndex={0} aria-label="整格可点：进入/agents" onClick={() => router.push("/agents")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/agents"); } }} className={styles.card + " " + styles.s4 + ""}>
            <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>智能体在线</h2><p className={styles.cardSub}>{n(activeAgents) ?? "n/a"} / {n(totalAgents) ?? "n/a"}</p></div><Link className={styles.more} href="/agents">成员 →</Link></div>
            <div className={styles.matrix} aria-hidden="true">
              {Array.from({ length: NumOrDefault(totalAgents) }).map((_, i) => (<i key={i} className={styles.mdot + " " + (i < onlineDots ? styles.mdotOk : styles.mdotIdle)} />))}
            </div>
            <ul className={styles.kvList}>
              <li><span>在线</span><b>{n(activeAgents) ?? "n/a"}</b></li>
              <li><span>降级 / 离线兜底</span><b className={styles.na}>n/a（无降级口径）</b></li>
              <li><span>异常</span><b className={styles.na}>n/a（无异常源）</b></li>
            </ul>
          </section>

          {/* D-05-05 格④ 实时活动 span4 */}
          <section role="link" tabIndex={0} aria-label="整格可点：进入/sessions" onClick={() => router.push("/sessions")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/sessions"); } }} className={styles.card + " " + styles.s4 + ""}>
            <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>实时活动</h2><p className={styles.cardSub}>近 15 分钟</p></div></div>
            {inbox.length ? (
              <ul className={styles.list}>
                {inbox.slice(0, 4).map((m, i) => (
                  <li key={m.message_id || i}>
                    <span className={styles.dot + " " + (m.delivery_status === "failed" ? styles.dotCrit : styles.dotOk)} />
                    <div className={styles.liMain}><span className={styles.liTitle}>{short(m.text || m.message_id, 38)}</span><span className={styles.liMeta}>来自 {m.from || "—"} · {fmt(m.created_at)}</span></div>
                  </li>
                ))}
              </ul>
            ) : <div className={styles.stateMini}>近 15 分钟无活动（接口返回空）</div>}
          </section>

          {/* s4 认知资产 */}
          <section role="link" tabIndex={0} aria-label="整格可点：进入/cognitive/memory" onClick={() => router.push("/cognitive/memory")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/cognitive/memory"); } }} className={styles.card + " " + styles.s4 + ""}>
            <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>认知资产</h2><p className={styles.cardSub}>总量与 7 日增速</p></div><Link className={styles.more} href="/cognitive/memory">数据 →</Link></div>
            <div className={styles.statGrid2}>
              <div className={styles.stat}><span className={styles.statK}>记忆</span><span className={styles.statV}>{n(b?.data?.memory) ?? "n/a"}</span><span className={styles.statD + " " + styles.na}>增速 n/a</span></div>
              <div className={styles.stat}><span className={styles.statK}>知识</span><span className={styles.statV}>{n(b?.data?.knowledge) ?? "n/a"}</span><span className={styles.statD + " " + styles.na}>增速 n/a</span></div>
              {/* 0.6.4 U-56b 板①-5（设计 04:17 恒等式裁定）：practice 必须显示——5 项和=total；4 项和=total-1 */}
              <div className={styles.stat}><span className={styles.statK}>实践</span><span className={styles.statV}>{n(b?.data?.practice) ?? "n/a"}</span><span className={styles.statD + " " + styles.na}>增速 n/a</span></div>
              <div className={styles.stat}><span className={styles.statK}>反思</span><span className={styles.statV}>{n(b?.data?.reflection) ?? "n/a"}</span><span className={styles.statD + " " + styles.na}>增速 n/a</span></div>
              <div className={styles.stat}><span className={styles.statK}>技能</span><span className={styles.statV}>{n(b?.data?.skill) ?? "n/a"}</span><span className={styles.statD + " " + styles.na}>增速 n/a</span></div>
            </div>
          </section>

          {/* D-05-05 格⑥ 成本 span12 */}
          {/* 0.6.4 U-56b 板①-6（设计 06:25 差异②）：设计稿下钻为 /cost；原实现跳 /system/health。
              /cost 页存在且 200 -> 按设计稿改回 /cost。 */}
          <section role="link" tabIndex={0} aria-label="整格可点：进入/cost" onClick={() => router.push("/cost")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/cost"); } }} className={styles.card + " " + styles.s4 + ""} data-metric-value="na" data-false-zero-guard="cost">
            <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>成本与用量</h2><p className={styles.cardSub}>本月预算 n/a</p></div><Link className={styles.more} href="/cost">成本明细 →</Link></div>
            <div className={styles.stat}><span className={styles.statVXl + " " + styles.na}>n/a</span><span className={styles.statD}>无成本/预算口径（不写 ¥0）</span></div>
            <div className={styles.meterLine}><span className="tiny">预算消耗</span><span className={styles.meter}><i style={{ width: "0%" }} /></span><span className="tiny">n/a</span></div>
          </section>

          {/* s8 最近会话（Q1 差异：设计有 s8 table，原实现整格缺失；数据源 = 会话列表只读接口，原已取数未渲染） */}
          <section className={styles.card + " " + styles.s8 + ""}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>最近会话</h2><p className={styles.cardSub}>按最近活动倒序 · 取前 6 条</p></div>
              <Link className={styles.more} href="/sessions">会话列表 →</Link>
            </div>
            {recentSessions.length ? (
              <div className={styles.tblWrap} data-table="recent-sessions">
                <table className={styles.tbl}>
                  <thead><tr><th>会话</th><th>智能体</th><th>消息数</th><th>最近活动</th></tr></thead>
                  <tbody>
                    {recentSessions.map((s, i) => (
                      <tr key={s.id || i}>
                        <td><span className={styles.name}>{short(s.title || s.id, 26)}</span><div className={styles.tiny}>{short(s.id, 44) || "—"}</div></td>
                        <td>{s.agent_id || "—"}</td>
                        <td>{n(s.message_count) ?? "n/a"}</td>
                        <td>{fmt(s.last_message_at || s.updated_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className={styles.stateMini}>最近会话未取到（会话列表未返回；不写 0、不造样例）</div>}
            <p className={styles.foot}>数据源：会话列表只读查询 · 按最近活动倒序</p>
          </section>
        </div>
      )}
    </main>
  );
}

function NumOrDefault(v: number | null): number {
  return typeof v === "number" && v > 0 ? Math.min(v, 24) : 11;
}