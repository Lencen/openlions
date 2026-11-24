"use client";

// /agents/groups — 0.5 D1 页壳 · demo slot 还原（2026-11-13）
// slots：toolbar 4 filter + hint → note(info) → 4 stat → s12 小组 table（8 列）
// 数据卡 card-agents-groups：小组数 1 / 成员 0 / 零成员 1 + Agent 注册 11（mind 口径）；跨部门/周期无口径 → n/a。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import PageSearch from "@/components/ui/PageSearch";
import styles from "./page.module.css";

interface Group { id?: string; name?: string; status?: string; manual?: boolean; conditions?: Record<string, unknown>; members?: unknown[]; ownerAgentId?: string | null; }
interface Org { ok?: boolean; groups?: Group[]; }
interface Board { agents?: { total?: number | null }; }

const condText = (g: Group) => { const c = g.conditions || {}; const k = Object.keys(c); return k.length ? k.map((x) => x + "=" + String((c as any)[x])).join("·") : (g.manual ? "手动" : "—"); };

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [agentsTotal, setAgentsTotal] = useState<number | null>(null);
  const [phase, setPhase] = useState<"loading" | "ok" | "error" | "forbidden" | "unavailable">("loading");
  const [err, setErr] = useState("");
  const [asOf, setAsOf] = useState<string>("");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true; setPhase("loading"); setErr("");
    (async () => {
      try {
        const [or, br] = await Promise.all([
          fetch("/api/org", { cache: "no-store" }),
          fetch("/api/board-overview", { cache: "no-store" }).catch(() => null),
        ]);
        if (!alive) return;
        if (or.status === 401 || or.status === 403) { setPhase("forbidden"); return; }
        if (!or.ok) { setErr("组织接口 " + or.status); setPhase("error"); return; }
        const oj: Org = await or.json();
        if (!alive) return;
        if (oj.ok !== true) { setErr("组织数据不可得"); setPhase("unavailable"); return; }
        setGroups(Array.isArray(oj.groups) ? oj.groups : []);
        setAsOf(new Date().toISOString());
        if (br && br.ok) { const bj: Board = await br.json().catch(() => null); if (alive && bj) setAgentsTotal(bj.agents?.total ?? null); }
        if (alive) setPhase("ok");
      } catch { if (alive) { setErr("请求失败"); setPhase("error"); } }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const memberSum = groups.reduce((s, g) => s + (Array.isArray(g.members) ? g.members.length : 0), 0);
  const zeroMember = groups.filter((g) => !Array.isArray(g.members) || g.members.length === 0).length;

  const [q, setQ] = useState("");

  return (
    <main className="page">
      <PageHeader><PageTitle>小组</PageTitle><div className="page-subtitle">跨部门自定义组只读总览；部门视图见组织架构。</div></PageHeader>
      <PageSearch value={q} onChange={setQ} placeholder="搜索小组…" />
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>成员</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>

      <div className={styles.toolbar} role="group" aria-label="小组筛选">
        {[["全部", "n/a"], ["进行中", "n/a"], ["已完成", "n/a"], ["跨部门", "n/a"]].map(([k, v]) => (
          <button key={k} type="button" className={styles.filter + " " + styles.filterOn}>{k}<span className={styles.badge}>{v}</span></button>
        ))}
        <span className={styles.hint}>只读 · 组建/改组在会话里发起</span>
      </div>
      <div className={styles.note}>小组 ≠ 部门：部门在 <Link href="/agents/org">组织架构</Link>（一个执行体只归属一个）；小组是跨部门自定义组。</div>

      {phase === "loading" && <div className={styles.state}>加载中…</div>}
      {phase === "forbidden" && <div className={styles.state}><b>无权限</b><p>当前账号没有查看小组的权限（401/403）。</p></div>}
      {phase === "unavailable" && <div className={styles.state}><b>小组数据不可得</b><p>{err || "组织接口不可用"}</p><button className="btn" onClick={reload}>重试</button></div>}
      {phase === "error" && <div className={styles.state}><b>加载失败</b><p>{err}</p><button className="btn" onClick={reload}>重试</button></div>}

      {phase === "ok" && (
        <>
          <div className={styles.stats}>
            <div className={styles.card}><span className={styles.k}>小组数</span><b className={styles.vXl}>{groups.length}</b><span className={styles.d}>AgentGroup 真实</span></div>
            <div className={styles.card}><span className={styles.k}>进行中</span><b className={styles.vXl + " " + styles.na}>n/a</b><span className={styles.d}>字典无周期/状态口径</span></div>
            <div className={styles.card}><span className={styles.k}>成员人次</span><b className={styles.vXl}>{memberSum}</b><span className={styles.d}>零成员 {zeroMember} 个</span></div>
            <div className={styles.card}><span className={styles.k}>执行体注册</span><b className={styles.vXl}>{agentsTotal ?? "n/a"}</b><span className={styles.d}>执行体注册表</span></div>
          </div>

          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>小组</h2><p className={styles.sub}>名称 / 编号 / 类型 / 负责人 / 成员 / 跨部门 / 周期 / 状态</p></div><span className={styles.tagOk}>只读</span></div>
            {groups.length ? (
              <table className={styles.tbl}>
                <thead><tr><th>名称</th><th>编号</th><th>类型</th><th>负责人</th><th>成员</th><th>跨部门</th><th>周期</th><th>状态</th></tr></thead>
                <tbody>
                  {groups.map((g, i) => (
                    <tr key={g.id || i}>
                      <td className={styles.name}>{g.name || "—"}</td>
                      <td className={styles.mono}>{g.id || "—"}</td>
                      <td>{condText(g)}</td>
                      <td className={styles.na}>{g.ownerAgentId || "n/a"}</td>
                      <td className="num">{Array.isArray(g.members) ? g.members.length : "n/a"}</td>
                      <td className={styles.na}>n/a（无口径）</td>
                      <td className={styles.na}>n/a（无字段）</td>
                      <td><span className={styles.tagPlain}>{g.status || "—"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className={styles.stateMini}>暂无小组（组织接口正常返回空集）。</div>}
          </section>
          <p className={styles.foot}>数据时刻：{asOf ? new Date(asOf).toLocaleString("zh-CN", { hour12: false }) : "不可得"} · 来源：组织接口（只读）</p>
        </>
      )}
    </main>
  );
}