"use client";

// /flywheel/tasks — 0.5 批次B · demo slot 还原（2026-11-13）
// slots：s12｜改进任务（表格，含状态筛选工具条）
// 页首 4 项指标带（数据卡 7）：飞轮任务积压数 / 完成数（近7日）/ 失败数（近7日）/ P95 耗时（近7日）
// 取数（均既有只读端点）：/api/flywheel-tasks、/api/flywheel-flow、/api/flywheel/tasks-metrics
// 口径纪律：取不到一律 n/a + 原因，不写 0；P95 样本 <10 记不可判；缺字段列保留、单元格 n/a。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import DataMoment from "@/components/DataMoment";
import PageSearch from "@/components/ui/PageSearch";
import { PageHeader, PageTitle } from "@/components/ui";
import styles from "./page.module.css";

type Phase = "loading" | "ok" | "error" | "forbidden";

interface Item {
  id?: string; title?: string; type?: string; scope?: string; status?: string;
  theme?: string | null; priority?: string | null; assignedAgent?: string | null;
  completedBy?: string | null; createdAt?: string | null; updatedAt?: string | null; completedAt?: string | null;
}
interface TaskResp { items?: Item[]; total?: number; asOf?: string; range?: string; counts?: { total?: number; byStatus?: Record<string, number> }; error?: string; }
interface FlowResp { queues?: Record<string, string | number>; timestamp?: string; error?: string; }
interface Metrics { done7d?: number | null; failed7d?: number | null; p95s?: number | null; p95Sample?: number | null; asOf?: string; reason?: string | null; }

const FORBIDDEN_RE = /(401|403|无权限|未授权|forbidden|unauthorized)/i;
const NUM = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("zh-CN") : "n/a");
const T = (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "n/a");
const pad = (v: number) => String(v).padStart(2, "0");
const DAY = (v?: string | null) => {
  if (!v) return "n/a";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "n/a";
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
};
const STATUS_LABEL: Record<string, string> = { PENDING: "待做", IN_PROGRESS: "进行中", PROCESSING: "处理中", DONE: "完成", FAILED: "失败", BLOCKED: "阻塞", DEPRECATED: "已废弃", DROPPED: "已丢弃" };
const STATUS_TONE: Record<string, string> = { PENDING: "warn", IN_PROGRESS: "info", PROCESSING: "info", DONE: "ok", FAILED: "crit", BLOCKED: "crit" };

export default function FlywheelTasksPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState("");
  const [tasks, setTasks] = useState<TaskResp | null>(null);
  const [flow, setFlow] = useState<FlowResp | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [srcErr, setSrcErr] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<"ALL" | "PENDING" | "IN_PROGRESS" | "FAILED">("ALL");
  const [nonce, setNonce] = useState(0);
  const [q, setQ] = useState("");
  const reload = useCallback(() => setNonce((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    setPhase("loading"); setErr(""); setSrcErr({}); setTasks(null); setFlow(null); setMetrics(null);
    const SOURCES: Array<[string, string]> = [
      ["改进任务", "/api/flywheel-tasks?status=ALL&scope=ALL&limit=50&range=24h"],
      ["飞轮队列", "/api/flywheel-flow"],
      ["任务指标", "/api/flywheel/tasks-metrics"],
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
      const listRs = rs.find((x) => x.label === "改进任务");
      for (const x of rs) {
        if ("data" in x && x.data) {
          if (x.label === "改进任务") setTasks(x.data as TaskResp);
          if (x.label === "飞轮队列") setFlow(x.data as FlowResp);
          if (x.label === "任务指标") setMetrics(x.data as Metrics);
        } else if ("error" in x && x.error) errs[x.label] = x.error;
      }
      setSrcErr(errs);
      if (!listRs || !("data" in listRs) || !listRs.data) {
        setErr(errs["改进任务"] || "改进任务列表不可得");
        setPhase("error");
        return;
      }
      setPhase("ok");
    });
    return () => { alive = false; };
  }, [nonce]);

  const items = Array.isArray(tasks?.items) ? tasks.items : [];
  const counts = items.reduce((acc, it) => {
    const st = String(it.status || "");
    acc.ALL = (acc.ALL || 0) + 1;
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const kw = q.trim().toLowerCase();
  const filtered = items
    .filter((it) => filter === "ALL" ? true : (filter === "IN_PROGRESS" ? ["IN_PROGRESS", "PROCESSING"].includes(String(it.status)) : it.status === filter))
    .filter((it) => (!kw ? true : [it.title, it.type, it.scope, it.status, it.theme].some((v) => String(v || "").toLowerCase().includes(kw))));

  const queues = flow?.queues || {};
  const jp = Number(queues.jobPending);
  const jr = Number(queues.jobRunning);
  const backlog = !flow?.error && queues.jobPending != null && queues.jobRunning != null && Number.isFinite(jp) && Number.isFinite(jr) ? jp + jr : null;
  const backlogReason = flow?.error || srcErr["飞轮队列"] || "队列接口未返回排队/处理中计数";
  const tm = metrics;
  const sample = tm?.p95Sample != null ? Number(tm.p95Sample) : null;

  const filters: Array<[string, string]> = [["ALL", "全部"], ["PENDING", "待做"], ["IN_PROGRESS", "进行中"], ["FAILED", "失败"]];
  const toneCls = (tone?: string) => tone === "ok" ? styles.toneOk : tone === "info" ? styles.toneInfo : tone === "warn" ? styles.toneWarn : tone === "crit" ? styles.toneCrit : "";

  return (
    <main className="page" data-slot="flywheel-tasks-page">
      <PageHeader>
        <PageTitle>改进任务</PageTitle>
        <div className="page-subtitle">
          飞轮自省提出的机制修复类改进项（与待办是两个队列）；本页只读，按近 24 小时窗口列出。
          数据卡 7 口径（并入页头，不占槽）：积压 {backlog == null ? "n/a" : NUM(backlog) + " 条"} · 完成 7 日 {tm?.done7d != null ? NUM(tm.done7d) + " 条" : "n/a"} · 失败 7 日 {tm?.failed7d != null ? NUM(tm.failed7d) + " 条" : "n/a"} · P95 {tm?.p95s != null && sample != null && sample >= 10 ? String(tm.p95s) + " 秒" : "n/a"}。
        </div>
      </PageHeader>
      <PageSearch value={q} onChange={setQ} placeholder="搜索改进项 / 类型 / 影响域 / 状态…" />
      <div className={styles.crumbs} aria-label="页面层级"><span>#</span><span>飞轮</span><span>列表</span><span className={styles.crumbOn}>只读</span></div>

      {phase === "loading" && <div className={styles.state}>加载中…（不显示假计数）</div>}
      {phase === "forbidden" && (
        <div className={styles.state}>
          <b>无权限访问</b><p>当前账号缺少改进任务的读权限（返回 401/403）。请联系平台管理员开通后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}
      {phase === "error" && (
        <div className={styles.state}>
          <b>加载失败</b><p>{err}；失败不等于「没有改进任务」，请稍后重试。</p>
          <button className="btn" type="button" onClick={reload}>重试</button>
        </div>
      )}

      {phase === "ok" && (
        <>
          <div className={styles.toolbar} role="group" aria-label="改进任务状态筛选" data-slot="flywheel-tasks-toolbar">
            {filters.map(([key, label]) => (
              <button key={key} type="button" className={styles.filter + (filter === key ? " " + styles.filterOn : "")} onClick={() => setFilter(key as typeof filter)}>
                {label}<span className={styles.badge}>{NUM(counts[key] || 0)}</span>
              </button>
            ))}
            <span className={styles.hint}>计数 = 当前窗口内列出的条数 · 仅前端筛选</span>
          </div>

          <section className={styles.card + " " + styles.s12}>
            <div className={styles.cardHead}>
              <div><h2 className={styles.cardTitle}>改进任务</h2><p className={styles.sub}>近 24 小时窗口 · 当前列表 {filtered.length} 条 · 缺字段列保留并标 n/a</p></div>
              <span className={styles.tagOk}>只读</span>
            </div>
            {items.length === 0 ? (
              <div className={styles.stateMini}>
                本窗口没有改进任务（接口正常返回空集，非加载中）—— 飞轮跑过一轮自省后才会产生；
                <Link href="/flywheel/reflections" className={styles.link}>去反思页 →</Link>
              </div>
            ) : filtered.length === 0 ? (
              <div className={styles.stateMini}>当前筛选（状态 + 关键词）下没有匹配项 —— 清空搜索或切换到「全部」。</div>
            ) : (
              <div className={styles.tblWrap}>
                <table className={styles.tbl}>
                  <thead>
                    <tr>
                      <th>编号</th><th>改进项</th><th>类型</th><th>来源</th><th>影响域</th><th>预期收益</th><th>负责人</th><th>状态</th><th>创建时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((it, i) => (
                      <tr key={it.id || i}>
                        <td className={styles.mono}>{it.id || "n/a"}</td>
                        <td className={styles.name}>{it.title || "n/a"}</td>
                        <td>{it.type || "n/a"}</td>
                        <td className={styles.na}>n/a（无来源字段）</td>
                        <td className={styles.na}>n/a（无该字段）</td>
                        <td className={styles.na}>n/a（无该字段）</td>
                        <td>{it.assignedAgent ? it.assignedAgent : "未指派"}</td>
                        <td><span className={styles.tagPlain + toneCls(STATUS_TONE[String(it.status)])}>{STATUS_LABEL[String(it.status)] || it.status || "n/a"}</span></td>
                        <td className={styles.mono}>{DAY(it.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <footer className={styles.foot}>
            <DataMoment
              items={[
                { label: "改进任务", at: tasks?.asOf },
                { label: "飞轮队列", at: flow?.timestamp },
                { label: "任务指标", at: metrics?.asOf },
              ]}
              showPrefix={false}
            />
            <span className={styles.footNote}>口径：积压 = 飞轮作业排队中 + 处理中；完成/失败/P95 = 近 7 日飞轮作业（数据卡 7）；列表 = 近 24 小时窗口内的改进类任务。取不到显示 n/a + 原因，不写 0；P95 样本 &lt;10 判不可判。</span>
          </footer>
        </>
      )}
    </main>
  );
}