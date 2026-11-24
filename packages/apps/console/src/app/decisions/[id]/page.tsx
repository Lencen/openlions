"use client";
/**
 * /decisions/[id] —— 决策详情（0.6.3 U-19，frontend 只读）
 *
 * 展示：决策元信息 + 8 维分析（DecisionAnalysis8D）+ 落地追踪（DecisionOutcome）
 * 口径：后端未就绪 -> 503 -> unavailable + 原因；失败不等于「没有分析」，不编数据
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui";
import { t } from "@/i18n";
import styles from "../page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";
interface Decision { id?: string; title?: string; status?: string; priority?: string; decidedBy?: string | null; decidedAt?: string | null; reason?: string | null; createdAt?: string | null }
interface Dim { id?: string; dimension?: string; content?: string; createdAt?: string | null }
interface Track { id?: string; action?: string; owner?: string; dueAt?: string | null; doneAt?: string | null; status?: string }
function statusLabel(status?: string | null): string {
  switch (status) {
    case "pending": return t("decisions.status.pending");
    case "decided": return t("decisions.status.decided");
    case "executing": return t("decisions.status.executing");
    case "done": return t("decisions.status.done");
    case "rejected": return t("decisions.status.rejected");
    default: return t("decisions.status.unknown", { status: status || "n/a" });
  }
}
function trackLabel(status?: string | null): string {
  switch (status) {
    case "todo": return t("decisions.track.todo");
    case "doing": return t("decisions.track.doing");
    case "done": return t("decisions.track.done");
    case "blocked": return t("decisions.track.blocked");
    default: return t("decisions.track.unknown", { status: status || "n/a" });
  }
}
const fmt = (v?: string | null) => { if (!v) return "n/a"; const d = new Date(v); return Number.isNaN(d.getTime()) ? "n/a" : d.toLocaleString("zh-CN", { hour12: false }); };

export default function DecisionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id || "";
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [d, setD] = useState<Decision | null>(null);
  const [dims, setDims] = useState<Dim[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setPhase("loading"); setErr("");
    // 2b：?state=error|forbidden|unavailable|empty 强制复现（判据可复跑）
    const forced = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("state") : null;
    if (forced === "error" || forced === "forbidden" || forced === "unavailable" || forced === "empty") {
      setErr("（复现模式：?state=" + forced + "）");
      setPhase(forced as Phase);
      return;
    }
    (async () => {
      try {
        const r = await fetch("/api/decisions/detail?id=" + encodeURIComponent(id), { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        const j = await r.json().catch(() => null);
        if (r.status === 503) { setErr((j && (j.reason || j.error)) || "决策库未接入"); setPhase("unavailable"); return; }
        if (r.status === 404) { setErr((j && (j.reason || j.error)) || "决策不存在"); setPhase("error"); return; }
        if (!r.ok) { setErr((j && (j.reason || j.error)) || ("接口 " + r.status)); setPhase("error"); return; }
        if (!j?.ok || !j.decision) { setErr("返回格式不符（缺 decision）"); setPhase("error"); return; }
        setD(j.decision);
        setDims(Array.isArray(j.dims) ? j.dims : []);
        setTracks(Array.isArray(j.tracks) ? j.tracks : []);
        setPhase("ok");
      } catch { if (alive) { setErr("请求失败（网络/服务不可用）"); setPhase("error"); } }
    })();
    return () => { alive = false; };
  }, [id, nonce]);

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>决策详情</PageTitle>
        <div className="page-subtitle">决策事项 + 8 维分析 + 落地追踪（只读）</div>
      </PageHeader>
      <p className={styles.back}><Link href="/decisions">← 返回决策列表</Link></p>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假数据）</div>}
      {phase === "forbidden" && <div className={styles.state}><b>无权限</b><p>当前账号没有查看该决策的权限（401/403）。</p></div>}
      {phase === "unavailable" && (
        <div className={styles.state}>
          <b>决策库未接入</b>
          <p>{err || "决策库不可用（不等于此决策没有分析）"}；数据线就绪后本页自动可用。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b>
          <p>{err}；失败不等于「决策不存在」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && d && (
        <>
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>{d.title || d.id || "n/a"}</h2>
            <dl className={styles.kv}>
              <div><dt>状态</dt><dd>{statusLabel(d.status)}</dd></div>
              <div><dt>优先级</dt><dd data-pri={d.priority || ""} className={styles.pri}>{d.priority || "n/a"}</dd></div>
              <div><dt>决策人</dt><dd>{d.decidedBy || "n/a"}</dd></div>
              <div><dt>决策时刻</dt><dd>{fmt(d.decidedAt)}</dd></div>
              <div><dt>创建时刻</dt><dd>{fmt(d.createdAt)}</dd></div>
              <div><dt>决策理由</dt><dd>{d.reason || "n/a"}</dd></div>
            </dl>
          </section>

          <section className={styles.card}>
            <h2 className={styles.cardTitle}>8 维分析 <span className={styles.badge}>{dims.length} 条</span></h2>
            {dims.length === 0 ? (
              <div className={styles.stateMini}>n/a（决策库未返回 8 维分析；不编造分析内容）。</div>
            ) : (
              <ul className={styles.dims}>
                {dims.map((x, i) => (
                  <li key={x.id || i}><b>{x.dimension || "n/a"}</b><p>{x.content || "n/a"}</p></li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.card}>
            <h2 className={styles.cardTitle}>落地追踪 <span className={styles.badge}>{tracks.length} 条</span></h2>
            {tracks.length === 0 ? (
              <div className={styles.stateMini}>n/a（决策库未返回落地追踪；不编造进度）。</div>
            ) : (
              <table className={styles.tbl}>
                <thead><tr><th>动作</th><th>责任线</th><th>状态</th><th>截止</th><th>完成</th></tr></thead>
                <tbody>
                  {tracks.map((t, i) => (
                    <tr key={t.id || i}>
                      <td>{t.action || "n/a"}</td>
                      <td>{t.owner || "n/a"}</td>
                      <td>{trackLabel(t.status)}</td>
                      <td>{fmt(t.dueAt)}</td>
                      <td>{fmt(t.doneAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </main>
  );
}