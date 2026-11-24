"use client";
// 0.5.1 B5-4 /system/automation · Bento P5/P4 看板（2026-11-15）
// 数据：GET /api/pipeline-history（logs[] / summary / asOf）。
// 口径：summary.total=200 为 limit 窗口条数（非全量）；无「自动化任务定义/调度表」接口 → 定时任务来源为页面常量，
//       调度状态/上次运行对应关系 n/a + 原因（不伪造）。
import { useMemo, useState } from "react";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import type { Metric } from "@/components/bento/types";
import { Chips, KpiTile, Note, Pager, States, Toolbar, Tone, usePhaseOverride, useResource } from "../_components/bento-kit";
import kit from "../_components/bento-kit.module.css";
import { fmtNum, fmtTime } from "@/lib/format";

interface LogRow { id: string; sourceType: string; sourcePath?: string; status: string; recordsSynced: number; runMode: string; startedAt: string; completedAt?: string }
interface History { logs?: LogRow[]; summary?: { total: number; completed: number; failed: number }; asOf?: string }
interface CronRow { name: string; schedule: string; cron: string; desc: string }

const CRONS: CronRow[] = [
  { name: "lions-pipeline-hermes", schedule: "每 15 分钟", cron: "*/15 * * * *", desc: "Hermes 流水线增量摄取（会话/消息 → 记忆）" },
  { name: "lions-sync-cron", schedule: "每 10 分钟", cron: "*/10 * * * *", desc: "同步 4 类来源（会话、消息、待办、产物）" },
  { name: "lions-daily-reflect", schedule: "每天 23:50", cron: "50 23 * * *", desc: "每日反思提炼与汇总" },
];
const PAGE_SIZE = 20;

function duration(l: LogRow): string {
  if (!l.startedAt || !l.completedAt) return "n/a";
  const a = new Date(l.startedAt).getTime();
  const b = new Date(l.completedAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "n/a";
  return Math.max(0, Math.round((b - a) / 1000)) + " 秒";
}

export default function AutomationPage() {
  const res = useResource<History>("/api/pipeline-history", { pollMs: 60000 });
  const forced = usePhaseOverride();
  const phase = forced && forced !== "ok" ? forced : res.phase;
  const logs = res.data?.logs ?? [];
  const summary = res.data?.summary;
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(logs.length / PAGE_SIZE));
  const cur = Math.min(page, pages - 1);

  const lastRun = useMemo(() => {
    let t = 0;
    for (const l of logs) { const v = new Date(l.startedAt || "").getTime(); if (Number.isFinite(v) && v > t) t = v; }
    return t ? new Date(t).toISOString() : null;
  }, [logs]);
  const successRate = summary && summary.total > 0 ? ((summary.completed / summary.total) * 100).toFixed(1) + "%" : null;

  const k = (v: number | null, hint: string, tone?: "info" | "ok" | "crit"): Metric =>
    v == null ? { kind: "na", reason: hint } : { kind: "value", value: fmtNum(v), hint, tone: tone || "info" };

  const cronCols: DataColumn<CronRow>[] = [
    { key: "name", title: "任务", width: 190, render: (c) => <b className={kit.mono}>{c.name}</b> },
    { key: "schedule", title: "触发", width: 120, render: (c) => c.schedule },
    { key: "cron", title: "定时表达式", width: 130, render: (c) => <span className={kit.mono}>{c.cron}</span> },
    { key: "desc", title: "说明", render: (c) => c.desc },
    { key: "status", title: "调度状态", width: 110, render: () => <Tone tone="mute">n/a（无调度接口）</Tone> },
  ];
  const logCols: DataColumn<LogRow>[] = [
    { key: "time", title: "时间", width: 170, render: (l) => <span className={kit.mono}>{l.startedAt ? fmtTime(l.startedAt) : "n/a"}</span> },
    { key: "mode", title: "模式", width: 150, render: (l) => <span className={kit.mono}>{l.runMode || "n/a"}</span> },
    { key: "source", title: "来源", render: (l) => l.sourceType || "n/a" },
    { key: "synced", title: "同步", align: "right", width: 110, render: (l) => <span className={kit.num}>{fmtNum(l.recordsSynced)}</span> },
    { key: "status", title: "状态", width: 110, render: (l) => <Tone tone={l.status === "COMPLETED" ? "ok" : "crit"}>{l.status === "COMPLETED" ? "完成" : "失败"}</Tone> },
    { key: "dur", title: "耗时", align: "right", width: 90, render: (l) => <span className={kit.num}>{duration(l)}</span> },
  ];

  return (
    <main className="page">
      <h1 className={kit.srOnly}>自动化执行</h1>
      <PageHeader>
        <PageTitle>自动化执行</PageTitle>
        <div className="page-subtitle">
          定时任务与最近执行 · 窗口内统计 · 数据时刻 {res.data?.asOf ? fmtTime(res.data.asOf) : "n/a（接口未下发）"}
        </div>
        <Chips group="系统" page="自动化" />
      </PageHeader>

      <States phase={phase} endpoint="GET /api/pipeline-history" error={res.error} status={res.status} onRetry={res.reload}
        emptyTitle="无自动化" emptyDetail="接口正常返回但没有任何运行记录（空集，不是不可得）。"
        unavailableTitle="自动化数据不可得" unavailableDetail="pipeline-history 未返回 logs；补齐路径：BFF 输出 logs[]。" />

      {phase === "ok" && (
        <BentoGrid>
          <KpiTile span={3} label="自动化任务" metric={k(CRONS.length, "页面常量；无调度清单接口")} />
          <KpiTile span={3} label="总执行（窗口内）" metric={k(summary?.total, "summary.total；limit 窗口条数，非全量")} />
          <KpiTile span={3} label="失败（窗口内）" metric={k(summary?.failed, "FAILED 行数", "crit")} />
          <KpiTile span={3} label="成功率（窗口内）" metric={successRate ? { kind: "value", value: successRate, hint: "成功/总运行，仅本窗口" } : { kind: "na", reason: "summary.total 缺失或为 0（不能算 0%）" }} />

          <BentoCard span={8} title="定时任务" sub="来源：页面常量（源码） · 无调度接口可核状态">
            <DataTable<CronRow> columns={cronCols} rows={CRONS} rowKey={(c) => c.name} />
          </BentoCard>

          <BentoCard span={4} title="调度摘要">
            <ul className={kit.kv}>
              <li><span>最近一次运行</span><b>{lastRun ? fmtTime(lastRun) : "n/a（窗口内无记录）"}</b></li>
              <li><span>窗口内成功 / 失败</span><b>{summary ? fmtNum(summary.completed) + " / " + fmtNum(summary.failed) : "n/a"}</b></li>
              <li><span>窗口上限</span><b>{summary ? fmtNum(summary.total) + " 条（limit，不是全量）" : "n/a"}</b></li>
              <li><span>调度器状态</span><b>n/a —— 无「调度定义/状态」接口</b></li>
            </ul>
            <Note>「定时任务」是页面登记的系统作业，不是接口返回；其启用/暂停状态不可从本批端点复算。</Note>
          </BentoCard>

          <BentoCard span={12} title="最近执行记录" sub={"窗口内 " + fmtNum(logs.length) + " 行 · 每页 " + PAGE_SIZE + " 条"}>
            <Toolbar right="只读 · GET /api/pipeline-history" />
            <DataTable<LogRow> columns={logCols} rows={logs.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE)} rowKey={(l, i) => l.id || cur * PAGE_SIZE + i}
              empty={{ title: "无执行记录", desc: "窗口内没有运行记录（空集）。" }} />
            <Pager page={cur} pages={pages} onPage={setPage} totalText={"窗口内 " + fmtNum(logs.length) + " 行 · 第 " + (cur + 1) + " / " + pages + " 页"} />
          </BentoCard>

          <BentoCard span={12} title="口径与缺口">
            <ul className={kit.kv}>
              <li><span>总执行 200</span><b>summary.total 是 BFF 本次返回的 limit 窗口条数，不是累计执行总数；不得写「总执行 200」。真总量需 BFF 补。</b></li>
              <li><span>定时任务清单 / 调度状态</span><b>n/a —— 无自动化任务定义或调度表接口（补齐需新 BFF）；页面仅登记 3 个已知系统作业。</b></li>
              <li><span>「上次运行」对应关系</span><b>n/a —— 运行记录与定时任务（常量）之间无任务标识可关联，故不逐任务填「上次」。</b></li>
            </ul>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}