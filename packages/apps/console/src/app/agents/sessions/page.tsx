"use client";
// 0.5.1 B5-13 /agents/sessions · Bento P1 列表（2026-11-15）
// 数据：GET /api/session-stats（总数/状态/来源/按智能体）+ GET /api/session-list?page&pageSize（分页列表）。
// 口径：**agent 级会话**，与 /messages/session 的消息会话口径不同，不得混用在线数；
//       列表条数用 list、总数用 stats；在线/陈旧字段本接口没有 → n/a + 原因（不写 0）。
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import BentoGrid from "@/components/bento/BentoGrid";
import BentoCard from "@/components/bento/BentoCard";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { BentoState } from "@/components/bento";
import type { Metric } from "@/components/bento/types";
import { Chips, KpiTile, Note, Pager, States, Tone, usePhaseOverride, useResource } from "../../system/_components/bento-kit";
import kit from "../../system/_components/bento-kit.module.css";
import { fmtNum, fmtTime } from "@/lib/format";

interface Stats {
  result?: { data?: { total: number; byStatus: Record<string, number>; bySource: Record<string, number>; byAgent: { agent_id: string; count: number }[]; pending24h: number; totalSizeKb: number } };
  asOf?: string;
}
interface Row {
  session_uid: string; agent_id: string; source: string; title: string | null;
  message_count: number; status: string; uploaded_at: string; updated_at: string; last_message_at?: string;
}
interface ListResp { result?: { data?: { items?: Row[]; total: number } }; asOf?: string }

const PAGE_SIZE = 10;
const STATUS_LABEL: Record<string, string> = { DONE: "已提炼", PROCESSED: "已提炼", PENDING: "待处理", FAILED: "失败", SKIPPED: "已跳过" };
const toneOf = (s: string): "ok" | "warn" | "crit" | "mute" => s === "DONE" || s === "PROCESSED" ? "ok" : s === "PENDING" ? "warn" : s === "FAILED" ? "crit" : "mute";

export default function SessionsPage() {
  const stats = useResource<Stats>("/api/session-stats");
  const [page, setPage] = useState(1);
  const list = useResource<ListResp>("/api/session-list?page=" + page + "&pageSize=" + PAGE_SIZE);
  const forced = usePhaseOverride();
  const st = stats.data?.result?.data;
  const items = list.data?.result?.data?.items ?? [];
  const listTotal = list.data?.result?.data?.total ?? null;
  const phases = [stats.phase, list.phase];
  const combined = phases.includes("forbidden") ? "forbidden" : phases.includes("error") ? "error" : phases.includes("loading") ? "loading" : st && st.total === 0 ? "empty" : "ok";
  const phase = forced && forced !== "ok" ? forced : combined;
  const pages = listTotal != null ? Math.max(1, Math.ceil(listTotal / PAGE_SIZE)) : 1;

  const k = (v: number | null | undefined, hint: string, tone?: "info" | "ok" | "warn" | "crit"): Metric =>
    v == null ? { kind: "na", reason: "接口未返回该字段" } : { kind: "value", value: fmtNum(v), hint, tone: tone || "info" };
  const done = (st?.byStatus?.DONE || 0) + (st?.byStatus?.PROCESSED || 0);

  const cols: DataColumn<Row>[] = [
    { key: "uid", title: "会话", width: 300, render: (r) => <span className={kit.mono}>{r.session_uid ? r.session_uid.slice(0, 52) : "n/a"}</span> },
    { key: "agent", title: "智能体", width: 150, render: (r) => <span className={kit.mono}>{r.agent_id || "n/a"}</span> },
    { key: "source", title: "来源", width: 140, render: (r) => r.source || "n/a" },
    { key: "title", title: "标题", render: (r) => <span title={r.title || ""}>{r.title || "n/a"}</span> },
    { key: "msgs", title: "消息", align: "right", width: 80, render: (r) => <span className={kit.num}>{fmtNum(r.message_count)}</span> },
    { key: "status", title: "状态", width: 100, render: (r) => <Tone tone={toneOf(r.status)}>{STATUS_LABEL[r.status] || r.status || "n/a"}</Tone> },
    { key: "updated", title: "更新时间", width: 170, render: (r) => <span className={kit.mono}>{r.updated_at || r.uploaded_at ? fmtTime(r.updated_at || r.uploaded_at) : "n/a"}</span> },
  ];

  const statusBars = Object.entries(st?.byStatus || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const sourceBars = Object.entries(st?.bySource || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const agentBars = (st?.byAgent || []).slice(0, 6);
  const maxOf = (arr: [string, number][]) => Math.max(1, ...arr.map(([, n]) => n));
  const maxAgent = Math.max(1, ...agentBars.map((a) => a.count));

  return (
    <main className="page">
      <h1 className={kit.srOnly}>会话归档</h1>
      <PageHeader>
        <PageTitle>会话归档</PageTitle>
        <div className="page-subtitle">
          <b>智能体级会话</b>（与消息会话口径不同，不混用在线上） · 数据时刻 {stats.data?.asOf ? fmtTime(stats.data.asOf) : "请求时刻"}
        </div>
        <Chips group="智能体" page="会话" />
      </PageHeader>

      <States phase={phase} endpoint="GET /api/session-stats · GET /api/session-list" error={stats.error || list.error} status={stats.status || list.status} onRetry={() => { stats.reload(); list.reload(); }}
        emptyTitle="无会话" emptyDetail="会话统计接口正常返回但总数为 0（空集，不是不可得）。"
        unavailableTitle="会话数据不可得" unavailableDetail="session-stats 未返回 result.data；补齐路径：BFF 输出统计对象。" />

      {phase === "ok" && (
        <BentoGrid>
          <KpiTile span={3} label="会话总数" metric={k(st?.total, "会话统计 total（智能体级）")} />
          <KpiTile span={3} label="待处理（24h）" metric={k(st?.pending24h, "pending24h · PENDING 且近 24h", "warn")} />
          <KpiTile span={3} label="失败" metric={k(st?.byStatus?.FAILED, "byStatus.FAILED", "crit")} />
          <KpiTile span={3} label="已提炼" metric={k(done, "DONE + PROCESSED")} />

          <BentoCard span={12} title="会话列表" sub={"每页 " + PAGE_SIZE + " 条 · 总数 " + fmtNum(st?.total) + "（stats） · 本页 " + fmtNum(items.length) + " 条（list）"}>
            <DataTable<Row> columns={cols} rows={items} rowKey={(r) => r.session_uid}
              empty={{ title: "暂无会话", desc: "当前页没有会话（空集，不是不可得）。" }} />
            <Pager page={page - 1} pages={pages} onPage={(p) => setPage(p + 1)}
              totalText={"共 " + fmtNum(listTotal) + " 条（list 总数，与 stats 总数 " + fmtNum(st?.total) + " 分口径） · 第 " + page + " / " + pages + " 页" + (page >= pages ? " · 已到最后一页" : " · 下一页还有 " + fmtNum(Math.max(0, (listTotal || 0) - page * PAGE_SIZE)) + " 条")} />
            <Note>分页口径：列表条数与总数取自 /api/session-list；顶部 KPI 取自 /api/session-stats。两接口总数可能因写入时点略有差异，不互相覆盖。</Note>
          </BentoCard>

          <BentoCard span={4} title="状态分布" sub="按 byStatus">
            {statusBars.length ? (
              <div className={kit.bars}>{statusBars.map(([k2, n]) => (
                <div key={k2} className={kit.barRow}><span>{STATUS_LABEL[k2] || k2}</span><span className={kit.barTrack}><span className={kit.barFill} style={{ width: Math.round((n / maxOf(statusBars as [string, number][])) * 100) + "%" }} /></span><span className={kit.barNum}>{fmtNum(n)}</span></div>
              ))}</div>
            ) : <BentoState phase="empty" title="无状态分布" detail="byStatus 为空（空集）。" />}
          </BentoCard>

          <BentoCard span={4} title="来源分布" sub="按 bySource">
            {sourceBars.length ? (
              <div className={kit.bars}>{sourceBars.map(([k2, n]) => (
                <div key={k2} className={kit.barRow}><span>{k2}</span><span className={kit.barTrack}><span className={kit.barFill} style={{ width: Math.round((n / maxOf(sourceBars as [string, number][])) * 100) + "%" }} /></span><span className={kit.barNum}>{fmtNum(n)}</span></div>
              ))}</div>
            ) : <BentoState phase="empty" title="无来源分布" detail="bySource 为空（空集）。" />}
          </BentoCard>

          <BentoCard span={4} title="按智能体（前六）" sub="按 byAgent">
            {agentBars.length ? (
              <div className={kit.bars}>{agentBars.map((a) => (
                <div key={a.agent_id} className={kit.barRow}><span className={kit.mono}>{a.agent_id}</span><span className={kit.barTrack}><span className={kit.barFill} style={{ width: Math.round((a.count / maxAgent) * 100) + "%" }} /></span><span className={kit.barNum}>{fmtNum(a.count)}</span></div>
              ))}</div>
            ) : <BentoState phase="empty" title="无智能体分布" detail="byAgent 为空（空集）。" />}
          </BentoCard>

          <BentoCard span={12} title="口径与缺口">
            <ul className={kit.kv}>
              <li><span>口径</span><b>本页是智能体级会话（会话统计/会话列表接口）；与消息会话口径不同，不混用在线数。</b></li>
              <li><span>在线 / 陈旧</span><b>n/a —— 会话统计接口无「在线/陈旧」字段（在线数属实时频道口径，本页不借用）。</b></li>
              <li><span>存储</span><b>{st?.totalSizeKb != null ? fmtNum(Math.round(st.totalSizeKb / 1024)) + " MB（stats.totalSizeKb）" : "n/a"}</b></li>
            </ul>
            <Note>相关视图：<Link href="/sessions" className={kit.link}>会话中心</Link> · <Link href="/agents/session-browser" className={kit.link}>会话浏览器</Link> · <Link href="/agents-live" className={kit.link}>智能体实时看板</Link></Note>
          </BentoCard>
        </BentoGrid>
      )}
    </main>
  );
}
