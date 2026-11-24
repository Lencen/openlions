"use client";

// /docs — 0.5 D1 页壳 · demo slot 还原（2026-11-13）
// slots：toolbar 4 filter → 4 KPI → s12 文档库 table（7 列）
// 数据卡 card-docs：文档数(md)=部署树真实计数（标树）；索引条目/最近更新= n/a（G-01）；其余 KPI 无口径 → n/a。
import { useCallback, useEffect, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui";
import PageSearch from "@/components/ui/PageSearch";
import styles from "./page.module.css";

interface Sum { ok?: boolean; treeLabel?: string; treeKind?: string; count?: number; asOf?: string; reason?: string; }

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");

export default function DocsPage() {
  const [s, setS] = useState<Sum | null>(null);
  const [phase, setPhase] = useState<"loading" | "ok" | "error" | "forbidden" | "unavailable">("loading");
  const [err, setErr] = useState("");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true; setPhase("loading"); setErr("");
    (async () => {
      try {
        const r = await fetch("/api/docs-summary", { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) { setErr("文档统计接口 " + r.status); setPhase("error"); return; }
        const j: Sum = await r.json();
        if (!alive) return;
        if (j.ok !== true) { setErr(j.reason || "文档统计不可得"); setPhase("unavailable"); return; }
        setS(j); setPhase("ok");
      } catch { if (alive) { setErr("文档统计请求失败"); setPhase("error"); } }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const [q, setQ] = useState("");

  return (
    <main className="page" data-slot="docs-page">
      <PageHeader><PageTitle>文档管理</PageTitle><div className="page-subtitle">文档库规模与索引状态；索引未落地处 n/a。</div></PageHeader>
      <PageSearch value={q} onChange={setQ} placeholder="搜索文档…" />
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>服务</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>

      <div className={styles.toolbar} role="group" aria-label="文档筛选">
        {[["全部", "n/a"], ["已发布", "n/a"], ["待审", "n/a"], ["草稿", "n/a"]].map(([k, v]) => (
          <button key={k} type="button" disabled className={styles.filter + " " + styles.filterOn} title="索引接口未落地（G-01），筛选暂不可用">{k}<span className={styles.badge}>{v}</span></button>
        ))}
        <span className={styles.hint}>只读视图 · 文档创建/发布在仓库侧</span>
      </div>

      {phase === "loading" && <div className={styles.state}>加载中…</div>}
      {phase === "forbidden" && <div className={styles.state}><b>无权限</b><p>当前账号没有查看文档管理的权限（401/403）。</p></div>}
      {phase === "unavailable" && <div className={styles.state}><b>文档数据不可得</b><p>{err || "文档根目录不可读"}</p><button className="btn" onClick={reload}>重试</button></div>}
      {phase === "error" && <div className={styles.state}><b>加载失败</b><p>{err}</p><button className="btn" onClick={reload}>重试</button></div>}

      {phase === "ok" && s && (
        <>
          <div className={styles.kpis}>
            <div className={styles.card}><span className={styles.k}>文档数(md)</span><b className={styles.vXl}>{n(s.count)}</b><span className={styles.d}>{s.treeLabel || "取数树未知"}</span></div>
            <div className={styles.card}><span className={styles.k}>已发布</span><b className={styles.vXl + " " + styles.na}>n/a</b><span className={styles.d}>无发布状态字段（G-01）</span></div>
            <div className={styles.card}><span className={styles.k}>待审</span><b className={styles.vXl + " " + styles.na}>n/a</b><span className={styles.d}>无审核状态字段（G-01）</span></div>
            <div className={styles.card}><span className={styles.k}>公开级</span><b className={styles.vXl + " " + styles.na}>n/a</b><span className={styles.d}>无密级字段（G-01）</span></div>
          </div>

          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}><div><h2 className={styles.cardTitle}>文档库</h2><p className={styles.sub}>编号 / 文档 / 目录 / 密级 / 版本 / 状态 / 更新</p></div><span className={styles.tagOk}>只读</span></div>
            {/* U-27 D-11：原为只有表头的空 table（无数据源）；按「不渲染空表」改为 n/a 说明 */}
            <div className={styles.stateMini}>n/a（文档索引接口未落地 G-01：/api/v1/platform/documentation 为静态平台档，非逐文档列表；不渲染空表、不显示 0 或示例行）。</div>
            <p className={styles.foot}>数据时刻：{s.asOf ? new Date(s.asOf).toLocaleString("zh-CN", { hour12: false }) : "不可得"} · 来源：文档统计（只读）</p>
          </section>
        </>
      )}
    </main>
  );
}