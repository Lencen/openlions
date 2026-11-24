"use client";

// /todo — 0.5 D6-D12 待办看板 · demo slot 还原（2026-11-13）
// slots：toolbar 6 filter（badge）+ note info → 4×s3 列（待处理/进行中/待验证/已完成）→ s12 对照表
// 字典：OPEN/DOING 有口径；待验证/已完成/需人决策无字典条目 → 计数 n/a（列保留）。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle, Pill } from "@/components/ui";
import PageSearch from "@/components/ui/PageSearch";
import styles from "./page.module.css";

interface Stats { ok?: boolean; open?: number; doing?: number; byStatus?: Record<string, number>; asOf?: string; }
interface Todo { id?: string; title?: string; status?: string; priority?: string; ownerType?: string; ownerId?: string | null; dueAt?: string | number; createdAt?: string | number; source?: string; }

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const fmt = (v?: string | number) => { if (v == null) return "—"; const d = new Date(v as any); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }); };

export default function TodoPage({ forcedState = null }: { forcedState?: string | null }) {
  // 2026-11-19 F6/B-01：服务端传入 ?state= 强制态（page.tsx 解析 searchParams）；非法值忽略。
  const FORCED = forcedState === "empty" || forcedState === "error" || forcedState === "unavailable" || forcedState === "forbidden" ? forcedState : null;
  const [stats, setStats] = useState<Stats | null>(null);
  // 2026-11-20（AGENTS 115 单提交）：待办两列各自带**四态**，不再用「rows 为空」表示一切。
  //   旧版：if (or && or.ok) 才算数 —— 请求失败时 rows 保持 []，于是列里渲染「该列暂无任务」，
  //   而真实情况是 OPEN 列 100% 失败（实测 3004：status=OPEN&limit=50 恒 503 invalid_timestamp）。
  //   => 失败被画成了空。四态 = loading / ok / empty / error，且 empty 只在「接口 ok 且 count=0 且 rows 空」时出现。
  type ColState = { phase: "loading" | "ok" | "empty" | "error"; rows: Todo[]; err?: string; detail?: string; at?: string };
  const [openCol, setOpenCol] = useState<ColState>({ phase: "loading", rows: [] });
  const [doingCol, setDoingCol] = useState<ColState>({ phase: "loading", rows: [] });
  const [phase, setPhase] = useState<"loading" | "ok" | "error" | "forbidden" | "unavailable" | "empty">(FORCED ?? "loading");
  const [err, setErr] = useState(FORCED ? "（复现模式：?state=" + FORCED + "）" : "");
  const [active, setActive] = useState("全部");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    // 2026-11-19 F6/B-01：?state= 已提到服务端（page.tsx -> forcedState），SSR 首屏即强制态。
    //   强制态下不取数、不改态（保证「看到的 = URL 要求的」）。
    if (FORCED) return;
    let alive = true; setPhase("loading"); setErr("");
    (async () => {
      try {
        const [sr, or, dr] = await Promise.all([
          fetch("/api/todo-stats", { cache: "no-store" }),
          fetch("/api/todos?status=OPEN&limit=50", { cache: "no-store" }).catch(() => null),
          fetch("/api/todos?status=DOING&limit=50", { cache: "no-store" }).catch(() => null),
        ]);
        if (!alive) return;
        if (sr.status === 401 || sr.status === 403) { setPhase("forbidden"); return; }
        if (!sr.ok) { setErr("待办统计接口 " + sr.status); setPhase("error"); return; }
        const sj: Stats = await sr.json();
        if (sj.ok !== true) { setErr("待办统计不可得"); setPhase("unavailable"); return; }
        setStats(sj);
        // 逐列判定：HTTP 非 2xx 与 ok:false 都进 error；只有 ok:true 且 count=0 且 rows 空才是 empty。
        const parseCol = async (r: Response | null, label: string): Promise<ColState> => {
          if (!r) return { phase: "error", rows: [], err: label + " 请求未发出（网络层）" };
          let j: any = null;
          try { j = await r.json(); } catch { j = null; }
          if (!r.ok || !j || j.ok === false) {
            return {
              phase: "error", rows: [],
              err: (j?.error ? String(j.error) : label + " 接口返回 " + r.status),
              detail: j?.detail ? String(j.detail) : undefined,
              at: j?.asOf,
            };
          }
          const rows = Array.isArray(j.rows) ? j.rows : [];
          if (rows.length === 0 && Number(j.count ?? 0) === 0) return { phase: "empty", rows: [], at: j?.asOf };
          return { phase: "ok", rows, at: j?.asOf };
        };
        const [oc, dc] = await Promise.all([parseCol(or, "待处理"), parseCol(dr, "进行中")]);
        if (!alive) return;
        setOpenCol(oc); setDoingCol(dc);
        if (alive) setPhase("ok");
      } catch { if (alive) { setErr("待办请求失败"); setPhase("error"); } }
    })();
    return () => { alive = false; };
  }, [nonce, FORCED]);

  const filters = [
    { label: "全部", badge: n((stats?.open ?? 0) + (stats?.doing ?? 0)) },
    { label: "待处理", badge: n(stats?.open) },
    { label: "进行中", badge: n(stats?.doing) },
    { label: "待验证", badge: "n/a" },
    { label: "已完成", badge: "n/a" },
    { label: "需要人决策", badge: "n/a" },
  ];

  // 四态渲染：每个分支只出自己那一句。判据钉的是「互斥」——error 里不得出现「暂无」，empty 里不得出现「读取失败」。
  //   data-col / data-col-state 供判据按列作用域断言（整页断言会被别的列的文案污染）。
  const col = (key: string, title: string, sub: string, st: ColState, tone: "idle" | "info" | "warn" | "ok", naReason?: string) => (
    <section className={styles.card + " " + styles.s3} data-col={key} data-col-state={naReason ? "na" : st.phase}>
      <div className={styles.cardHead}>
        <div><h2 className={styles.cardTitle}>{title}</h2><p className={styles.cardSub}>{sub}</p></div>
        <span className={styles["tag_" + tone]}>{naReason ? "n/a" : st.phase === "error" ? "读取失败" : st.phase === "loading" ? "…" : st.phase === "empty" ? "0 项" : st.rows.length + " 项"}</span>
      </div>
      {naReason ? <div className={styles.stateMini}>{naReason}</div> : st.phase === "loading" ? (
        <div className={styles.stateMini}>读取中…</div>
      ) : st.phase === "error" ? (
        <div className={styles.stateMini} data-state="error">
          <b>读取失败：{st.err || "未知原因"}</b>
          {st.detail ? <span className={styles.rowMeta}>（{st.detail}）</span> : null}
          {st.at ? <span className={styles.rowMeta}> 上次成功时刻 {fmt(st.at)}</span> : null}
        </div>
      ) : st.phase === "empty" ? (
        <div className={styles.stateMini} data-state="empty">该列暂无任务（接口 ok 且计数为 0）</div>
      ) : (
        <ul className={styles.list}>
          {st.rows.slice(0, 6).map((t, i) => (
            <li key={t.id || i}>
              <span className={styles.rowTitle}>{t.title || t.id || "—"}</span>
              <span className={styles.rowMeta}>{(t.priority ? t.priority + " · " : "") + (t.id || "")}</span>
              <span className={styles.rowMeta}>{t.ownerId || t.ownerType || "—"}{t.dueAt ? " · due " + fmt(t.dueAt) : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const [q, setQ] = useState("");

  return (
    <main className="page" data-phase={phase}>
      <PageHeader>
        <PageTitle>待办看板</PageTitle>
        <div className="page-subtitle">平台待办与改进任务（只读视图）：状态 / 优先级 / 责任人 / 截止</div>
        <Pill tone="neutral">只读视图</Pill>
      </PageHeader>
      <PageSearch value={q} onChange={setQ} placeholder="搜索待办…" />

      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>看板</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>
      {phase === "loading" && <div className={styles.state}>加载中…</div>}
      {phase === "forbidden" && <div className={styles.state}><b>无权限</b><p>当前账号没有查看待办看板的权限（401/403）。</p></div>}
      {phase === "unavailable" && <div className={styles.state}><b>待办数据不可得</b><p>{err || "只读统计不可用"}</p><button className="btn" onClick={reload}>重试</button></div>}
      {phase === "empty" && <div className={styles.state}><b>暂无待办</b><p>待办接口正常返回但当前没有任务。</p></div>}
      {phase === "error" && <div className={styles.state}><b>加载失败</b><p>{err}</p><button className="btn" onClick={reload}>重试</button></div>}
      {phase === "ok" && (
        <>
          <div className={styles.toolbar} role="group" aria-label="待办筛选">
            {filters.map((f) => (
              <button key={f.label} type="button" className={styles.filter + (active === f.label ? " " + styles.filterOn : "")} onClick={() => setActive(f.label)} aria-pressed={active === f.label}>
                {f.label}<span className={styles.badge + (f.badge === "n/a" ? " " + styles.na : "")}>{f.badge}</span>
              </button>
            ))}
            <span className={styles.toolHint}>只读视图 · 任务在会话中创建</span>
          </div>
          <div className={styles.note}>待办 = 会话里立的任务；改进任务 = 实践/反思提出 → <Link href="/flywheel/tasks">改进任务</Link> 独立维护，本页不合并。</div>

          <div className={styles.bento}>
            {/* 2026-11-20：副标题原来是裸枚举 OPEN/DOING，被 check-status-vocabulary 判「界面出现裸英文状态值」。
                枚举不丢，它已经在 data-col={key} 上（判据按列作用域取锚点就取它），界面文字一律中文。 */}
            {col("OPEN", "待处理", "只读 · 按状态筛选", openCol, "idle")}
            {col("DOING", "进行中", "只读 · 按状态筛选", doingCol, "info")}
            {col("VERIFY", "待验证", "字典无条目", { phase: "loading", rows: [] }, "warn", "待验证列：字典无状态口径 → 计数 n/a（列保留）")}
            {col("DONE", "已完成", "字典无条目", { phase: "loading", rows: [] }, "ok", "已完成列：字典无计数口径 → n/a（列保留）")}

            <section className={styles.card + " " + styles.s12}>
              <div className={styles.cardHead}><h2 className={styles.cardTitle}>待办 与 改进任务：同页对照，不合并不混源</h2><span className="tiny">对照</span></div>
              <table className={styles.tbl}>
                <thead><tr><th>维度</th><th>待办</th><th>改进任务</th></tr></thead>
                <tbody>
                  <tr><td className={styles.name}>来源</td><td>会话中创建</td><td>实践/反思提出</td></tr>
                  <tr><td className={styles.name}>生成者</td><td>人 / 智能体 / 线</td><td>飞轮（认知产物）</td></tr>
                  <tr><td className={styles.name}>语义</td><td>要人做的事</td><td>要改的机制/平台</td></tr>
                  <tr><td className={styles.name}>入口</td><td>/todo</td><td>/flywheel/tasks</td></tr>
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </main>
  );
}