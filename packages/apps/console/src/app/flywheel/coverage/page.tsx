"use client";

// /flywheel/coverage — 0.5 批F · demo slot 还原（2026-11-13）
// slots：s12｜（KPI/摘要）4 项 · s12｜覆盖率趋势（图表）
// 取数（既有只读端点）：/api/flywheel-stats
// 口径纪律（数据卡 card-flywheel-coverage）：
//   · 主题覆盖率均值 / 主题数 / 结构化发现覆盖率：字典无条目（G-1）→ n/a + 原因，不上屏；
//   · 健康度总分是硬编码常量（G-2）→ 整组 unavailable，禁止显示 93.5；
//   · 覆盖率趋势无时间序列接口 → 该槽 unavailable；发现类别分布/反思成败只作辅助说明（未定口径）。
import { useCallback, useEffect, useState } from "react";
import DataMoment from "@/components/DataMoment";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden" | "unavailable";

interface Stats {
  success?: boolean; asOf?: string;
  data?: {
    coverage?: { avg?: number; total?: number };
    structuredFindings?: { covered?: number; total?: number; rate?: number };
    findings?: { total?: number; byCategory?: Record<string, number>; byStatus?: Record<string, number> };
    reflections?: { total?: number; ok?: number; failed?: number };
    health?: Record<string, number>;
  };
}

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className={styles.card}>
      <span className={styles.k}>{label}</span>
      <b className={styles.vXl + " " + styles.na}>{value}</b>
      <span className={styles.d}>{hint}</span>
    </div>
  );
}

export default function CoveragePage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [srcErr, setSrcErr] = useState("");
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr(""); setSrcErr("");
    (async () => {
      try {
        const r = await fetch("/api/flywheel-stats", { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          if (FORBIDDEN_RE.test(txt)) { setPhase("forbidden"); return; }
          setErr("覆盖率统计读取失败（状态码 " + r.status + "）");
          setPhase("error");
          return;
        }
        const j: Stats = await r.json();
        if (!alive) return;
        if (j.success !== true) { setSrcErr("统计接口未返回 success=true"); setPhase("unavailable"); return; }
        setStats(j);
        setPhase("ok");
      } catch (e: unknown) {
        if (!alive) return;
        setErr("覆盖率统计请求失败：" + String((e as Error)?.message || e).slice(0, 80));
        setPhase("error");
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const d = stats?.data;
  const findings = d?.findings;
  const byCat = findings?.byCategory || {};
  const catEntries = Object.entries(byCat).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8);
  const maxCat = catEntries.reduce((m, [, v]) => Math.max(m, Number(v) || 0), 1);
  const reflections = d?.reflections;

  return (
    <main className="page" data-slot="flywheel-coverage-page">
      <PageHeader>
        <PageTitle>覆盖率</PageTitle>
        <div className="page-subtitle">主题覆盖与结构化发现覆盖：字典无条目的口径一律 n/a；健康度总分无数据源，不上屏；本页只读。</div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级" data-slot="flywheel-coverage-breadcrumb"><span>#</span><span>飞轮</span><span>现有</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "unavailable" && (
        <div className={styles.state}>
          <b>数据不可得</b><p>{srcErr || "统计接口未返回有效数据"}；覆盖率类指标字典无条目（缺口 G-1），不写 0。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少覆盖率的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「没有覆盖率数据」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          <div className={styles.kpis}>
            <Kpi label="主题覆盖率均值" value="n/a" hint="n/a（原因：字典无「主题覆盖率」条目，缺口 G-1；接口原值未定口径，不上屏）" />
            <Kpi label="主题数" value="n/a" hint="n/a（原因：字典无「主题数」条目，缺口 G-1；分母口径未定）" />
            <Kpi label="结构化发现覆盖率" value="n/a" hint="n/a（原因：字典无条目；分母含失败反思（G-3），且分母为 0 时接口会用 0 冒充 → 不上屏）" />
            <Kpi label="健康度总分" value="n/a" hint="n/a（原因：健康度为源码常量、无数据源，缺口 G-2；禁止显示 93.5）" />
          </div>

          <div className={styles.bento}>
            <section className={styles.card + " " + styles.s12}>
              <div className={styles.cardHead}>
                <div><h2 className={styles.cardTitle}>覆盖率趋势</h2><p className={styles.sub}>近 30 天 · 趋势数据无接口（缺口 G-1）→ 该槽不可得；下方为当前分布辅助说明</p></div>
                <span className={styles.tagNa}>不可得</span>
              </div>
              <div className={styles.stateMini}>n/a（原因：接口无覆盖率时间序列，趋势无法计算；不画示例曲线、不写 0）。</div>

              <div className={styles.noteBox}>
                <b className={styles.noteTitle}>辅助说明（当前分布，未定口径，不占指标位）</b>
                {catEntries.length > 0 ? (
                  <ul className={styles.noteList}>
                    {catEntries.map(([k, v]) => (
                      <li key={k}>{k}：{NUM(Number(v))} 条</li>
                    ))}
                  </ul>
                ) : <span>发现类别分布：n/a（接口未返回）</span>}
                <span>结构化发现合计 {NUM(findings?.total)} 条 · 反思成功 {NUM(reflections?.ok)} / 失败 {NUM(reflections?.failed)}（主题反思表口径，辅助对照）。</span>
              </div>
            </section>
          </div>

          <footer className={styles.foot}>
            <DataMoment items={[{ label: "飞轮统计", at: stats?.asOf }]} showPrefix={false} />
            <span className={styles.footNote}>口径：主题覆盖率 / 主题数 / 结构化发现覆盖率字典无条目（G-1）→ 指标位 n/a；健康度总分为常量（G-2）→ 整组 unavailable；覆盖率趋势无时间序列接口 → 该槽不可得；辅助分布只作说明，不进指标位、不写 0。</span>
          </footer>
        </>
      )}
    </main>
  );
}