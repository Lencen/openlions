"use client";
// 2026-10-13 round 76-BM: 从 mind 的 /rotation 搬来(用户决策: console 是唯一管理后台, mind 前端退休)。
//   数据与动作走 console 的 BFF /api/rotation(-> mind 的 autoRotation.*); 界面用 console 原子件与主题令牌。
// 2026-11-05 P2 呈现层改造（批 4/5）：内联样式清零 + 手写 .tbl 表换成白名单 DataTable。
//   列/字段/文案/动作与接口（/api/rotation）一字未改；输入框宽度改为 .w200 / .w100 档位类。
import { useEffect, useState } from "react";
import Link from "next/link";
import { statusLabel } from "@/config/systemLabels";
import KPICard from "@/components/KPICard";
import { useApi } from "@/lib/api";
import { Alert, Button, Empty, Input, Skeleton, Tag } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";

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

/** 轮转记录列（与改前 <thead> 时间/来源/处理记录/状态 逐列对应） */
const columns: DataColumn<TL>[] = [
  { key: "date", title: "时间", render: (x) => <span className={"nowrap mono " + styles.cellSm}>{fmt(x.date)}</span> },
  { key: "sourceType", title: "来源", render: (x) => <span className="nowrap">{x.sourceType || "-"}</span> },
  { key: "recordsSynced", title: "处理记录", align: "right", render: (x) => <>{x.recordsSynced ?? 0}</> },
  {
    key: "status",
    title: "状态",
    render: (x) => (
      <Tag color={x.status === "COMPLETED" ? "green" : x.status === "FAILED" ? "red" : "orange"}>{statusLabel(x.status) || "-"}</Tag>
    ),
  },
];

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
    <div className="breadcrumb"><span className={styles.crumbDim}>平台管理</span><span className="sep">/</span><span className="current">飞轮轮转</span></div>
    <PageHeader><PageTitle>飞轮自动轮转</PageTitle><div className="page-subtitle">定时把会话轮转成认知资产；此处可启停、立即执行一次、并调整定时与单次上限。</div></PageHeader>
    {error && <div className={styles.alertRow}><Alert type="error" message="轮转状态加载失败" description={String((error as Error)?.message || error).slice(0, 200)} /></div>}
    {!error && <div className="kpi-grid">
      <KPICard label="运行状态" value={loading && !st ? "..." : (st?.isCurrentlyRunning ? "执行中" : (running ? "运行中" : "已停止"))} />
      <KPICard label="定时" value={st?.cronHumanReadable || "..."} />
      <KPICard label="总运行次数" value={st?.totalRuns != null ? String(st.totalRuns) : "..."} />
      <KPICard label="累计处理记录" value={st?.totalRecords != null ? String(st.totalRecords) : "..."} />
    </div>}
    {!error && <div className="panel"><div className="panel-header"><span className="panel-title">控制</span>
      <span className={"tiny " + styles.dimText}>上次运行 {fmt(st?.lastRunAt)} · 下次 {fmt(st?.nextRunAt)}</span></div>
      <div className={styles.controlBody}>
        <label className={styles.fieldLabel}>定时表达式
          <Input className={styles.w200} value={expr} onChange={(e: any) => setExpr(e.target.value)} placeholder="*/30 * * * *" /></label>
        <label className={styles.fieldLabel}>单次上限
          <Input className={styles.w100} type="number" value={maxPerRun} onChange={(e: any) => setMaxPerRun(Math.max(1, Number(e.target.value) || 1))} /></label>
        <label className={styles.fieldLabel}>项目过滤（留空 = 全部）
          <Input className={styles.w200} value={projectFilter} onChange={(e: any) => setProjectFilter(e.target.value)} placeholder="全部" allowClear /></label>
        <div className={styles.btnRow}>
          <Button type="primary" disabled={busy !== null || running} onClick={() => act("start")}>{busy === "start" ? "启动中…" : "启动"}</Button>
          <Button disabled={busy !== null || !running} onClick={() => act("stop")}>{busy === "stop" ? "停止中…" : "停止"}</Button>
          <Button disabled={busy !== null} onClick={() => act("runNow")}>{busy === "runNow" ? "触发中…" : "立即执行一次"}</Button>
          <Button disabled={busy !== null} onClick={() => act("updateConfig")}>{busy === "updateConfig" ? "保存中…" : "保存配置"}</Button>
        </div>
      </div>
      {msg && <div className={styles.alertPad}><Alert type={msg.ok ? "success" : "error"} message={msg.text} /></div>}
      {st?.lastError && <div className={styles.alertPad}><Alert type="warning" message="上次运行有错误" description={String(st.lastError).slice(0, 200)} /></div>}
    </div>}
    {!error && <div className="panel"><div className="panel-header"><span className="panel-title">最近轮转记录 {loading && <span className="tiny">（加载中…）</span>}</span></div>
      {loading && !tl.length && <div className={styles.pad35}><Skeleton active title={false} paragraph={{ rows: 3 }} /></div>}
      {!loading && !tl.length && <Empty description="暂无轮转记录" />}
        {tl.length > 0 && <>
        <TableCopyButton />
        <DataTable
          columns={columns}
          rows={tl.slice(0, 30)}
          rowKey={(_x, i) => i}
        />
        </>}</div>}
    {/* 2026-10-19 B5(方案 L3-2): 修前正文 0 出链 ✗; 轮转产物最终进入流水线/访问日志, 给出后续去向 ✓ */}
    <div className={"tiny " + styles.related}>
      <span>相关视图：</span>
      <Link href="/system/pipeline">流水线监控 →</Link>
      <Link href="/system/access-log">访问日志 →</Link>
    </div>
  </main></div>);
}
