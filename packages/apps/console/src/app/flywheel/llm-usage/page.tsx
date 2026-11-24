"use client";

// /flywheel/llm-usage — 0.5 批F · demo slot 还原（2026-11-13）
// slots：s12｜（KPI/摘要）4 项 · s8｜tokens 趋势（图表）· s4｜按模型（条形）
// 取数（既有只读端点）：/api/llm-usage?range=24h
// 口径纪律（数据卡 card-flywheel-llm-usage）：
//   · 24h 有调用但标记数解析失败 → 标「未计量」，不写 0（G-2）；7d 标记数只含可解析旧行（G-4）；
//   · model 缺失（unknown）单列并标占比（G-3）；
//   · 数据时刻用接口 at，不用客户端请求时刻冒充（G-5）。
import { useCallback, useEffect, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden";

interface Bucket { totalCalls?: number; totalTokens?: number; byEntry?: Array<[string, { calls?: number; tokens?: number }]>; byModel?: Array<[string, { calls?: number; tokens?: number }]>; byHour?: Array<{ h?: string; calls?: number; tokens?: number }>; }
interface Resp { at?: string; alive?: boolean; last2hCalls?: number; last24?: Bucket; last7?: Bucket; range?: string; rangeLabel?: string; window?: Bucket; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const pctClass = (p: number): string => {
  const step = Math.min(100, Math.max(0, Math.round(p / 5) * 5));
  return styles["p" + step] || styles.p0;
};
const barClass = (p: number): string => {
  const step = Math.min(100, Math.max(0, Math.round(p / 5) * 5));
  return styles["bh" + step] || styles.bh0;
};

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "ok" | "warn" | "na" }) {
  return (
    <div className={styles.card}>
      <span className={styles.k}>{label}</span>
      <b className={styles.vXl + (tone === "na" ? " " + styles.na : tone === "warn" ? " " + styles.warn : "")}>{value}</b>
      <span className={styles.d}>{hint}</span>
    </div>
  );
}

export default function LlmUsagePage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr("");
    (async () => {
      try {
        const r = await fetch("/api/llm-usage?range=24h&_n=" + nonce, { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          if (FORBIDDEN_RE.test(txt)) { setPhase("forbidden"); return; }
          setErr("用量接口读取失败（状态码 " + r.status + "）");
          setPhase("error");
          return;
        }
        const j: Resp = await r.json();
        if (!alive) return;
        setData(j);
        setPhase("ok");
      } catch (e: unknown) {
        if (!alive) return;
        setErr("用量接口请求失败：" + String((e as Error)?.message || e).slice(0, 80));
        setPhase("error");
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const l24 = data?.last24 || {};
  const l7 = data?.last7 || {};
  const byHour = Array.isArray(l24.byHour) ? l24.byHour : [];
  const byModel = Array.isArray(l24.byModel) ? l24.byModel : [];
  const byEntry = Array.isArray(l24.byEntry) ? l24.byEntry : [];
  const calls24 = typeof l24.totalCalls === "number" ? l24.totalCalls : null;
  const tokens24 = typeof l24.totalTokens === "number" ? l24.totalTokens : null;
  const tokens7 = typeof l7.totalTokens === "number" ? l7.totalTokens : null;
  const calls7 = typeof l7.totalCalls === "number" ? l7.totalCalls : null;
  const maxCalls = byHour.reduce((m, r) => Math.max(m, Number(r.calls) || 0), 1);
  const modelTotal = byModel.reduce((s, [, v]) => s + (Number(v?.calls) || 0), 0);
  const unmeasured = calls24 != null && calls24 > 0 && tokens24 === 0;

  return (
    <main className="page" data-slot="flywheel-llm-usage-page">
      <PageHeader>
        <PageTitle>语言模型用量</PageTitle>
        <div className="page-subtitle">飞轮模型调用观测：有调用但标记数解析失败时标「未计量」，不写 0；本页只读。</div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>飞轮</span><span>现有</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少模型用量的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「没有消耗」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          <div className={styles.kpis} data-slot="flywheel-llm-usage-kpis">
            <Kpi
              label="24 小时调用数"
              value={calls24 != null ? NUM(calls24) + " 次" : "n/a"}
              hint={calls24 != null ? "接口原值（字典无条目，派生展示）" : "n/a（原因：接口未返回）"}
              tone={calls24 != null ? "ok" : "na"}
            />
            <Kpi
              label="24 小时标记数"
              value={unmeasured ? "未计量" : tokens24 != null ? NUM(tokens24) + " 个" : "n/a"}
              hint={unmeasured ? "有 " + NUM(calls24) + " 次调用但标记数为 0 —— 解析失败（来源标题格式变化，缺口 G-2），不写 0" : "标记数按接口原值展示；未计量时标「未计量」"}
              tone={unmeasured ? "warn" : "ok"}
            />
            <Kpi
              label="7 天标记数"
              value={tokens7 != null ? NUM(tokens7) + " 个" : "n/a"}
              hint={"调用 " + NUM(calls7) + " 次 · 仅含可解析旧行，口径不完整（G-4），不与 24 小时做环比"}
              tone={tokens7 != null ? "ok" : "na"}
            />
            <Kpi
              label="飞轮状态（2 小时内）"
              value={data?.alive ? "在转" : "停转"}
              hint={"最近 2 小时调用 " + NUM(data?.last2hCalls) + " 次"}
              tone={data?.alive ? "ok" : "warn"}
            />
          </div>

          <div className={styles.bento}>
            <section className={styles.card + " " + styles.s8}>
              <div className={styles.cardHead}>
                <div><h2 className={styles.cardTitle}>tokens 趋势</h2><p className={styles.sub}>近 24 小时 · 标记数未计量（G-2）→ 不画标记数曲线；柱高 = 调用数（真实）</p></div>
                <span className={styles.tagNa}>标记数未计量</span>
              </div>
              {byHour.length === 0 ? (
                <div className={styles.stateMini}>接口未返回小时分布。</div>
              ) : (
                <>
                  <div className={styles.bars}>
                    {byHour.map((r, i) => (
                      <div key={r.h || i} className={styles.bar + " " + barClass(((Number(r.calls) || 0) / maxCalls) * 100)} data-empty={Number(r.calls) ? undefined : "1"} title={(r.h || "") + " · " + NUM(Number(r.calls)) + " 次调用"} />
                    ))}
                  </div>
                  <div className={styles.barAxis}>
                    <span>{byHour[0]?.h || "n/a"}</span>
                    <span>{byHour[Math.floor(byHour.length / 2)]?.h || ""}</span>
                    <span>{byHour[byHour.length - 1]?.h || ""}</span>
                  </div>
                </>
              )}
            </section>

            <section className={styles.card + " " + styles.s4}>
              <div className={styles.cardHead}>
                <div><h2 className={styles.cardTitle}>按模型</h2><p className={styles.sub}>近 24 小时调用数占比 · 未知（model 缺失）单列</p></div>
                <span className={styles.tagOk}>真实调用</span>
              </div>
              {byModel.length === 0 ? (
                <div className={styles.stateMini}>接口未返回模型分布。</div>
              ) : (
                <>
                  {byModel.map(([m, v], i) => {
                    const calls = Number(v?.calls) || 0;
                    const pct = modelTotal > 0 ? (calls / modelTotal) * 100 : 0;
                    const label = m === "unknown" ? "未知（model 缺失）" : m;
                    return (
                      <div key={m || i} className={styles.modelRow}>
                        <span className={styles.modelName} title={label}>{label}</span>
                        <span className={styles.modelTrack}><span className={styles.modelFill + " " + pctClass(pct)} /></span>
                        <span className={styles.modelVal}>{NUM(calls)} 次 · {pct.toFixed(1)}%</span>
                      </div>
                    );
                  })}
                  <span className={styles.footNote}>未知占比 {(modelTotal > 0 ? ((byModel.filter(([m]) => m === "unknown").reduce((s, [, v]) => s + (Number(v?.calls) || 0), 0) / modelTotal) * 100) : 0).toFixed(1)}%（model 缺失，G-3）；模型分布只对已知模型可作参考。</span>
                </>
              )}
            </section>
          </div>

          <div className={styles.noteBox}>
            <b className={styles.noteTitle}>按入口（近 24 小时调用数，辅助说明）</b>
            <span>{byEntry.length ? byEntry.map(([k, v]) => k + " " + NUM(Number(v?.calls)) + " 次").join(" · ") : "n/a"}</span>
          </div>

          <footer className={styles.foot}>
            <span>数据时刻：{data?.at || "该源无时刻"}（接口口径，按 Asia/Shanghai） · 范围：{data?.rangeLabel || data?.range || "近 24 小时"}</span>
            <span className={styles.footNote}>口径：24h 调用数 / 7d 调用数 / 标记数为接口原值（字典无条目，派生展示）；有调用但标记数为 0 → 标「未计量」+ 原因，不写 0（G-2）；7d 标记数只含可解析旧行（G-4）；未知模型单列并标占比（G-3）；数据时刻用接口 at，不借客户端请求时刻（G-5）。</span>
          </footer>
        </>
      )}
    </main>
  );
}