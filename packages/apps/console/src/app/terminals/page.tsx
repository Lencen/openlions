"use client";
// 2026-11-06：/terminals 落地页（014 判据：nav-mapping 里 /terminals 状态为"合并"，必须有页）。
//   设计口径：nav-mapping.json 的 id=terminal —— label「终端」、desc「会话式终端，只读回放 + 受控执行」、type=list、readonly。
//   数据源复用 /api/agent-list（与 /agents/detail、/todo 页头同源）：
//     · 只读：本页不发任何写请求；
//     · 不造假：拿不到的字段显示「未知」+ 原因，终端各层的明细由详情页按 12 层 IA 展示（缺块显示未知）。
//   列表点进 /terminals/detail?agent_id=<id>，与详情页的入参一致。
import { useMemo } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { useApi } from "@/lib/api";
import styles from "./page.module.css";

type AgentRow = {
  agent_id?: string;
  display_name?: string;
  channel?: string;
  host?: string;
  status?: string;
  last_seen_at?: string | null;
  currentTask?: { title?: string } | null;
  lastDone?: { title?: string } | null;
};

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "未知";
  return String(v);
}

function fmtTime(v?: string | null): string {
  if (!v) return "未知";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "未知";
  return d.toLocaleString("zh-CN", { hour12: false });
}

export default function TerminalsPage() {
  const { data, loading, error, mutate } = useApi<{ ok?: boolean; items?: AgentRow[]; asOf?: string; _error?: string }>("/api/agent-list");
  const items = useMemo<AgentRow[]>(() => {
    const raw = data?.items;
    return Array.isArray(raw) ? raw : [];
  }, [data]);

  const columns: DataColumn<AgentRow>[] = [
    {
      key: "name",
      title: "执行体",
      render: (r) => (
        <span className={styles.who}>
          <Link href={"/terminals/detail?agent_id=" + encodeURIComponent(String(r.agent_id || ""))} className={styles.whoName}>
            {fmt(r.display_name || r.agent_id)}
          </Link>
          <span className="tiny">{fmt(r.agent_id)} · {fmt(r.channel)}</span>
        </span>
      ),
    },
    { key: "host", title: "主机", width: 120, render: (r) => <span className="mono">{fmt(r.host)}</span> },
    { key: "status", title: "运行状态", width: 100, render: (r) => <span className="tiny">{fmt(r.status)}</span> },
    {
      key: "currentTask",
      title: "当前任务",
      render: (r) => <span className="truncate">{r.currentTask?.title ? String(r.currentTask.title) : "—"}</span>,
    },
    {
      key: "lastDone",
      title: "最近产物",
      render: (r) => <span className="truncate tiny">{r.lastDone?.title ? String(r.lastDone.title) : "—"}</span>,
    },
    { key: "lastSeen", title: "最近活跃", width: 150, render: (r) => <span className="tiny">{fmtTime(r.last_seen_at)}</span> },
    {
      key: "open",
      title: "操作",
      width: 100,
      render: (r) => (
        <Link href={"/terminals/detail?agent_id=" + encodeURIComponent(String(r.agent_id || ""))} className={styles.openLink}>
          终端详情 →
        </Link>
      ),
    },
  ];

  return (
    <main className="page">
      <div className="breadcrumb">
        <span className={styles.crumbDim}>服务</span>
        <span className="sep">/</span>
        <span className="current">终端</span>
      </div>
      <PageHeader>
        <PageTitle>终端</PageTitle>
        <div className="page-subtitle">会话式终端：按执行体进入只读回放与受控执行</div>
      </PageHeader>

      <div className={"panel " + styles.listPanel}>
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(r, i) => String(r.agent_id || i)}
          loading={loading && !data}
          error={error ? String((error as Error)?.message || error) : (data?._error ? String(data._error) : null)}
          onRetry={() => { mutate(); }}
          empty={{ title: "暂无可查看的执行体", desc: "名单来自智能体注册表；注册后这里会自动出现。" }}
        />
      </div>

      <div className={"tiny " + styles.footNote}>
        只读：本页不提供任何写操作。详情页按 12 层 IA 展示各层数据，取不到的层显示「未知」+ 原因，不填 0。
        {data?.asOf ? <> 数据时刻 {fmtTime(data.asOf)}。</> : null}
      </div>
    </main>
  );
}
