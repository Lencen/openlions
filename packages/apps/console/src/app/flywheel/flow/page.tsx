"use client";

// /flywheel/flow — 0.5 批F · demo slot 还原（2026-11-13）
// slots：s12｜流程编排（表格）
// 取数（既有只读端点）：/api/flywheel-flow、/api/flywheel/card9、/api/flywheel-health
// 口径纪律（数据卡 card-flywheel-flow）：
//   · 七步 qty 全 0 是映射断链（G-1）：同一回包 sources 非空、llm24=0 → 窗口计数按不可得，不写 0 当结论；
//   · 指标位改用字典口径：管道新鲜度（卡 9）/ 积压（排队+处理中）/ 提炼失败率（卡 9）/ 反思 24h 新增（体检）；
//   · 页面每 10 秒自动刷新，数据时刻 = 接口 timestamp。
import { useCallback, useEffect, useState } from "react";
import DataMoment from "@/components/DataMoment";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden";

interface Step { id?: string; label?: string; desc?: string; qty?: { m5?: number; m15?: number; h1?: number; h24?: number }; }
interface Flow {
  ok?: boolean; timestamp?: string; steps?: Step[]; sources?: Array<{ source?: string; c?: string | number }>;
  queues?: Record<string, string | number>; heartbeat?: { lastEvent?: { stage?: string; createdAt?: string; ageSec?: number } | null; llm24?: number };
  reflectStatus?: Array<{ status?: string; c?: string | number }>; logs?: string[];
}
interface Check { id: string; valueNum?: number | null; unit?: string; state?: string; reason?: string; extra?: { attempts?: number }; }
interface Card9 { asOf?: string; checks?: Check[]; }
interface Health { asOf?: string; five24?: Record<string, number>; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const T = (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "n/a");
const clip = (v?: string | null, n = 80) => {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  return s ? (s.length > n ? s.slice(0, n) + "…" : s) : "n/a";
};

export default function FlowPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [flow, setFlow] = useState<Flow | null>(null);
  const [c9, setC9] = useState<Card9 | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [srcErr, setSrcErr] = useState<Record<string, string>>({});
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr(""); setSrcErr({});
    const SOURCES: Array<[string, string]> = [
      ["流水线", "/api/flywheel-flow"],
      ["指标带", "/api/flywheel/card9"],
      ["体检", "/api/flywheel-health"],
    ];
    Promise.all(SOURCES.map(async ([label, url]) => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        if (r.status === 401 || r.status === 403) return { label, forbidden: true as const };
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          if (FORBIDDEN_RE.test(txt)) return { label, forbidden: true as const };
          return { label, error: label + "读取失败（状态码 " + r.status + "）" };
        }
        return { label, data: await r.json() };
      } catch (e: unknown) {
        return { label, error: label + "请求失败：" + String((e as Error)?.message || e).slice(0, 80) };
      }
    })).then((rs) => {
      if (!alive) return;
      if (rs.some((x) => "forbidden" in x && x.forbidden)) { setPhase("forbidden"); return; }
      const errs: Record<string, string> = {};
      const flowRs = rs.find((x) => x.label === "流水线");
      for (const x of rs) {
        if ("data" in x && x.data) {
          if (x.label === "流水线") setFlow(x.data as Flow);
          if (x.label === "指标带") setC9(x.data as Card9);
          if (x.label === "体检") setHealth(x.data as Health);
        } else if ("error" in x && x.error) errs[x.label] = x.error;
      }
      setSrcErr(errs);
      if (!flowRs || !("data" in flowRs) || !flowRs.data) { setErr(errs["流水线"] || "流水线接口不可得"); setPhase("error"); return; }
      if ((flowRs.data as Flow)?.ok === false) { setErr("流水线接口返回 ok=false"); setPhase("error"); return; }
      setPhase("ok");
    });
    return () => { alive = false; };
  }, [nonce]);

  const steps = Array.isArray(flow?.steps) ? flow.steps : [];
  const sources = Array.isArray(flow?.sources) ? flow.sources : [];
  const sourceSum = sources.reduce((s, x) => s + (Number(x.c) || 0), 0);
  const queues = flow?.queues || {};
  const jobPending = Number(queues.jobPending);
  const jobRunning = Number(queues.jobRunning);
  const backlog = Number.isFinite(jobPending) && Number.isFinite(jobRunning) ? jobPending + jobRunning : null;
  const pipeline = (c9?.checks || []).find((c) => c.id === "pipeline_freshness");
  const failRate = (c9?.checks || []).find((c) => c.id === "extract_fail_rate");
  const reflect24 = health?.five24?.Reflection;
  const lastEvent = flow?.heartbeat?.lastEvent || null;
  const stepSum = steps.reduce((s, x) => s + (Number(x.qty?.h24) || 0), 0);
  const flowBroken = steps.length > 0 && stepSum === 0 && sourceSum > 0;

  return (
    <main className="page" data-slot="flywheel-flow-page">
      <PageHeader>
        <PageTitle>流程编排</PageTitle>
        <div className="page-subtitle">飞轮七步编排与队列：窗口计数映射断链时按不可得处理；本页只读{flow?.timestamp ? "，最近更新 " + T(flow.timestamp) : ""}。</div>
      </PageHeader>
      <div className={styles.crumbs} aria-label="页面层级" data-slot="flywheel-flow-breadcrumb"><span>#</span><span>飞轮</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少流程编排的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「飞轮停转」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>流程编排</h2><p className={styles.sub}>七步 · 窗口计数（近 24 小时）· 映射未命中（缺口 G-1）时按不可得处理</p></div>
              <span className={flowBroken ? styles.tagNa : styles.tagOk}>{flowBroken ? "窗口计数不可得" : "只读"}</span>
            </div>

            <p className={styles.metaLine}>
              字典口径：管道新鲜度 <b>{pipeline && pipeline.valueNum != null ? pipeline.valueNum + " 小时" : "n/a"}</b>
              {pipeline ? "（" + (pipeline.state === "na" ? "输入稀疏，不判断流" : pipeline.state === "fail" ? "超 SLO" : "SLO 内") + "）" : "（指标带不可得）"}
              {" · "}积压 <b>{backlog == null ? "n/a" : NUM(backlog) + " 条"}</b>（排队 {NUM(jobPending)} + 处理中 {NUM(jobRunning)}）
              {" · "}提炼失败率 <b>{failRate && failRate.valueNum != null ? failRate.valueNum + "%" : "n/a"}</b>
              {" · "}反思 24h 新增 <b>{health ? NUM(reflect24) + " 条" : "n/a"}</b>
            </p>

            {steps.length === 0 ? (
              <div className={styles.stateMini}>接口未返回七步（非加载中）—— 按不可得处理。</div>
            ) : (
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr><th>流程</th><th>名称</th><th className={styles.num}>窗口计数（近 24 小时）</th><th>状态</th><th>口径 / 说明</th></tr>
                  </thead>
                  <tbody>
                    {steps.map((s, i) => (
                      <tr key={s.id || i}>
                        <td className={styles.mono}>{s.id || "n/a"}</td>
                        <td className={styles.name}>{s.label || "n/a"}</td>
                        <td className={styles.num + " " + styles.na}>{flowBroken ? "n/a" : NUM(Number(s.qty?.h24) || 0)}</td>
                        <td><span className={styles.tagPlain + " " + (flowBroken ? styles.toneWarn : styles.toneOk)}>{flowBroken ? "不可得" : "有窗口流量"}</span></td>
                        <td className={styles.detailCell}>{clip(s.desc, 90)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {flowBroken ? (
              <div className={styles.noteBox}>
                <b className={styles.noteTitle}>七步窗口计数为何不可得</b>
                <span>同一次回包里来源合计 {NUM(sourceSum)} 条、但七步计数全 0，且心跳 llm24=0 —— 来源映射按精确等值匹配（实际值带前缀），属口径断链（缺口 G-1）；不写 0 当结论、不判断「飞轮停转」。</span>
              </div>
            ) : null}

            <div className={styles.noteBox}>
              <b className={styles.noteTitle}>队列与心跳（同一回包，辅助说明）</b>
              <ul className={styles.noteList}>
                <li>队列：会话待处理 {NUM(Number(queues.sessionPending))} · 会话失败 {NUM(Number(queues.sessionFailed))} · 作业排队 {NUM(jobPending)} · 作业处理中 {NUM(jobRunning)} · 死信 {NUM(Number(queues.dlq))}</li>
                <li>心跳：{lastEvent ? "最近事件 " + (lastEvent.stage || "n/a") + " · " + T(lastEvent.createdAt) + " · 距今 " + NUM(lastEvent.ageSec) + " 秒" : "接口未返回最近事件"}</li>
                <li>反思状态：{(flow?.reflectStatus || []).length ? (flow?.reflectStatus || []).map((x) => (x.status || "n/a") + " " + NUM(Number(x.c) || 0)).join(" · ") : "n/a"}（主题反思表，非反思内容表）</li>
              </ul>
            </div>
          </section>

          <footer className={styles.foot}>
            <DataMoment items={[{ label: "流水线", at: flow?.timestamp }, { label: "指标带", at: c9?.asOf }, { label: "体检", at: health?.asOf }]} showPrefix={false} />
            <span className={styles.footNote}>口径：七步窗口计数 = 事件映射聚合（映射断链 → 不可得，缺口 G-1）；字典指标 = 管道新鲜度（卡 9）/ 积压（作业排队 + 处理中）/ 提炼失败率（卡 9）/ 反思 24h 新增（体检口径，0 是真实值）。取不到一律 n/a + 原因，不写 0。</span>
          </footer>
        </>
      )}
    </main>
  );
}