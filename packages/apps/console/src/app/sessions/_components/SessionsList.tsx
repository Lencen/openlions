"use client";
// /sessions · 列表主体（P1 试点页 ord-20261104-032）
// 为什么是独立 client 岛：本页是**服务端取数**（page.tsx 里的 bffGet，force-dynamic；curl 到的 SSR HTML
// 必须含会话行）。搜索/筛选/排序需要状态，因此只把「呈现+交互」下沉到这个岛，
// 取数、分页参数、端点一概不动。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Select } from "@/components/primitives";
import { DataTable, StateChip, FilterBar } from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import TableCopyButton from "@/components/TableCopyButton";
import RowClick from "./RowClick";
import styles from "../page.module.css";

export interface SessionItem {
  session_uid: string;
  agent_id: string;
  source: string | null;
  title: string | null;
  message_count: number;
  status: string;
  updated_at?: string | null;
  uploaded_at?: string | null;
}

// 状态键 → 中文 + StateChip 的 state（与改前同一套映射；界面不出现裸英文状态值）。
const STATUS: Record<string, { text: string; state: "ok" | "warn" | "crit" | "idle" }> = {
  DONE: { text: "已提炼", state: "ok" },
  PROCESSED: { text: "已提炼", state: "ok" },
  PENDING: { text: "待提炼", state: "warn" },
  FAILED: { text: "提炼失败", state: "crit" },
  SKIPPED: { text: "已跳过", state: "idle" },
  RUNNING: { text: "进行中", state: "warn" },
};
const SOURCE_LABEL: Record<string, string> = {
  HERMES_SESSION: "Hermes 会话",
  OPENCLAW_SESSION: "OpenClaw 会话",
  CLAUDE_SESSION: "Claude 会话",
  CLAUDE_CODE: "Claude Code",
  MANUAL: "手工录入",
  SESSION_EXTRACT: "会话提炼",
};
function statusOf(status: string) {
  return STATUS[String(status || "").toUpperCase()] || { text: String(status || "未知"), state: "idle" as const };
}
function sourceOf(source?: string | null) {
  if (!source) return "—";
  return SOURCE_LABEL[source] || source;
}

const FILTERS = [
  { key: "ALL", label: "全部" },
  { key: "ok", label: "已提炼" },
  { key: "warn", label: "待提炼" },
  { key: "crit", label: "提炼失败" },
  { key: "idle", label: "已跳过" },
] as const;

const SORTS = [
  { value: "updated", label: "更新时间倒序（默认）" },
  { value: "messages", label: "消息数降序" },
  { value: "agent", label: "智能体 A→Z" },
];

export default function SessionsList({
  items,
  total,
  page,
  pages,
}: {
  items: SessionItem[];
  total: number;
  page: number;
  pages: number;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [qApplied, setQApplied] = useState("");
  const [filter, setFilter] = useState<string>("ALL");
  const [sort, setSort] = useState<string>("updated");

  useEffect(() => {
    const id = setTimeout(() => setQApplied(q.trim().toLowerCase()), 250);
    return () => clearTimeout(id);
  }, [q]);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const v = sp.get("q");
      if (v) {
        setQ(v);
        setQApplied(v.trim().toLowerCase());
      }
      const sv = sp.get("sort");
      if (sv && SORTS.some((s) => s.value === sv)) setSort(sv);
    } catch { /* 忽略 */ }
  }, []);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (qApplied) sp.set("q", qApplied);
      else sp.delete("q");
      sp.set("sort", sort); // 排序进 URL（?sort=），返回 / 刷新不丢；page 参数原样保留
      const qs = sp.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
    } catch { /* 忽略 */ }
  }, [qApplied, sort]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: items.length, ok: 0, warn: 0, crit: 0, idle: 0 };
    for (const s of items) c[statusOf(s.status).state] += 1;
    return c;
  }, [items]);

  const rows = useMemo(() => {
    const kw = qApplied;
    const list = items.filter((s) => {
      if (filter !== "ALL" && statusOf(s.status).state !== filter) return false;
      if (!kw) return true;
      const hay = [s.title, s.agent_id, s.session_uid, statusOf(s.status).text, sourceOf(s.source)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(kw);
    });
    const at = (s: SessionItem) => new Date(s.updated_at ?? s.uploaded_at ?? 0).getTime() || 0;
    return list.slice().sort((a, b) => {
      if (sort === "messages") return (b.message_count || 0) - (a.message_count || 0);
      if (sort === "agent") return String(a.agent_id || "").localeCompare(String(b.agent_id || ""));
      return at(b) - at(a);
    });
  }, [items, filter, qApplied, sort]);

  const hrefOf = (s: SessionItem) => "/sessions/detail?id=" + encodeURIComponent(s.session_uid);

  // 「平均回合时长」口径待补（数据卡 卡6 §8）：TODO 字典暂无该口径，补齐前不加列、不编数字。
  const columns: DataColumn<SessionItem>[] = [
    {
      key: "title",
      title: "会话",
      render: (s) => (
        <span>
          <Link href={hrefOf(s)} className={styles.cellLink}>{s.title ?? s.session_uid ?? "—"}</Link>
          <span className="dt-who-sub mono">{s.session_uid}</span>
        </span>
      ),
    },
    {
      key: "agent",
      title: "智能体",
      width: "160px",
      render: (s) => (
        <Link href={"/agents/detail?agentId=" + encodeURIComponent(s.agent_id)} className={styles.cellLink}>
          {s.agent_id}
        </Link>
      ),
    },
    { key: "source", title: "来源", width: "130px", render: (s) => sourceOf(s.source) },
    { key: "messages", title: "消息", width: "88px", align: "right", render: (s) => s.message_count ?? 0 },
    {
      key: "status",
      title: "状态",
      width: "110px",
      render: (s) => {
        const st = statusOf(s.status);
        return <StateChip state={st.state} text={st.text} />;
      },
    },
    {
      key: "updated",
      title: "更新",
      width: "110px",
      align: "right",
      render: (s) => <span className="mono nowrap">{(s.updated_at ?? s.uploaded_at ?? "").slice(0, 10) || "—"}</span>,
    },
    {
      key: "open",
      title: "",
      width: "48px",
      align: "right",
      render: (s) => (
        <Link className={styles.rowLink} href={hrefOf(s)} title="查看会话详情" aria-label="查看会话详情">›</Link>
      ),
    },
  ];

  return (
    <>
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQ("");
            if (e.key === "Enter") setQApplied(q.trim().toLowerCase());
          }}
          placeholder="搜索标题 / 智能体 / 会话编号"
          aria-label="搜索会话：标题、智能体、会话编号"
        />
        <FilterBar
          items={FILTERS.map((f) => ({ key: f.key, label: f.label, count: counts[f.key] || 0 }))}
          active={filter}
          onSelect={setFilter}
          right={<>本页 {rows.length} / {items.length} 条（筛选后）· 共 {total.toLocaleString()} 条 · 只读</>}
        />
      </div>
      <div className={styles.subToolbar}>
        <span>排序</span>
        <Select
          ariaLabel="排序方式"
          className={styles.sortSelect}
          value={sort}
          onChange={(v: any) => setSort(String(v || "updated"))}
          options={SORTS}
        />
        <span>筛排只作用于本页 {items.length} 条（服务端分页未改）；「时长」口径待数据卡补齐</span>
        {/* 数据展示规范 §2：每张表提供复制/导出（自动定位本按钮之后最近的一张表） */}
        <TableCopyButton />
      </div>

      <RowClick className={styles.clickable} onPick={(i) => { const s = rows[i]; if (s) router.push(hrefOf(s)); }}>
        <DataTable
          rows={rows}
          rowKey={(s: SessionItem, i: number) => s.session_uid || i}
          empty={{
            title: qApplied ? "没有匹配的会话" : "本页没有会话",
            desc: qApplied
              ? "标题 / 智能体 / 会话编号里都没有匹配项 —— 清空搜索或切换状态筛选。"
              : "接口返回 0 条（共 " + total.toLocaleString() + " 条，第 " + page + "/" + pages + " 页）。触发条件：会话 updatedAt 距今 ≥15 分钟、或数据同步有延迟。历史会话可用下方翻页查看。",
            action: qApplied ? (
              <button type="button" className="btn" onClick={() => setQ("")}>清除搜索</button>
            ) : page < pages ? (
              <Link className="btn" href={"/sessions?page=" + (page + 1)}>查看下一页历史会话 →</Link>
            ) : (
              <a className="btn" href="/sessions">刷新</a>
            ),
          }}
          columns={columns}
        />
      </RowClick>
    </>
  );
}
