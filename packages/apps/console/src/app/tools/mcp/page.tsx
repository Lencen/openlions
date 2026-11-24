"use client";

// /tools/mcp — 0.5 D1 页壳 · demo slot 还原（2026-11-13）
// slots：toolbar 4 filter → s12 note(warn) → s12 MCP servers table（7 列）
// 数据卡 card-tools-mcp：注册 7/可用 6 真实；能力数/心跳/延迟无列无探测 → n/a（G-02/G-03）。
import { useCallback, useEffect, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui";
import PageSearch from "@/components/ui/PageSearch";
import styles from "./page.module.css";

interface Sum { ok?: boolean; total?: number; active?: number; deprecated?: number; asOf?: string; }
interface Svc { name?: string; display_name?: string; endpoint?: string; version?: string; status?: string; }

const host = (u?: string) => { if (!u) return "—"; try { return new URL(u).host; } catch { return u; } };

export default function McpPage() {
  const [sum, setSum] = useState<Sum | null>(null);
  const [rows, setRows] = useState<Svc[]>([]);
  const [phase, setPhase] = useState<"loading" | "ok" | "error" | "forbidden" | "unavailable">("loading");
  const [err, setErr] = useState("");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true; setPhase("loading"); setErr("");
    (async () => {
      try {
        const r = await fetch("/api/mcp-summary", { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) { setErr("服务统计接口 " + r.status); setPhase("error"); return; }
        const j: Sum = await r.json();
        if (!alive) return;
        if (j.ok !== true) { setErr("服务统计不可得"); setPhase("unavailable"); return; }
        setSum(j);
        const sr = await fetch("/api/agent-services", { cache: "no-store" }).catch(() => null);
        if (sr && sr.ok) { const l = await sr.json().catch(() => []); if (alive) setRows(Array.isArray(l) ? l : []); }
        if (alive) setPhase("ok");
      } catch { if (alive) { setErr("服务请求失败"); setPhase("error"); } }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const [q, setQ] = useState("");

  return (
    <main className="page" data-slot="tools-mcp-page">
      <PageHeader><PageTitle>MCP servers</PageTitle><div className="page-subtitle">服务注册表只读总览；能力数/心跳/延迟无口径处 n/a。</div></PageHeader>
      <PageSearch value={q} onChange={setQ} placeholder="搜索外部服务…" />
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>工具箱</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>

      <div className={styles.toolbar} role="group" aria-label="服务筛选">
        {[["全部", "n/a"], ["已连接", "n/a"], ["心跳超时", "n/a"], ["连接失败", "n/a"]].map(([k, v]) => (
          <button key={k} type="button" className={styles.filter + " " + styles.filterOn}>{k}<span className={styles.badge}>{v}</span></button>
        ))}
        <span className={styles.hint}>只读视图 · 连接配置在平台侧</span>
      </div>

      {phase === "loading" && <div className={styles.state}>加载中…</div>}
      {phase === "forbidden" && <div className={styles.state}><b>无权限</b><p>当前账号没有查看工具服务的权限（401/403）。</p></div>}
      {phase === "unavailable" && <div className={styles.state}><b>服务数据不可得</b><p>{err || "只读库不可用"}</p><button className="btn" onClick={reload}>重试</button></div>}
      {phase === "error" && <div className={styles.state}><b>加载失败</b><p>{err}</p><button className="btn" onClick={reload}>重试</button></div>}

      {phase === "ok" && sum && (
        <>
          <div className={styles.summary} data-slot="tools-mcp-summary">
            <div className={styles.card}><span className={styles.k}>服务注册数</span><b className={styles.vXl}>{sum.total ?? "n/a"}</b><span className={styles.d}>含可用 {sum.active ?? "n/a"} + 未启用 {sum.deprecated ?? "n/a"}</span></div>
            <div className={styles.card}><span className={styles.k}>可用服务数</span><b className={styles.vXl + " " + styles.ok}>{sum.active ?? "n/a"}</b><span className={styles.d}>status=ACTIVE</span></div>
            <div className={styles.card}><span className={styles.k}>能力数</span><b className={styles.vXl + " " + styles.na}>n/a</b><span className={styles.d}>G-02：tools/list 通道不可用</span></div>
            <div className={styles.card}><span className={styles.k}>心跳/延迟</span><b className={styles.vXl + " " + styles.na}>n/a</b><span className={styles.d}>G-03：无 latency/lastCheck 列</span></div>
          </div>

          <div className={styles.noteWarn}>心跳缺失 = 未连接：工具服务健康不只看端口，还要看能力清单是否 60s 内返回（当前该通道不可用 → n/a，不写 0）。</div>

          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>工具服务</h2><p className={styles.sub}>编号 / 服务 / 传输 / 能力数 / 状态 / 心跳 / 责任线</p></div><span className={styles.tagOk}>只读</span></div>
            {rows.length ? (
              <table className={styles.tbl}>
                <thead><tr><th>编号</th><th>服务</th><th>传输</th><th>能力数</th><th>状态</th><th>最近心跳</th><th>责任线</th></tr></thead>
                <tbody>
                  {rows.map((s2, i) => (
                    <tr key={i}>
                      <td className={styles.mono}>{s2.name || "—"}</td>
                      <td className={styles.name}>{s2.display_name || s2.name || "—"}</td>
                      <td className={styles.na}>n/a</td>
                      <td className={styles.na}>n/a</td>
                      <td><span className={styles.tagPlain}>{s2.status || "—"}</span></td>
                      <td className={styles.na}>n/a</td>
                      <td>{host(s2.endpoint)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className={styles.stateMini}>服务目录暂无可展示记录（注册数见上方；不写 0）。</div>}
            <p className={styles.foot}>数据时刻：{sum.asOf ? new Date(sum.asOf).toLocaleString("zh-CN", { hour12: false }) : "不可得"} · 来源：服务统计（只读）</p>
          </section>
        </>
      )}
    </main>
  );
}