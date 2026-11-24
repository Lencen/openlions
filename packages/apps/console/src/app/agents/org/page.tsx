"use client";

// /agents/org — 0.5 批次C 修复（2026-11-13，设计 批次1 FAIL A1）
// 按 demo 恢复槽位：s4 组织树（可选中）+ s8 选中对象成员列表（表格 + 最近任务 + 最近会话）+ s12 note；KPI 数字并入页头 sub/说明，不占槽。
// 数据：/api/org（部门树/小组/组织内在册）+ /api/agent-list（状态/名册）+ /api/session-stats（按执行体会话数）
//   + /api/todos（最近任务）+ /api/session-list（最近会话），均只读、现有 BFF。
// 数据不足时 s4 树保留骨架、s8 成员区 n/a + 原因，不删槽；成员/任务/会话为空集时才显示空态。
// 本页只读：不提供建部门/加成员/删部门等写入口（写入口在当前闸门下必被 400 拦下）。

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import DataMoment from "@/components/DataMoment";
import { fmtNum, fmtTime } from "@/lib/format";
import styles from "./page.module.css";

interface Dept { id: string; name: string; desc?: string | null; parentId?: string | null; agentCount?: number | null; agents?: string[] | null; children?: Dept[] | null }
interface GroupMember { agentId?: string; roleInGroup?: string | null }
interface Group { id: string; name: string; desc?: string | null; conditions?: Record<string, unknown> | null; manual?: boolean; ownerAgentId?: string | null; status?: string | null; members?: Array<GroupMember | string> | null }
interface OrgAgent { agent_id: string; display_name?: string | null; channel?: string | null; host?: string | null; position?: string | null; role?: string | null; last_seen_at?: number | string | null }
interface OrgPayload { ok?: boolean; departments?: Dept[] | null; groups?: Group[] | null; agents?: OrgAgent[] | null; platformName?: string | null; error?: string }
interface AgentRow { agent_id: string; display_name?: string | null; status?: string | null; macsStatus?: string | null }
interface SessionRow { session_uid: string; agent_id: string; title?: string | null; status?: string | null; updated_at?: string | null }
interface SessionPayload { result?: { data?: { items?: SessionRow[] } }; asOf?: string }
interface StatsPayload { result?: { data?: { byAgent?: Array<{ agent_id: string; count: number }> } }; asOf?: string }
interface TodoRow { id: string; title: string; ownerId?: string | null; status?: string | null; priority?: string | null; dueAt?: string | null }
interface TodosPayload { ok?: boolean; rows?: TodoRow[] }

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";
type Sel = { kind: "all" } | { kind: "dept"; id: string } | { kind: "group"; id: string };

const STATUS_LABEL: Record<string, string> = { DONE: "已完成", OPEN: "待处理", DOING: "进行中", DROPPED: "已丢弃", CANCELLED: "已取消" };
const SESSION_STATUS_LABEL: Record<string, string> = { DONE: "已提炼", PENDING: "待提炼", FAILED: "提炼失败", SKIPPED: "已跳过" };

function parseSel(raw: string | null): Sel {
  if (!raw || raw === "ALL" || raw === "all") return { kind: "all" };
  if (raw.indexOf("dept:") === 0) return { kind: "dept", id: raw.slice(5) };
  if (raw.indexOf("group:") === 0) return { kind: "group", id: raw.slice(6) };
  return { kind: "all" };
}
const selKey = (s: Sel) => (s.kind === "all" ? "ALL" : s.kind + ":" + s.id);

/** 结构化说明（组 desc 实测是 JSON 字符串）→ 只取 note 文本，不渲染原文。 */
function descOf(v?: string | null): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (s.charAt(0) === "{" || s.charAt(0) === "[") {
    try {
      const j = JSON.parse(s);
      if (j && typeof j.note === "string" && j.note.trim()) return j.note;
    } catch { /* 原文不是结构化数据，按原文显示 */ }
    return null;
  }
  return s;
}
function memberIdOf(m: GroupMember | string): string {
  if (typeof m === "string") return m;
  return String((m && m.agentId) || "");
}
function flattenDepts(nodes: Dept[], depth = 0): Array<{ dept: Dept; depth: number }> {
  const out: Array<{ dept: Dept; depth: number }> = [];
  for (const d of nodes) {
    out.push({ dept: d, depth });
    if (Array.isArray(d.children) && d.children.length) out.push(...flattenDepts(d.children, depth + 1));
  }
  return out;
}
function stateOf(a: AgentRow | undefined): { text: string; tone: "ok" | "warn" | "crit" | "idle" } {
  const s = String((a && (a.macsStatus || a.status)) || "").toUpperCase();
  if (s === "ACTIVE" || s === "ONLINE") return { text: "在线", tone: "ok" };
  if (s === "OFFLINE") return { text: "离线", tone: "idle" };
  if (s === "INACTIVE") return { text: "停用", tone: "warn" };
  return { text: "未知", tone: "idle" };
}
function chipClass(tone: "ok" | "warn" | "crit" | "idle"): string {
  if (tone === "ok") return styles.chipOk;
  if (tone === "warn") return styles.chipWarn;
  if (tone === "crit") return styles.chipCrit;
  return styles.chipIdle;
}
function shortTime(v?: string | number | null): string {
  if (v === null || v === undefined || v === "") return "n/a";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "n/a";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return mm + "-" + dd + " " + hh + ":" + mi;
}

export default function OrgPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [lastOkAt, setLastOkAt] = useState("");
  const [org, setOrg] = useState<OrgPayload | null>(null);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [agentAsOf, setAgentAsOf] = useState("");
  const [sessionCounts, setSessionCounts] = useState<Record<string, number> | null>(null);
  const [statsAsOf, setStatsAsOf] = useState("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionsAsOf, setSessionsAsOf] = useState("");
  const [todos, setTodos] = useState<TodoRow[] | null>(null);
  const [requestedAt, setRequestedAt] = useState("");
  const [sel, setSel] = useState<Sel>({ kind: "all" });
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setPhase("loading");
    setErr("");
    try {
      const [or, ar, sr, tr, cr] = await Promise.all([
        fetch("/api/org", { cache: "no-store" }),
        fetch("/api/agent-list", { cache: "no-store" }).catch(() => null),
        fetch("/api/session-stats", { cache: "no-store" }).catch(() => null),
        fetch("/api/todos?limit=200", { cache: "no-store" }).catch(() => null),
        fetch("/api/session-list?page=1&pageSize=50", { cache: "no-store" }).catch(() => null),
      ]);
      if (or.status === 401 || or.status === 403) {
        setPhase("forbidden");
        return;
      }
      if (!or.ok) {
        setErr("组织接口返回状态码 " + or.status);
        setPhase("error");
        return;
      }
      const oj = (await or.json()) as OrgPayload;
      if (!oj || oj.ok !== true) {
        setErr((oj && oj.error) || "组织数据不可得");
        setPhase("unavailable");
        return;
      }
      if (!Array.isArray(oj.departments)) {
        setErr("组织响应里没有部门树");
        setPhase("unavailable");
        return;
      }
      setOrg(oj);
      if (ar && ar.ok) {
        const aj = await ar.json();
        setAgents(Array.isArray(aj) ? aj : Array.isArray(aj.items) ? aj.items : null);
        setAgentAsOf((aj && aj.asOf) || "");
      } else {
        setAgents(null);
        setAgentAsOf("");
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
      if (tr && tr.ok) {
        const tj = (await tr.json()) as TodosPayload;
        setTodos(Array.isArray(tj.rows) ? tj.rows : null);
      } else {
        setTodos(null);
      }
      if (cr && cr.ok) {
        const cj = (await cr.json()) as SessionPayload;
        const items = cj && cj.result && cj.result.data && cj.result.data.items;
        setSessions(Array.isArray(items) ? items : []);
        setSessionsAsOf((cj && cj.asOf) || "");
      } else {
        setSessions([]);
        setSessionsAsOf("");
      }
      setRequestedAt(new Date().toISOString());
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

  // 选中项进 URL（?sel=dept:<id> / group:<id> / ALL），可分享、可回退。
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      setSel(parseSel(sp.get("sel")));
    } catch { /* 无 window 时保持默认 */ }
  }, []);

  const pick = (s: Sel) => {
    setSel(s);
    try {
      const sp = new URLSearchParams(window.location.search);
      sp.set("sel", selKey(s));
      const qs = sp.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
    } catch { /* 忽略 */ }
  };

  const depts = useMemo(() => flattenDepts((org && Array.isArray(org.departments) ? org.departments : []) as Dept[]), [org]);
  const groups = useMemo(() => (org && Array.isArray(org.groups) ? org.groups : []), [org]);
  const orgAgents = useMemo(() => (org && Array.isArray(org.agents) ? org.agents : null), [org]);
  const agentMap = useMemo(() => {
    const m: Record<string, OrgAgent> = {};
    for (const a of orgAgents || []) m[a.agent_id] = a;
    return m;
  }, [orgAgents]);
  const statusMap = useMemo(() => {
    const m: Record<string, AgentRow> = {};
    for (const a of agents || []) if (a && a.agent_id) m[a.agent_id] = a;
    return m;
  }, [agents]);

  const selectedDept = sel.kind === "dept" ? (depts.find((x) => x.dept.id === sel.id) || null) : null;
  const selectedGroup = sel.kind === "group" ? (groups.find((g) => g.id === (sel as { kind: "group"; id: string }).id) || null) : null;
  const memberIds = useMemo(() => {
    if (sel.kind === "dept") return selectedDept && Array.isArray(selectedDept.dept.agents) ? selectedDept.dept.agents : [];
    if (sel.kind === "group") return ((selectedGroup && selectedGroup.members) || []).map(memberIdOf).filter(Boolean);
    return (orgAgents || []).map((a) => a.agent_id);
  }, [sel, selectedDept, selectedGroup, orgAgents]);

  const title = sel.kind === "dept" ? (selectedDept ? selectedDept.dept.name : "n/a") : sel.kind === "group" ? (selectedGroup ? selectedGroup.name : "n/a") : "Lions 平台 · 全部成员";
  const subText = sel.kind === "dept" ? "本部门成员 · 点行查看执行体详情" : sel.kind === "group" ? "本小组成员 · 跨部门协作组" : "全部成员 · 点部门/小组切换";
  const desc = sel.kind === "dept" ? descOf(selectedDept && selectedDept.dept.desc) : sel.kind === "group" ? descOf(selectedGroup && selectedGroup.desc) : "按部门汇总的组织内在册执行体；小组是跨部门协作组。";
  const idText = sel.kind === "dept" ? (selectedDept ? selectedDept.dept.id : "n/a") : sel.kind === "group" ? (selectedGroup ? selectedGroup.id : "n/a") : "n/a";
  const typeText = sel.kind === "dept" ? "部门" : sel.kind === "group" ? "小组" : "组织";
  const showGroupCol = sel.kind === "all";

  const members = useMemo(() => {
    if (!orgAgents) return null;
    return memberIds.map((id) => ({ id, agent: agentMap[id], status: statusMap[id] }));
  }, [memberIds, agentMap, statusMap, orgAgents]);

  const memberIdSet = useMemo(() => new Set(memberIds), [memberIds]);
  const recentTasks = useMemo(() => {
    if (!todos) return null;
    return todos.filter((t) => t && memberIdSet.has(String(t.ownerId || ""))).slice(0, 5);
  }, [todos, memberIdSet]);
  const recentSessions = useMemo(() => {
    return (sessions || []).filter((s) => s && memberIdSet.has(String(s.agent_id || ""))).slice(0, 5);
  }, [sessions, memberIdSet]);
  const totalSessions = useMemo(() => {
    if (!sessionCounts) return null;
    let n = 0;
    for (const id of memberIds) n += sessionCounts[id] || 0;
    return n;
  }, [sessionCounts, memberIds]);

  // 在线 = 名册状态「已启用」（ACTIVE）的条数；不与通信服务的 online/offline 值域混算（数据卡 G-01）。
  const activeAgents = useMemo(() => {
    if (!agents) return null;
    return agents.filter((a) => String((a && a.status) || "").toUpperCase() === "ACTIVE").length;
  }, [agents]);
  const rootCount = org && Array.isArray(org.departments) ? org.departments.length : null;
  const loading = phase === "loading";
  const selValid = sel.kind === "all" || !!selectedDept || !!selectedGroup;
  const dataInsufficient = phase === "ok" && (!orgAgents || !selValid);

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>组织架构</PageTitle>
        <div className="page-subtitle">
          部门树与汇报关系 · 注册 {loading ? "…" : agents ? fmtNum(agents.length) : "n/a"} / 在线 {loading ? "…" : typeof activeAgents === "number" ? fmtNum(activeAgents) : "n/a"} / 组织在册 {loading ? "…" : orgAgents ? fmtNum(orgAgents.length) : "n/a"} / 部门 {loading ? "…" : typeof rootCount === "number" ? fmtNum(depts.length) + "（树根 " + fmtNum(rootCount) + "）" : "n/a"}
          <span className={styles.headTip}> · 数字口径见页末说明</span>
        </div>
      </PageHeader>

      <div className={styles.crumbs} aria-label="页面层级">
        <span className={styles.crumbOn}>#</span>
        <span>成员</span>
        <span>列表</span>
        <span className={styles.crumbOn}>只读</span>
      </div>

      <div className={styles.grid}>
        <section className={styles.card + " " + styles.s4}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>组织</h2>
              <p className={styles.sub}>点部门 / 小组切换右侧成员</p>
            </div>
            <span className={styles.tagOk}>只读</span>
          </div>

          {loading ? (
            <div aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className={styles.skelRow}><span className={styles.skel + " " + styles.skelW2} /><span className={styles.skel + " " + styles.skelW1} /></div>
              ))}
            </div>
          ) : phase === "forbidden" ? (
            <div className={styles.state}>
              <b className={styles.stateTitle}>无权限</b>
              <p className={styles.stateText}>当前账号缺少「成员」读权限（接口返回 401/403）。请联系平台管理员开通后刷新。</p>
            </div>
          ) : phase === "error" ? (
            <div className={styles.state + " " + styles.stateErr}>
              <b className={styles.stateTitle}>加载失败</b>
              <p className={styles.stateText}>{err}。{lastOkAt ? "上次成功：" + fmtTime(lastOkAt) + "。" : "本次尚无成功记录。"}</p>
              <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
            </div>
          ) : phase === "unavailable" ? (
            <div className={styles.state}>
              <b className={styles.stateTitle}>组织数据不可得</b>
              <p className={styles.stateText}>{err || "组织接口可用，但响应里没有部门树。"}</p>
              <button type="button" className={styles.btn} onClick={() => setReloadKey((x) => x + 1)}>重试</button>
            </div>
          ) : (
            <>
              <div className={styles.orgHead}>
                <b className={styles.orgName}>{org && org.platformName ? org.platformName : "组织根"}</b>
                <div className={styles.chipRow}>
                  <span className={styles.chip}>组织</span>
                  <span className={styles.chip}>负责人 n/a</span>
                  <span className={styles.chip}>创建时间 n/a</span>
                </div>
                <p className={styles.orgDesc}>根节点按平台名展示；负责人与创建时间不在组织接口返回里，按 n/a 标注。</p>
              </div>

              <button type="button" className={sel.kind === "all" ? styles.orgItemOn : styles.orgItem} onClick={() => pick({ kind: "all" })}>
                <span className={styles.orgItemT}><b>全部成员</b><small>{fmtNum(orgAgents ? orgAgents.length : 0)} 人 · {fmtNum(depts.length)} 个部门 · {fmtNum(groups.length)} 个小组</small></span>
                <span className={styles.orgGo}>{sel.kind === "all" ? "✓" : "›"}</span>
              </button>

              <div className={styles.orgSep}>部门</div>
              {depts.length === 0 ? <div className={styles.stateMini}>暂无部门（接口正常返回空集）。</div> : depts.map(({ dept, depth }) => {
                const on = sel.kind === "dept" && dept.id === (sel as { kind: "dept"; id: string }).id;
                return (
                  <button key={dept.id} type="button" className={on ? styles.orgItemOn : styles.orgItem} data-depth={depth} onClick={() => pick({ kind: "dept", id: dept.id })}>
                    <span className={styles.orgItemT}><b>{dept.name}</b><small>{dept.id} · {fmtNum(Array.isArray(dept.agents) ? dept.agents.length : dept.agentCount || 0)} 个执行体</small></span>
                    <span className={styles.orgGo}>{on ? "✓" : "›"}</span>
                  </button>
                );
              })}

              <div className={styles.orgSep}>小组</div>
              {groups.length === 0 ? <div className={styles.stateMini}>暂无小组（接口正常返回空集）。</div> : groups.map((g) => {
                const on = sel.kind === "group" && g.id === (sel as { kind: "group"; id: string }).id;
                return (
                  <button key={g.id} type="button" className={on ? styles.orgItemOn : styles.orgItem} onClick={() => pick({ kind: "group", id: g.id })}>
                    <span className={styles.orgItemT}><b>{g.name}</b><small>{g.id} · {fmtNum(Array.isArray(g.members) ? g.members.length : 0)} 人</small></span>
                    <span className={styles.orgGo}>{on ? "✓" : "›"}</span>
                  </button>
                );
              })}
            </>
          )}

          <p className={styles.foot}>
            <DataMoment items={[{ label: "组织（请求时刻）", at: requestedAt }, { label: "名册", at: agentAsOf }, { label: "会话统计", at: statsAsOf }]} />
          </p>
        </section>

        <section className={styles.card + " " + styles.s8}>
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle}>{title}</h2>
              <p className={styles.sub}>{subText}</p>
            </div>
            <span className={styles.tagOk}>只读</span>
          </div>

          {loading ? (
            <div aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className={styles.skelRow}><span className={styles.skel + " " + styles.skelW2} /><span className={styles.skel + " " + styles.skelW3} /><span className={styles.skel + " " + styles.skelW1} /></div>
              ))}
            </div>
          ) : phase !== "ok" ? (
            <div className={styles.stateMini}>组织数据不可得，成员区按 n/a 保留（不删槽）；左侧修复后自动恢复。</div>
          ) : dataInsufficient ? (
            <div className={styles.stateMini}>
              {!selValid ? "选中的部门/小组在本次数据里不存在（可能已删除）—— 已保留成员区，请从左侧重新选择。" : "组织接口未下发成员明细（agents 缺失）—— 成员区 n/a，不显示 0 人。"}
            </div>
          ) : (
            <>
              <div className={styles.chipRow}>
                <span className={styles.chip}><span className={styles.mono}>{idText}</span></span>
                <span className={styles.chip}>{typeText}</span>
                <span className={styles.chip}>{fmtNum(memberIds.length)} 个执行体</span>
                <span className={styles.chip}>人数 n/a</span>
              </div>
              <p className={styles.orgDesc}>{desc || "n/a（该对象没有说明字段）"}</p>
              <p className={styles.orgOwner}>负责人 n/a · 创建时间 n/a（组织接口未返回）</p>

              {members && members.length ? (
                <div className={styles.tblWrap}>
                  <table className={styles.tbl}>
                    <thead>
                      <tr>
                        <th>执行体</th>
                        <th>角色</th>
                        <th>状态</th>
                        <th className={styles.num}>会话数</th>
                        <th>成功率</th>
                        <th>近 7 天</th>
                        {showGroupCol ? <th>所属小组</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((m) => {
                        const st = stateOf(m.status);
                        const sc = sessionCounts ? sessionCounts[m.id] : undefined;
                        const groupsOf = groups.filter((g) => ((g.members || []).map(memberIdOf)).indexOf(m.id) >= 0).map((g) => g.name);
                        return (
                          <tr key={m.id}>
                            <td>
                              <Link className={styles.nameLink} href={"/agents/detail?agentId=" + encodeURIComponent(m.id)}>
                                {(m.agent && m.agent.display_name) || m.id}
                              </Link>
                              <span className={styles.subCell}>编号 {m.id}{m.agent && m.agent.channel ? " · " + m.agent.channel : ""}</span>
                            </td>
                            <td>{(m.agent && (m.agent.position || m.agent.role)) || "n/a"}</td>
                            <td><span className={chipClass(st.tone)}>{st.text}</span></td>
                            <td className={styles.num}>{sessionCounts ? fmtNum(sc || 0) : <span className={styles.naCell} title="会话统计接口不可得">n/a</span>}</td>
                            <td><span className={styles.naCell} title="按执行体的验收比值口径已备，本页尚未接入">n/a</span></td>
                            <td><span className={styles.naCell} title="无 7 日趋势接口">n/a</span></td>
                            {showGroupCol ? <td>{groupsOf.length ? groupsOf.join("、") : <span className={styles.naCell}>—</span>}</td> : null}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : orgAgents ? (
                <div className={styles.stateMini}>{sel.kind === "group" ? "本小组暂无执行体成员（接口正常返回空成员）。" : "本部门暂无执行体（接口正常返回空成员）。"}</div>
              ) : null}

              <div className={styles.twoCol}>
                <div>
                  <div className={styles.colHead}>最近任务</div>
                  {todos === null ? (
                    <div className={styles.naBlock}>n/a（待办接口不可得）</div>
                  ) : recentTasks && recentTasks.length ? (
                    recentTasks.map((t) => (
                      <div key={t.id} className={styles.miniRow}>
                        <span className={styles.miniDot} data-state={t.status === "OPEN" ? "warn" : t.status === "DOING" ? "info" : "idle"} />
                        <span className={styles.miniMain}>
                          <span className={styles.miniTitle}>{t.title}</span>
                          <span className={styles.miniMeta}>{t.id} · 负责人 {t.ownerId || "n/a"} · 截止 {t.dueAt ? shortTime(t.dueAt) : "n/a"}</span>
                        </span>
                        <span className={styles.miniRight}>{STATUS_LABEL[String(t.status || "")] || t.status || "n/a"}</span>
                      </div>
                    ))
                  ) : (
                    <div className={styles.naBlock}>本选中范围暂无进行中的任务（按负责人匹配待办）。</div>
                  )}
                </div>
                <div>
                  <div className={styles.colHead}>最近会话</div>
                  {(sessions || []).length === 0 ? (
                    <div className={styles.naBlock}>{sessionsAsOf === "" ? "n/a（会话列表接口不可得）" : "本选中范围暂无最近会话（按执行体匹配最近 50 条）。"}</div>
                  ) : recentSessions.length ? (
                    recentSessions.map((s) => (
                      <Link key={s.session_uid} href={"/sessions/detail?id=" + encodeURIComponent(s.session_uid)} className={styles.miniRowLink}>
                        <span className={styles.miniDot} data-state="ok" />
                        <span className={styles.miniMain}>
                          <span className={styles.miniTitle}>{s.title || s.session_uid}</span>
                          <span className={styles.miniMeta}>{s.session_uid} · 执行体 {s.agent_id} · 更新 {s.updated_at ? shortTime(s.updated_at) : "n/a"}</span>
                        </span>
                        <span className={styles.miniRight}>{SESSION_STATUS_LABEL[String(s.status || "")] || s.status || "n/a"}</span>
                      </Link>
                    ))
                  ) : (
                    <div className={styles.naBlock}>本选中范围暂无最近会话（按执行体匹配最近 50 条）。</div>
                  )}
                </div>
              </div>

              <p className={styles.foot}>
                合计会话 {totalSessions === null ? "n/a（会话统计不可得）" : fmtNum(totalSessions)} · 平均成功率 n/a（口径已备、页面未接入）
                <DataMoment items={[{ label: "会话列表", at: sessionsAsOf }]} />
              </p>
            </>
          )}
        </section>

        <section className={styles.card + " " + styles.s12}>
          <div className={styles.cardHead}>
            <div>
              
              <p className={styles.sub}>组织 / 部门 / 小组 语义与口径</p>
            </div>
          </div>
          <p className={styles.noteText}>
            组织、部门、小组与成员都有详情：组织与部门带编号、简介；成员点行进入执行体详情。
            切换部门或小组会改地址（<code className={styles.code}>?sel=</code>），可直接分享；返回仍回到本页当前选中项。
            部门是汇报关系（一个执行主体只归属一个部门）；小组是跨部门协作组，见 <Link className={styles.inlineLink} href="/agents/groups">小组</Link>；执行体清单见 <Link className={styles.inlineLink} href="/agents">智能体</Link>。
            页头数字口径：注册 = 智能体名册全量（当前 {loading ? "…" : agents ? fmtNum(agents.length) : "n/a"}）；
            在线 = 名册状态已启用（{loading ? "…" : typeof activeAgents === "number" ? fmtNum(activeAgents) : "n/a"}，≠通信服务在线；两套值域不混算）；
            组织在册 = 组织接口在册（{loading ? "…" : orgAgents ? fmtNum(orgAgents.length) : "n/a"}，不等于名册注册数）；
            部门 = 按树展开合计，括号里是树根数。成功率 / 近 7 天 / 负责人 / 创建时间 / 库内数据时刻无源或无口径，按 n/a 显示，不写 0。
            四态：loading（骨架）/ empty（接口正常空集）/ error / forbidden(401/403) / unavailable（数据区缺失）；成员区在数据不足时保留 n/a，不删槽。
            本页只读：建部门 / 加成员 / 删部门不在本页（写入口在当前闸门下会被拒，本批不提供）。
          </p>
        </section>
      </div>
    </main>
  );
}