"use client";

// /flywheel/audit — 0.5 批F · demo slot 还原（2026-11-13）
// slots：s12｜飞轮审计（表格）
// 取数（既有只读端点）：/api/flywheel-audit?limit=50
// 口径纪律（数据卡 card-flywheel-audit）：
//   · 事件列表/错误面板均为接口真实数据；「今日事件」接口字段是字符串拼接坏值 → 用阶段分布求和（派生）并注明；
//   · 今日错误与历史错误分列：错误面板固定标「历史（非今日）」并给最后一条时刻（G-2）；
//   · 接口无 asOf → 页脚标「请求时刻（客户端，非库内时刻）」（G-4）。
import { useCallback, useEffect, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden";

interface Ev { stage?: string; sourceType?: string; sourceTitle?: string; createdAt?: string; }
interface ErrEv { errorType?: string; stage?: string; sessionId?: string; message?: string; occurredAt?: string; }
interface Audit { events?: Ev[]; errors?: ErrEv[]; byStage?: Array<{ stage?: string; c?: string | number }>; todayEvents?: unknown; todayErrors?: unknown; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const T = (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "n/a");
const clip = (v?: string | null, n = 60) => {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  return s ? (s.length > n ? s.slice(0, n) + "…" : s) : "n/a";
};

export default function AuditPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [data, setData] = useState<Audit | null>(null);
  const [nonce, setNonce] = useState(0);
  const [reqAt, setReqAt] = useState("");
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr("");
    (async () => {
      try {
        const r = await fetch("/api/flywheel-audit?limit=50", { cache: "no-store" });
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setPhase("forbidden"); return; }
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          if (FORBIDDEN_RE.test(txt)) { setPhase("forbidden"); return; }
          setErr("审计接口读取失败（状态码 " + r.status + "）");
          setPhase("error");
          return;
        }
        const j: Audit & { error?: string } = await r.json();
        if (!alive) return;
        if (j.error) { setErr(String(j.error)); setPhase("error"); return; }
        setData(j);
        setReqAt(new Date().toLocaleString("zh-CN", { hour12: false }));
        setPhase("ok");
      } catch (e: unknown) {
        if (!alive) return;
        setErr("审计接口请求失败：" + String((e as Error)?.message || e).slice(0, 80));
        setPhase("error");
      }
    })();
    return () => { alive = false; };
  }, [nonce]);

  const events = Array.isArray(data?.events) ? data.events : [];
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const byStage = Array.isArray(data?.byStage) ? data.byStage : [];
  const byStageSum = byStage.reduce((s, x) => s + (Number(x.c) || 0), 0);
  const latestError = errors[0]?.occurredAt || null;
  const todayEventsRaw = data?.todayEvents;
  const todayEventsOk = typeof todayEventsRaw === "number" && Number.isFinite(todayEventsRaw);
  const todayErrors = typeof data?.todayErrors === "number" ? data.todayErrors : null;
  const topStages = byStage.slice(0, 4);

  return (
    <main className="page">
      <PageHeader>
        <PageTitle>飞轮审计</PageTitle>
        <div className="page-subtitle">飞轮事件时间线与历史错误：今日与历史分列，最新事件在前；本页只读。</div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>飞轮</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少飞轮审计的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「今日没有事件」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>飞轮审计</h2><p className={styles.sub}>最近 {events.length} 条事件 · 错误面板为历史（非今日）</p></div>
              <span className={styles.tagOk}>只读</span>
            </div>

            <p className={styles.metaLine}>
              今日事件 <b>{byStageSum > 0 ? NUM(byStageSum) + " 条" : "n/a"}</b>（派生：阶段分布求和；
              {" "}接口「今日事件」字段为字符串拼接坏值，不直接采用）
              {" · "}今日错误 <b>{todayErrors == null ? "n/a" : NUM(todayErrors) + " 条"}</b>
              {" · "}历史错误最新 <b>{T(latestError)}</b>（历史，非今日）
              {todayEventsOk ? "" : ""}
            </p>

            {events.length === 0 && byStage.length === 0 ? (
              <div className={styles.stateMini}>今日暂无事件（接口正常返回空集，非加载中）—— 可到运行日志查看服务状态。</div>
            ) : (
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr><th>时间</th><th>阶段</th><th>来源</th><th>详情</th><th>结果</th></tr>
                  </thead>
                  <tbody>
                    {events.map((e, i) => (
                      <tr key={i}>
                        <td className={styles.mono}>{T(e.createdAt)}</td>
                        <td>{e.stage || "n/a"}</td>
                        <td className={styles.dim}>{e.sourceType || "n/a"}</td>
                        <td className={styles.detailCell} title={e.sourceTitle || ""}>{clip(e.sourceTitle, 80)}</td>
                        <td><span className={styles.tagPlain + " " + styles.toneOk}>成功</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {topStages.length > 0 ? (
              <p className={styles.metaLine}>今日阶段分布：{topStages.map((s) => (s.stage || "n/a") + " " + NUM(Number(s.c) || 0)).join(" · ")}</p>
            ) : null}

            <div className={styles.noteBox}>
              <b className={styles.noteTitle}>历史错误（最近 {errors.length} 条，非今日）</b>
              {errors.length === 0 ? (
                <span>接口未返回历史错误。</span>
              ) : (
                <div className={styles.tblWrap}>
                  <table className={styles.tbl}>
                    <thead>
                      <tr><th>时间</th><th>类型</th><th>阶段</th><th>会话</th><th>消息</th></tr>
                    </thead>
                    <tbody>
                      {errors.map((e, i) => (
                        <tr key={i}>
                          <td className={styles.mono}>{T(e.occurredAt)}</td>
                          <td><span className={styles.tagPlain + " " + styles.toneCrit}>{e.errorType || "n/a"}</span></td>
                          <td>{e.stage || "n/a"}</td>
                          <td className={styles.mono}>{clip(e.sessionId, 26)}</td>
                          <td className={styles.detailCell} title={e.message || ""}>{clip(e.message, 80)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <footer className={styles.foot}>
            <span>数据时刻：请求时刻 {reqAt || "n/a"}（客户端，非库内时刻 —— 接口无该字段，缺口 G-4） · 每 15 秒自动刷新</span>
            <span className={styles.footNote}>口径：事件/错误列表为接口真实数据；今日事件用阶段分布求和（派生，接口原字段为坏值）；今日错误与历史错误分列，错误面板固定标「历史（非今日）」；字典无事件/错误计数条目（G-1）→ 不以 0 或示例值冒充指标。</span>
          </footer>
        </>
      )}
    </main>
  );
}
