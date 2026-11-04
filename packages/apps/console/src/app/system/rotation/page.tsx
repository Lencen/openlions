"use client";
// 2026-10-13 round 76-BM: 从 mind 的 /rotation 搬来(用户决策: console 是唯一管理后台, mind 前端退休)。
//   数据与动作走 console 的 BFF /api/rotation(-> mind 的 autoRotation.*); 界面用 console 原子件与主题令牌。
import { useEffect, useState } from "react";
import Link from "next/link";
import { statusLabel } from "@/config/systemLabels";
import KPICard from "@/components/KPICard";
import { useApi } from "@/lib/api";
import { Alert, Button, Empty, Input, Skeleton, Tag } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";

interface Status {
  enabled?: boolean; status?: string; cronExpression?: string; cronHumanReadable?: string;
  maxPerRun?: number; projectFilter?: string | null; lastRunAt?: string | null; lastError?: string | null;
  totalRuns?: number; totalRecords?: number; nextRunAt?: string | null; isCurrentlyRunning?: boolean;
}
interface TL { date: string; recordsSynced: number; status: string; duration: number; sourceType: string }
interface Resp { ok?: boolean; status?: Status | null; timeline?: TL[] | null; error?: string | null }

const fmt = (t?: string | null) => {
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  const p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
};

const SUCCESS_LABEL: Record<string, string> = {
  start: "自动任务已启动",
  stop: "自动任务已停止",
  runNow: "已触发立即运行（几分钟后刷新查看结果）",
  updateConfig: "配置已保存",
};

export default function RotationPage() {
  const { data, loading, error, mutate } = useApi<Resp>("/api/rotation");
  const st = data?.status ?? null;
  const tl = data?.timeline ?? [];
  const [expr, setExpr] = useState("*/30 * * * *");
  const [maxPerRun, setMaxPerRun] = useState(3);
  const [projectFilter, setProjectFilter] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 首次拿到状态后回填表单(其后不再覆盖用户正在编辑的值)
  useEffect(() => {
    if (seeded || !st) return;
    setExpr(st.cronExpression || "*/30 * * * *");
    setMaxPerRun(st.maxPerRun ?? 3);
    setProjectFilter(st.projectFilter || "");
    setSeeded(true);
  }, [st, seeded]);

  const payload = () => ({ cronExpression: expr, maxPerRun, projectFilter: projectFilter || undefined });

  const act = async (action: string) => {
    setBusy(action); setMsg(null);
    try {
      const r = await fetch("/api/rotation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payload: payload() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(String(j?.error || ("请求失败（状态码 " + r.status + "）")));
      setMsg({ ok: true, text: SUCCESS_LABEL[action] || "已完成" });
      mutate();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error)?.message || e) });
    } finally { setBusy(null); }
  };

  const running = st?.status === "RUNNING" || st?.isCurrentlyRunning === true;
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>平台管理</span><span className="sep">/</span><span className="current">飞轮轮转</span></div>
    <div className="page-header"><div className="page-title">飞轮自动轮转</div><div className="page-subtitle">定时把会话轮转成认知资产；此处可启停、立即执行一次、并调整定时与单次上限。</div></div>
    {error && <div style={{ marginBottom: "var(--sp-3)" }}><Alert type="error" message="轮转状态加载失败" description={String((error as Error)?.message || error).slice(0, 200)} /></div>}
    {!error && <div className="kpi-grid">
      <KPICard label="运行状态" value={loading && !st ? "..." : (st?.isCurrentlyRunning ? "执行中" : (running ? "运行中" : "已停止"))} />
      <KPICard label="定时" value={st?.cronHumanReadable || "..."} />
      <KPICard label="总运行次数" value={st?.totalRuns != null ? String(st.totalRuns) : "..."} />
      <KPICard label="累计处理记录" value={st?.totalRecords != null ? String(st.totalRecords) : "..."} />
    </div>}
    {!error && <div className="panel"><div className="panel-header"><span className="panel-title">控制</span>
      <span className="tiny" style={{ color: "var(--text-dim)" }}>上次运行 {fmt(st?.lastRunAt)} · 下次 {fmt(st?.nextRunAt)}</span></div>
      <div style={{ padding: "var(--sp-3-5)", display: "flex", flexWrap: "wrap", gap: "var(--sp-2-5)", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>定时表达式
          <Input value={expr} onChange={(e: any) => setExpr(e.target.value)} style={{ width: 200 }} placeholder="*/30 * * * *" /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>单次上限
          <Input type="number" value={maxPerRun} onChange={(e: any) => setMaxPerRun(Math.max(1, Number(e.target.value) || 1))} style={{ width: 100 }} /></label>
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>项目过滤（留空 = 全部）
          <Input value={projectFilter} onChange={(e: any) => setProjectFilter(e.target.value)} style={{ width: 200 }} placeholder="全部" allowClear /></label>
        <div style={{ display: "flex", gap: "var(--sp-2)" }}>
          <Button type="primary" disabled={busy !== null || running} onClick={() => act("start")}>{busy === "start" ? "启动中…" : "启动"}</Button>
          <Button disabled={busy !== null || !running} onClick={() => act("stop")}>{busy === "stop" ? "停止中…" : "停止"}</Button>
          <Button disabled={busy !== null} onClick={() => act("runNow")}>{busy === "runNow" ? "触发中…" : "立即执行一次"}</Button>
          <Button disabled={busy !== null} onClick={() => act("updateConfig")}>{busy === "updateConfig" ? "保存中…" : "保存配置"}</Button>
        </div>
      </div>
      {msg && <div style={{ padding: "0 var(--sp-3-5) var(--sp-3-5)" }}><Alert type={msg.ok ? "success" : "error"} message={msg.text} /></div>}
      {st?.lastError && <div style={{ padding: "0 var(--sp-3-5) var(--sp-3-5)" }}><Alert type="warning" message="上次运行有错误" description={String(st.lastError).slice(0, 200)} /></div>}
    </div>}
    {!error && <div className="panel"><div className="panel-header"><span className="panel-title">最近轮转记录 {loading && <span className="tiny">（加载中…）</span>}</span></div>
      {loading && !tl.length && <div style={{ padding: "var(--sp-3-5)" }}><Skeleton active title={false} paragraph={{ rows: 3 }} /></div>}
      {!loading && !tl.length && <Empty description="暂无轮转记录" />}
        {tl.length > 0 && <>
        <TableCopyButton />
        <table className="tbl"><thead><tr><th>时间</th><th>来源</th><th>处理记录</th><th>状态</th></tr></thead><tbody>
        {tl.slice(0, 30).map((x, i) => (<tr key={i}>
          <td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{fmt(x.date)}</td>
          <td className="nowrap" style={{ fontSize: "var(--fs-base)" }}>{x.sourceType || "-"}</td>
          <td className="num">{x.recordsSynced ?? 0}</td>
          <td><Tag color={x.status === "COMPLETED" ? "green" : x.status === "FAILED" ? "red" : "orange"}>{statusLabel(x.status) || "-"}</Tag></td>
        </tr>))}
      </tbody></table>
        </>}</div>}
    {/* 2026-10-19 B5(方案 L3-2): 修前正文 0 出链 ✗; 轮转产物最终进入流水线/访问日志, 给出后续去向 ✓ */}
    <div className="tiny" style={{ display: "flex", gap: "var(--sp-4)", flexWrap: "wrap", marginTop: "var(--sp-4)" }}>
      <span>相关视图：</span>
      <Link href="/system/pipeline">流水线监控 →</Link>
      <Link href="/system/access-log">访问日志 →</Link>
    </div>
  </main></div>);
}
