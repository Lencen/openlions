"use client";

// /flywheel/hard-metrics — 0.5 批F · demo slot 还原（2026-11-13）
// slots：s12｜（KPI/摘要）4 项 · s12｜硬指标（表格）
// 取数（既有只读端点）：/api/hard-metrics
// 口径纪律（数据卡 card-flywheel-hard-metrics）：
//   · 4 个指标字典无条目（G-1）→ n/a + 原因；
//   · 数据文件过期（at 早于 24h，G-4）→ 整页 unavailable，旧值不上屏（本页当前正是该状态）；
//   · 触底阈值无出处（G-3）→ 标「未签口径」。
import { useCallback, useEffect, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable" | "na";

interface Metric { type?: string; n7d?: number; done7d?: number; failed7d?: number; doneRate7d?: number; autonomy7d?: number; themes7d?: number; prevDoneRate?: number; delta?: number; breached?: boolean; }
interface Hard { ok?: boolean; at?: string; dropThreshold?: number; minN?: number; metrics?: Metric[]; source?: string; error?: string; hint?: string; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const PCT = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? (v * 100).toFixed(1) + "%" : "n/a");
const T = (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "n/a");

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className={styles.card}>
      <span className={styles.k}>{label}</span>
      <b className={styles.vXl + " " + styles.na}>{value}</b>
      <span className={styles.d}>{hint}</span>
    </div>
  );
}

export default function HardMetricsPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [data, setData] = useState<Hard | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr("");
    (async () => {
      try {
        const r = await fetch("/api/hard-metrics?_n=" + nonce, { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        const txt = await r.text().catch(() => "");
        if (FORBIDDEN_RE.test(txt)) { setPhase("forbidden"); return; }
        if (!r.ok) { setErr("硬指标接口读取失败（状态码 " + r.status + "）"); setPhase("error"); return; }
        let j: Hard;
        try { j = JSON.parse(txt); } catch { setErr("硬指标接口返回非 JSON"); setPhase("error"); return; }
        // AGENTS 12：ok=false（接口明确说取不到）与 HTTP/解析失败必须分开渲染 —— 前者是「不可得」，
        // 后者是「加载失败」。混成一个「加载失败」会让用户以为系统坏了（2026-11-19 空态维 FAIL② 的实际形态）。
        if (j.ok !== true) {
          setErr((j.error || "接口未返回 ok 标志") + (j.hint ? "；" + j.hint : ""));
          setPhase(j.ok === false ? "na" : "error");
          return;
        }
        setData(j);
        const ageH = j.at ? (Date.now() - new Date(j.at).getTime()) / 3600000 : Infinity;
        setPhase(ageH > 24 ? "unavailable" : "ok");
      } catch (e: unknown) {
        if (!alive) return;
        setErr("硬指标请求失败：" + String((e as Error)?.message || e).slice(0, 80));
        setPhase("error");
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const metrics = Array.isArray(data?.metrics) ? data.metrics : [];
  const ageDays = data?.at ? Math.round(((Date.now() - new Date(data.at).getTime()) / 86400000) * 10) / 10 : null;

  return (
    <main className="page" data-slot="flywheel-hard-metrics-page">
      <PageHeader>
        <PageTitle>飞轮硬指标</PageTitle>
        <div className="page-subtitle">同类任务成功率 / 自主完成率 / 跨主题泛化 / 周环比底线；数据过期时整页不可得，旧值不上屏。</div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级" data-slot="flywheel-hard-metrics-breadcrumb"><span>#</span><span>飞轮</span><span>现有</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少硬指标的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「没有硬指标」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "na" && (
        <div className={styles.state}>
          <b>硬指标不可得</b><p>{err}；这是「取不到」，不等于「没有硬指标」——不显示 0，也不上屏旧值。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {(phase === "ok" || phase === "unavailable") && (
        <>
          <div className={styles.kpis}>
            <Kpi label="7 天整体成功率" value="n/a" hint="n/a（原因：字典无「按任务类型的成功率」条目 G-1；且数据时刻已过期 G-4 → 不下结论）" />
            <Kpi label="7 天样本（条）" value="n/a" hint="n/a（原因：字典无条目 G-1；样本来自过期文件，不上屏）" />
            <Kpi label="触底维度（个）" value="n/a" hint="n/a（原因：触底阈值未签口径 G-3；数据过期 G-4）" />
            <Kpi label="周环比" value="n/a" hint="n/a（原因：字典无条目 G-1；数据过期 G-4）" />
          </div>

          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>硬指标</h2><p className={styles.sub}>任务类型 · 样本 / 成功率 / 自主率 / 泛化 / 上周 / 环比 / 触底 · 数据时刻 {T(data?.at)}</p></div>
              <span className={phase === "unavailable" ? styles.tagNa : styles.tagOk}>{phase === "unavailable" ? "数据过期" : "只读"}</span>
            </div>

            {phase === "unavailable" ? (
              <div className={styles.stateMini}>
                n/a（原因：数据时刻 {T(data?.at)}，距今 {ageDays == null ? "n/a" : ageDays + " 天"} —— 超过 24 小时视为过期，旧值不上屏（缺口 G-4）。
                生产路径已修（接口 200 且 ok），但缺新鲜产出与生成器（缺口 G-2）；恢复产出后本表会自动显示。
              </div>
            ) : metrics.length === 0 ? (
              <div className={styles.stateMini}>暂无硬指标数据（接口正常返回空集，数据时刻 {T(data?.at)}）。</div>
            ) : (
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr><th>任务类型</th><th className={styles.num}>样本</th><th className={styles.num}>成功率</th><th className={styles.num}>自主完成率</th><th className={styles.num}>跨主题泛化</th><th className={styles.num}>上周成功率</th><th className={styles.num}>周环比</th><th>触底</th></tr>
                  </thead>
                  <tbody>
                    {metrics.map((m, i) => (
                      <tr key={m.type || i}>
                        <td className={styles.name}>{m.type || "n/a"}</td>
                        <td className={styles.num}>{NUM(m.n7d)}</td>
                        <td className={styles.num}>{PCT(m.doneRate7d)}</td>
                        <td className={styles.num}>{PCT(m.autonomy7d)}</td>
                        <td className={styles.num}>{NUM(m.themes7d)}</td>
                        <td className={styles.num}>{PCT(m.prevDoneRate)}</td>
                        <td className={styles.num}>{PCT(m.delta)}</td>
                        <td>{m.breached ? <span className={styles.tagPlain + " " + styles.toneCrit}>触底</span> : <span className={styles.tagPlain}>未触底</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className={styles.noteBox}>
              <b className={styles.noteTitle}>数据源与口径状态</b>
              <span>数据文件：{data?.source || "n/a"} · 触底阈值 {data?.dropThreshold != null ? "-" + (data.dropThreshold * 100).toFixed(0) + "%" : "n/a"}
                （样本 ≥{data?.minN ?? "n/a"}）—— 阈值只在数据文件里，字典无条目 → 标「未签口径（G-3）」。</span>
            </div>
          </section>

          <footer className={styles.foot}>
            <span>数据时刻：{T(data?.at)}{ageDays != null && ageDays > 1 ? "（STALE，距今 " + ageDays + " 天）" : ""} · 来源：硬指标数据文件（只读）</span>
            <span className={styles.footNote}>口径：4 个指标字典无条目（G-1）→ 指标位 n/a；文件过期（G-4）→ 整页 unavailable、旧值不上屏；触底阈值未签（G-3）；取不到一律 n/a + 原因，不写 0。</span>
          </footer>
        </>
      )}
    </main>
  );
}
