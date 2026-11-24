"use client";

// /agents — 0.5 批次A · demo slot 还原（2026-11-13）
// 槽位顺序：页头 + 4 chips → 工具栏（搜索 / 清单·实时 视图切换 / 状态筛选）→ s12 智能体清单表（8 列）
//   → s12 口径说明 → 逐源数据时刻。
// 取数：/api/agent-list（智能体合并清单）+ /api/agents-live（运行态）+ /api/session-stats（按智能体会话数），均只读。
// 缺字段列（成功率 / 近 7 天 / 本月成本）保留列头、单元格 n/a + 原因，不折算、不写 0。
// 四态：loading / empty / error / forbidden(401/403) / unavailable（响应缺数据行）。

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
// 0.6.1 U-39：13 个二级入口下沉到父页「功能入口」带（侧栏不再有二级菜单）
import FeatureEntries from "@/components/FeatureEntries";
import { NAV_GROUPS } from "@/config/nav";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface Agent {
  agent_id: string;
  display_name?: string | null;
  channel?: string | null;
  host?: string | null;
  status?: string | null;
  macsStatus?: string | null;
  source?: string | null;
  last_seen_at?: string | null;
}
interface AgentListPayload {
  asOf?: string;
  items?: Agent[];
  result?: { data?: Agent[] };
  sources?: { mind?: number; macs?: number; merged?: number };
}
interface LiveAgent {
  agentId: string;
  state?: string;
  stateLabel?: string;
  macsMessages24h?: number;
  lastSeenAt?: number | null;
}
interface LivePayload { asOf?: string; agents?: LiveAgent[]; summary?: { total?: number; online?: number; idle?: number; stuck?: number; offline?: number } }
interface StatsPayload { result?: { data?: { byAgent?: Array<{ agent_id: string; count: number }> } }; asOf?: string }

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";
type SortKey = "name" | "channel" | "host" | "state" | "sessions";
type Tone = "ok" | "warn" | "crit" | "idle" | "info";

interface StateMeta { text: string; tone: Tone }
const STATE_META: Record<string, StateMeta> = {
  online: { text: "在线", tone: "ok" },
  busy: { text: "忙碌", tone: "warn" },
  idle: { text: "空闲", tone: "ok" },
  stuck: { text: "疑似卡住", tone: "crit" },
  offline: { text: "离线", tone: "idle" },
  executor: { text: "执行体", tone: "info" },
};
const FILTERS = [
  { key: "ALL", label: "全部" },
  { key: "online", label: "在线" },
  { key: "stuck", label: "异常" },
  { key: "offline", label: "离线" },
  { key: "executor", label: "执行体" },
] as const;

function chipClass(tone: Tone): string {
  if (tone === "ok") return styles.chipOk;
  if (tone === "warn") return styles.chipWarn;
  if (tone === "crit") return styles.chipCrit;
  if (tone === "info") return styles.chipInfo;
  return styles.chipIdle;
}
function fmtShort(v?: string | number | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return mm + "-" + dd + " " + hh + ":" + mi;
}

export default function AgentsPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [live, setLive] = useState<Record<string, LiveAgent>>({});
  const [liveOk, setLiveOk] = useState(false);
  const [sessionCounts, setSessionCounts] = useState<Record<string, number> | null>(null);
  const [listAsOf, setListAsOf] = useState("");
  const [liveAsOf, setLiveAsOf] = useState("");
  const [statsAsOf, setStatsAsOf] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const [ar, lr, sr] = await Promise.all([
        fetch("/api/agent-list", { cache: "no-store" }),
        fetch("/api/agents-live", { cache: "no-store" }).catch(() => null),
        fetch("/api/session-stats", { cache: "no-store" }).catch(() => null),
      ]);
      if (ar.status === 401 || ar.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!ar.ok) {
        setErr("智能体清单读取接口返回状态码 " + ar.status);
        setPhase("error");
        return;
      }
      const aj = (await ar.json()) as AgentListPayload | Agent[];
      const rows = Array.isArray(aj) ? aj : Array.isArray(aj.items) ? aj.items : Array.isArray(aj.result && aj.result.data) ? (aj.result as { data: Agent[] }).data : null;
      if (!rows) {
        setErr("智能体清单响应里没有可用的数据行");
        setPhase("unavailable");
        return;
      }
      setAgents(rows);
      setListAsOf(!Array.isArray(aj) && aj.asOf ? aj.asOf : "");
      if (lr && lr.ok) {
        const lj = (await lr.json()) as LivePayload;
        const map: Record<string, LiveAgent> = {};
        for (const a of lj.agents || []) map[a.agentId] = a;
        setLive(map);
        setLiveOk(true);
        setLiveAsOf(lj.asOf || "");
      } else {
        setLive({});
        setLiveOk(false);
        setLiveAsOf("");
      }
      if (sr && sr.ok) {
        const sj = (await sr.json()) as StatsPayload;
        const map: Record<string, number> = {};
        for (const x of (sj.result && sj.result.data && sj.result.data.byAgent) || []) map[x.agent_id] = Number(x.count) || 0;
        setSessionCounts(map);
        setStatsAsOf(sj.asOf || "");
      } else {
        setSessionCounts(null);
        setStatsAsOf("");
      }
      setLastOkAt(new Date().toISOString());
      setPhase("ok");
    } catch {
      setErr("请求失败（网络或响应解析异常）");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const stateOf = useCallback(
    (a: Agent): StateMeta => {
      const l = live[a.agent_id];
      if (liveOk && l && l.state && STATE_META[l.state]) return STATE_META[l.state];
      const s = String(a.macsStatus || a.status || "").toUpperCase();
      if (s === "ACTIVE" || s === "ONLINE") return { text: "在线", tone: "ok" };
      if (s === "INACTIVE" || s === "OFFLINE") return { text: "离线", tone: "idle" };
      return { text: "未知", tone: "idle" };
    },
    [live, liveOk]
  );

  const filterKeyOf = useCallback(
    (a: Agent): string => {
      const t = stateOf(a);
      if (t.text === "执行体") return "executor";
      if (t.tone === "crit") return "stuck";
      if (t.text === "在线" || t.text === "忙碌" || t.text === "空闲") return "online";
      if (t.text === "离线") return "offline";
      return "unknown";
    },
    [stateOf]
  );

  const all = agents || [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: all.length, online: 0, stuck: 0, offline: 0, executor: 0 };
    for (const a of all) {
      const k = filterKeyOf(a);
      if (c[k] !== undefined) c[k] += 1;
    }
    return c;
  }, [all, filterKeyOf]);

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const list = all.filter((a) => {
      if (filter !== "ALL" && filterKeyOf(a) !== filter) return false;
      if (!kw) return true;
      const hay = [a.display_name, a.agent_id, a.channel, a.host, stateOf(a).text].filter(Boolean).join(" ").toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
    const dir = sortDir === "asc" ? 1 : -1;
    const val = (a: Agent): string | number => {
      if (sortKey === "channel") return String(a.channel || "");
      if (sortKey === "host") return String(a.host || "");
      if (sortKey === "state") return stateOf(a).text;
      if (sortKey === "sessions") return sessionCounts ? sessionCounts[a.agent_id] || 0 : -1;
      return String(a.display_name || a.agent_id || "");
    };
    return list.slice().sort((x, y) => {
      const vx = val(x);
      const vy = val(y);
      if (typeof vx === "number" && typeof vy === "number") return (vx - vy) * dir;
      return String(vx).localeCompare(String(vy), "zh") * dir;
    });
  }, [all, filter, filterKeyOf, q, sessionCounts, sortDir, sortKey, stateOf]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };
  const sortMark = (key: SortKey) => (key === sortKey ? (sortDir === "asc" ? " ↑" : " ↓") : "");
  const thButton = (key: SortKey, label: string) => (
    <button type="button" className={styles.thBtn} onClick={() => toggleSort(key)}>
      {label}
      {sortMark(key)}
    </button>
  );

  const loading = phase === "loading";

  return (
    <main className="page" data-slot="agents-page">
      <PageHeader>
        <PageTitle>智能体</PageTitle>
        <div className="page-subtitle">执行主体清单：类型、宿主、运行态与会话量；组织与汇报关系见组织架构。</div>
      </PageHeader>

      {/* 0.6.1 U-39：原侧栏二级入口（5 个）下沉到父页顶部「功能入口」带 */}
      <FeatureEntries
        items={(NAV_GROUPS.find((g) => g.id === "member")?.items.find((i) => i.id === "agents")?.children || []).map((c) => ({
          href: c.href || "#",
          label: c.label,
          icon: c.icon,
          desc: c.desc,
        }))}
      />

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>成员</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.toolbarRow} data-slot="agents-toolbar">
        <input
          className={styles.searchInput}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索名称 / 类型 / 宿主 / 状态"
          aria-label="搜索智能体：名称、类型、宿主、状态"
        />
        <div className={styles.segTabs} role="group" aria-label="智能体视图">
          <span className={styles.segTabOn}>清单</span>
          <Link className={styles.segTab} href="/agents-live">实时 →</Link>
        </div>
        <div className={styles.filters} role="group" aria-label="状态筛选">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filter === f.key ? styles.filterBtnOn : styles.filterBtn}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className={styles.badge}>{agents ? counts[f.key] || 0 : "…"}</span>
            </button>
          ))}
        </div>
        <span className={styles.hint}>排序：{sortKey === "name" ? "名称" : sortKey === "channel" ? "类型" : sortKey === "host" ? "宿主" : sortKey === "state" ? "状态" : "会话数"} {sortDir === "asc" ? "升序" : "降序"} · 只读</span>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>智能体清单</h2>
            <p className={styles.sub}>
              共 {rows.length} / {all.length} 条 · 点表头排序{liveOk ? " · 运行态取自实时接口" : " · 运行态接口不可得，状态取自名册"}
            </p>
          </div>
          <span className={styles.tagOk}>只读</span>
        </div>

        {loading ? (
          <div aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className={styles.skelRow}>
                <span className={styles.skel + " " + styles.skelW1} />
                <span className={styles.skel + " " + styles.skelW2} />
                <span className={styles.skel + " " + styles.skelW3} />
                <span className={styles.skel + " " + styles.skelW4} />
                <span className={styles.skel + " " + styles.skelW5} />
              </div>
            ))}
          </div>
        ) : phase === "forbidden" ? (
          <div className={styles.state}>
            <b className={styles.stateTitle}>无权限</b>
            <p className={styles.stateText}>当前账号缺少「成员」的读权限（接口返回 401/403）。请联系平台管理员开通后刷新本页。</p>
          </div>
        ) : phase === "error" ? (
          <div className={styles.state + " " + styles.stateErr}>
            <b className={styles.stateTitle}>加载失败</b>
            <p className={styles.stateText}>
              {err}。{lastOkAt ? "上次成功：" + fmtTime(lastOkAt) + "。" : "本次尚无成功记录。"}
            </p>
            <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
          </div>
        ) : phase === "unavailable" ? (
          <div className={styles.state}>
            <b className={styles.stateTitle}>智能体数据不可得</b>
            <p className={styles.stateText}>{err || "读取接口可用，但响应里没有可用的数据行。"}</p>
            <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
          </div>
        ) : rows.length === 0 ? (
          <div className={styles.stateMini}>
            {q || filter !== "ALL" ? (
              "没有匹配的智能体：清空搜索或切换状态筛选。"
            ) : (
              <>
                暂无智能体（接口正常返回空集）。
                <Link className={styles.inlineLink} href="/agents/onboard">去接入向导 →</Link>
              </>
            )}
          </div>
        ) : (
          <div className={styles.tblWrap}>
            <table className={styles.tbl}>
              <thead>
                <tr>
                  <th>{thButton("name", "智能体")}</th>
                  <th>{thButton("channel", "类型")}</th>
                  <th>{thButton("host", "宿主")}</th>
                  <th>{thButton("state", "状态")}</th>
                  <th className={styles.num}>{thButton("sessions", "会话数")}</th>
                  <th>成功率</th>
                  <th>近 7 天</th>
                  <th className={styles.num}>本月成本</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const st = stateOf(a);
                  const sc = sessionCounts ? sessionCounts[a.agent_id] : undefined;
                  const href = "/agents/detail?agentId=" + encodeURIComponent(a.agent_id || "");
                  return (
                    <tr key={a.agent_id}>
                      <td>
                        <Link className={styles.nameLink} href={href}>{a.display_name || a.agent_id}</Link>
                        <span className={styles.subCell}>
                          编号 {a.agent_id}
                          {a.source === "macs" ? <span className={styles.srcBadge}>仅协同</span> : null}
                        </span>
                      </td>
                      <td>{a.channel || <span className={styles.naCell}>n/a</span>}</td>
                      <td className={styles.monoCell}>{a.host || "n/a"}</td>
                      <td><span className={chipClass(st.tone)}>{st.text}</span></td>
                      <td className={styles.num}>
                        {sessionCounts ? fmtNum(sc || 0) : <span className={styles.naCell} title="会话统计接口不可得">n/a</span>}
                      </td>
                      <td><span className={styles.naCell} title="按智能体的验收比值口径已备，本页尚未接入">n/a</span></td>
                      <td><span className={styles.naCell} title="无 7 日趋势接口">n/a</span></td>
                      <td className={styles.num}><span className={styles.naCell} title="无单价/成本表">n/a</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className={styles.foot}>
          <DataMoment items={[{ label: "智能体", at: listAsOf }, { label: "运行态", at: liveOk ? liveAsOf : null }, { label: "会话统计", at: statsAsOf }]} />
          {" · 来源：智能体合并清单（只读）"}
        </p>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h2 className={styles.cardTitle}>口径</h2>
            <p className={styles.sub}>智能体 = 执行主体；组织 = 汇报关系与小组，两者分开</p>
          </div>
        </div>
        <p className={styles.noteText}>
          本页是执行主体清单（类型 = 接入通道，宿主 = 运行时，状态 = 运行态），不表示组织归属；部门树与汇报关系在
          <Link className={styles.inlineLink} href="/agents/org">组织架构</Link>，跨部门协作组在
          <Link className={styles.inlineGroup} href="/agents/groups">小组</Link>。
          「成功率」「近 7 天」「本月成本」三列暂无可直接取数的接口或已签口径，按 n/a 显示，不折算、不写 0。
        </p>
      </section>
    </main>
  );
}
