"use client";
// 0.5.1 B5-1 /system/access-log · Bento P1/P4 列表（2026-11-15）
// 数据：GET /api/pipeline-history（logs[] / summary / asOf）。
// 口径：summary.total=200 是本次返回的 limit 窗口条数（不是全量），KPI 标「窗口内」，不写「总运行 200」冒充全量。
// 设计稿列「操作者/动作/对象」接口未提供 → n/a + 原因（本页不伪造）。
import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import type { Metric } from "@/components/bento/types";
import {
  Chips, FilterBtn, KpiTile, Note, Pager, Search, States, Toolbar, Tone, usePhaseOverride, useResource,
} from "../_components/bento-kit";
import kit from "../_components/bento-kit.module.css";
import { fmtTime, fmtNum } from "@/lib/format";

interface LogRow {
  id: string; sourceType: string; sourcePath?: string; status: string;
  recordsSynced: number; recordsSkipped: number; errorMessage?: string | null;
  messageCount: number; runMode: string; startedAt: string; completedAt?: string;
}
interface History { logs?: LogRow[]; summary?: { total: number; completed: number; failed: number; totalRecordsSynced?: number }; asOf?: string }

const PAGE_SIZE = 20;
const statusText = (s: string) => (s === "COMPLETED" ? "完成" : s === "FAILED" ? "失败" : s || "n/a");

function duration(l: LogRow): string {
  if (!l.startedAt || !l.completedAt) return "n/a";
  const a = new Date(l.startedAt).getTime();
  const b = new Date(l.completedAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "n/a";
  const s = Math.max(0, Math.round((b - a) / 1000));
  return s + " 秒";
}

export default function AccessLogPage() {
  const res = useResource<History>("/api/pipeline-history", { pollMs: 60000 });
  const forced = usePhaseOverride();
  const phase = forced && forced !== "ok" ? forced : res.phase;
  const all = res.data?.logs ?? [];
  const summary = res.data?.summary;

  const [status, setStatus] = useState<"ALL" | "COMPLETED" | "FAILED">("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return all.filter((l) =>
      (status === "ALL" || l.status === status) &&
      (!kw || (l.sourceType + " " + (l.sourcePath || "") + " " + l.runMode).toLowerCase().includes(kw))
    );
  }, [all, status, q]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cur = Math.min(page, pages - 1);
  const pageRows = rows.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);

  const kpi = (v: number | null | undefined, hint: string, tone?: "info" | "crit" | "ok"): Metric =>
    v == null ? { kind: "na", reason: "接口未返回该字段" } : { kind: "value", value: fmtNum(v), hint, tone: tone || "info" };
  const rate = summary && summary.total > 0 ? ((summary.completed / summary.total) * 100).toFixed(1) + "%" : null;

  const columns: DataColumn<LogRow>[] = [
    { key: "time", title: "时间", width: 170, render: (l) => <span className={kit.mono}>{l.startedAt ? fmtTime(l.startedAt) : "n/a"}</span> },
    { key: "source", title: "来源", render: (l) => <span>{l.sourceType || "n/a"}{l.sourcePath ? <span className={kit.muted}> · {l.sourcePath.slice(0, 40)}</span> : null}</span> },
    { key: "mode", title: "模式", width: 130, render: (l) => <span className={kit.mono}>{l.runMode || "n/a"}</span> },
    { key: "synced", title: "同步", align: "right", width: 80, render: (l) => <span className={kit.num}>{fmtNum(l.recordsSynced)}</span> },
    { key: "skipped", title: "跳过", align: "right", width: 100, render: (l) => <span className={kit.num}>{fmtNum(l.recordsSkipped)}</span> },
    { key: "status", title: "状态", width: 110, render: (l) => <Tone tone={l.status === "COMPLETED" ? "ok" : "crit"}>{statusText(l.status)}</Tone> },
    { key: "dur", title: "耗时", align: "right", width: 90, render: (l) => <span className={kit.num}>{duration(l)}</span> },
  ];

  return (
    <main className="page" data-slot="system-access-log-page">
      <h1 className={kit.srOnly}>访问日志</h1>
      <PageHeader>
        <PageTitle>访问日志</PageTitle>
        <div className="page-subtitle">
          流水线运行流水 · 窗口内统计 · 数据时刻 {res.data?.asOf ? fmtTime(res.data.asOf) : "n/a（接口未下发）"}
          {summary ? " · 窗口 " + fmtNum(summary.total) + " 条（limit 上限）" : ""}
        </div>
        <Chips group="系统" page="访问日志" />
      </PageHeader>

      <States phase={phase} endpoint="GET /api/pipeline-history" error={res.error} status={res.status} onRetry={res.reload}
        emptyTitle="无访问日志" emptyDetail="接口正常返回但窗口内没有运行记录（空集，不是不可得）。"
        unavailableTitle="访问日志不可得" unavailableDetail="pipeline-history 未返回 logs 字段；补齐路径：BFF 输出 logs[]。" />

      {phase === "ok" && (
        <BentoGrid>
          <KpiTile span={3} label="总运行（窗口内）" metric={kpi(summary?.total, "接口 summary.total；本次 limit 窗口条数，非全量")} />
          <KpiTile span={3} label="成功（窗口内）" metric={kpi(summary?.completed, "COMPLETED 行数", "ok")} />
          <KpiTile span={3} label="失败（窗口内）" metric={kpi(summary?.failed, "FAILED 行数", "crit")} />
          <KpiTile span={3} label="成功率（窗口内）" metric={rate ? { kind: "value", value: rate, hint: "成功/总运行，仅本窗口" } : { kind: "na", reason: "summary.total 缺失或为 0（不能算 0%）" }} />

          <BentoCard span={12} title="运行日志" sub={"窗口内 " + fmtNum(all.length) + " 行 · 窗口上限 " + fmtNum(summary?.total ?? all.length) + " 条（非全量） · 失败 " + fmtNum(summary?.failed ?? 0) + " 条"}>
            <Toolbar right={<span>只读 · 端点 /api/pipeline-history</span>}>
              {([["ALL", "全部"], ["COMPLETED", "成功"], ["FAILED", "失败"]] as const).map(([k, label]) => (
                <FilterBtn key={k} on={status === k} onClick={() => { setStatus(k); setPage(0); }}>{label}</FilterBtn>
              ))}
              <Search value={q} onChange={(v) => { setQ(v); setPage(0); }} placeholder="搜索来源 / 路径 / 模式" />
            </Toolbar>
            <DataTable<LogRow>
              columns={columns}
              rows={pageRows}
              rowKey={(l, i) => l.id || cur * PAGE_SIZE + i}
              empty={{ title: "无匹配记录", desc: "筛选/搜索条件下没有记录；清空筛选可看窗口内全部行。" }}
            />
            <Pager page={cur} pages={pages} onPage={setPage}
              totalText={"窗口内 " + fmtNum(rows.length) + " / " + fmtNum(all.length) + " 行 · 每页 " + PAGE_SIZE + " 条"} />
          </BentoCard>

          <BentoCard span={12} title="口径与缺口">
            <ul className={kit.kv}>
              <li><span>窗口上限</span><b>summary.total={fmtNum(summary?.total ?? 0)} 为 BFF 本次返回条数（limit），不是累计总数；「总运行」不得当全量读。</b></li>
              <li><span>操作者 / 动作 / 对象</span><b>n/a —— /api/pipeline-history 无 actor/action/object 字段；补齐需 BFF 扩展（本批不新增接口）。</b></li>
              <li><span>审计面</span><b>n/a —— console 无 /api/audit 只读接口（实测 404），写路径审计在服务端 AuditLog，页面无可复算只读源。</b></li>
            </ul>
            <Note>相关视图：<Link href="/system/automation" className={kit.link}>自动化执行</Link> · <Link href="/system/guards" className={kit.link}>守门规则</Link>（同源 pipeline-history 与静态注册表，口径见各页）</Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}