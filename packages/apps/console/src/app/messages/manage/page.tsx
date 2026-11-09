"use client";
// 2026-10-21 消息管理表格（只读）：跨会话筛选 + 游标分页。
// 与 /messages 的分工：那边是"按会话读上下文"，这边是"跨会话找问题消息"。
// 2026-11-05 P2 批8（呈现层）：内联 style 清零 + 手写 .tbl 裸表 → 白名单 @/components/DataTable；
//   列/字段/文案/交互（筛选、保存视图、导出 CSV、改派、翻页）一字未改。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./page.module.css";

const TRANSPORT_OPTS = [["", "全部传输态"], ["delivered", "已送达"], ["read", "已读"], ["expired", "已过期"], ["failed", "投递失败"]] as const;
const BRAIN_OPTS = [["", "全部处理态"], ["pending", "未处理"], ["read", "已读未回"], ["replied", "已回复"]] as const;
const SINCE_OPTS = [["0", "全部时间"], ["24", "近 24 小时"], ["168", "近 7 天"]] as const;

const fmtAt = (iso: string | null): string => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—");

export default function MessagesManagePage() {
  const [transport, setTransport] = useState("");
  const [brain, setBrain] = useState("");
  const [since, setSince] = useState("0");
  const [q, setQ] = useState("");
  const [kw, setKw] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  // 2026-10-21 保存视图（localStorage，纯前端）+ 导出 CSV（不依赖后端）
  const [views, setViews] = useState<{ name: string; transport: string; brain: string; since: string; q: string }[]>([]);
  useEffect(() => {
    try { const raw = localStorage.getItem("macs.manage.views"); if (raw) setViews(JSON.parse(raw)); } catch {}
  }, []);
  const saveView = () => {
    const name = window.prompt("给这个筛选起个名字（例如：24h 过期）", "");
    if (!name) return;
    const next = views.filter((v) => v.name !== name).concat([{ name, transport, brain, since, q: kw }]);
    setViews(next);
    try { localStorage.setItem("macs.manage.views", JSON.stringify(next)); } catch {}
  };
  const applyView = (v: { transport: string; brain: string; since: string; q: string }) => {
    setTransport(v.transport); setBrain(v.brain); setSince(v.since); setQ(v.q); setKw(v.q);
  };
  const exportCsv = () => {
    const head = ["时间", "会话", "发送方", "摘要", "传输态", "处理态", "引用", "最后错误"];
    const esc = (s: any) => '"' + String(s ?? "").replace(/"/g, '""') + '"';
    const lines = [head.map(esc).join(",")].concat(rows.map((m) => [fmtAt(m.at), m.conversation, m.from, m.text, m.transport, m.brain, m.replyTo ? "有" : "", m.lastError || ""].map(esc).join(",")));
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "macs-messages-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  // 2026-10-21 改派：admin 写操作，必须填原因（审计），提交后刷新列表
  const [assignRow, setAssignRow] = useState<any | null>(null);
  const [assignTo, setAssignTo] = useState("");
  const [assignNote, setAssignNote] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignMsg, setAssignMsg] = useState<string | null>(null);
  const doAssign = async () => {
    if (!assignRow || !assignTo.trim() || !assignNote.trim()) return;
    setAssignBusy(true);
    setAssignMsg(null);
    try {
      const r = await fetch("/api/macs/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: assignRow.id, assignedTo: assignTo.trim(), note: assignNote.trim(), confirm: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) {
        setAssignMsg("已改派给 " + assignTo.trim() + (j.result?.unchanged ? "（原本就是此人）" : ""));
        // 后端交接明确要求：assign 不会广播给其它页面，成功后要主动 refetch list/trace
        setRefreshTick((n) => n + 1);
        window.dispatchEvent(new CustomEvent("macs:new-message"));
        setAssignRow(null);
        setAssignTo("");
        setAssignNote("");
      } else {
        setAssignMsg("改派失败：" + (j.error || j.result?.error || ("状态码 " + r.status)));
      }
    } catch (e: any) {
      setAssignMsg("改派失败：" + String(e?.message || e));
    } finally {
      setAssignBusy(false);
    }
  };

  const buildUrl = (before?: number | null) => {
    const u = new URLSearchParams();
    u.set("limit", "50");
    if (transport) u.set("transport", transport);
    if (brain) u.set("brain", brain);
    if (since !== "0") u.set("since", since);
    if (kw) u.set("q", kw);
    if (before) u.set("before_seq", String(before));
    return "/api/macs/manage?" + u.toString();
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(buildUrl(null))
      .then((r) => r.json())
      .then((j) => { if (!cancelled && j?.ok) { setRows(j.messages || []); setTotal(j.total || 0); setNextBefore(j.nextBefore ?? null); } })
      .catch(() => { if (!cancelled) { setRows([]); setTotal(0); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, brain, since, kw, refreshTick]);

  const loadMore = () => {
    if (!nextBefore) return;
    setLoading(true);
    fetch(buildUrl(nextBefore))
      .then((r) => r.json())
      .then((j) => { if (j?.ok) { setRows((prev) => prev.concat(j.messages || [])); setNextBefore(j.nextBefore ?? null); } })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  // 2026-11-05 P2 批8：列与改前 <thead> 逐列对应（时间/会话/发送方/摘要/传输态/处理态/引用/最后错误/操作）；
  //   本页是客户端组件（文件头 "use client"），可以传函数列；服务端页面请改用预渲染单元格。
  const columns: DataColumn<any>[] = [
    { key: "at", title: "时间", render: (m) => <span className="mono">{fmtAt(m.at)}</span> },
    { key: "conversation", title: "会话", render: (m) => m.conversation },
    { key: "from", title: "发送方", render: (m) => <span className="mono">{m.from}</span> },
    { key: "text", title: "摘要", render: (m) => <span className={styles.clip} title={m.text}>{m.text}</span> },
    {
      key: "transport", title: "传输态",
      render: (m) => <span className={"msg-pill t-" + (m.transport || "queued")}>{m.transport === "expired" ? "已过期" : m.transport === "failed" ? "投递失败" : m.transport === "read" ? "已读" : "已送达"}</span>,
    },
    {
      key: "brain", title: "处理态",
      render: (m) => <span className={"msg-pill b-" + (m.brain || "unreplied")}>{m.brain === "replied" ? "已回复" : m.brain === "read" ? "已读未回" : "未处理"}</span>,
    },
    { key: "replyTo", title: "引用", render: (m) => <span className="mono">{m.replyTo ? "有" : "—"}</span> },
    { key: "lastError", title: "最后错误", render: (m) => <span className={styles.clip} title={m.lastError || ""}>{m.lastError || "—"}</span> },
    {
      key: "op", title: "操作",
      render: (m) => (
        <button className="msg-ghost" onClick={() => { setAssignRow(m); setAssignTo(""); setAssignNote(""); setAssignMsg(null); }}>改派</button>
      ),
    },
  ];

  return (
    <main className="page">
      <div className="breadcrumb"><span className={styles.crumbDim}>服务</span><span className="sep">/</span><span className={styles.crumbDim}>消息</span><span className="sep">/</span><span className="current">管理</span></div>
      <PageHeader>
        <PageTitle>消息管理</PageTitle>
        <div className="page-subtitle">会话与消息的治理操作入口</div>
      </PageHeader>
      <div className="msg-manage-bar">
        <select className="msg-select" value={transport} onChange={(e) => setTransport(e.target.value)}>
          {TRANSPORT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="msg-select" value={brain} onChange={(e) => setBrain(e.target.value)}>
          {BRAIN_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="msg-select" value={since} onChange={(e) => setSince(e.target.value)}>
          {SINCE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input className={"msg-input " + styles.searchInput} placeholder="搜索会话 / 发送方 / 正文"
          value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setKw(q.trim()); }} />
        <button className="msg-ghost" onClick={() => setKw(q.trim())}>搜索</button>
        <button className="msg-ghost" onClick={saveView} title="把当前筛选存为常用视图">保存视图</button>
        {views.length ? (
          <select className="msg-select" value="" onChange={(e) => { const v = views.find((x) => x.name === e.target.value); if (v) applyView(v); }}>
            <option value="">已保存视图…</option>
            {views.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
        ) : null}
        <button className="msg-ghost" onClick={exportCsv} disabled={rows.length === 0} title="导出当前结果（最多 50 行/页）">导出 CSV</button>
        <span className="msg-count">共 {total} 条</span>
        <Link href="/messages" className={"msg-ghost " + styles.barEnd}>返回消息工作区</Link>
      </div>
      {loading && rows.length === 0 ? <div className="msg-empty">正在读取…</div> : rows.length === 0 ? (
        <div className="msg-empty">没有符合条件的消息</div>
      ) : (
        <div className={styles.tableScroll}>
          {/* 2026-11-05 P2 批8：裸 .tbl → 白名单 DataTable（行 key 取消息 id，客户端组件可传函数） */}
          <DataTable columns={columns} rows={rows} rowKey={(m) => String(m.id)} />
        </div>
      )}
      {assignRow ? (
        <div className="msg-trace-mask" role="dialog" aria-modal="true" aria-label="改派负责人" onClick={() => setAssignRow(null)}>
          <div className="msg-assign-card" onClick={(e) => e.stopPropagation()}>
            <div className={"msg-trace-title " + styles.cardHead}>改派负责人</div>
            <div className={"msg-ctx-sub " + styles.cardLine}>消息：{assignRow.text || assignRow.id}</div>
            <input className="msg-input" placeholder="负责人（填智能体名，如 agent-x / agent-x）" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} />
            <input className={"msg-input " + styles.fieldGap} placeholder="改派原因（必填，会进审计）" value={assignNote} onChange={(e) => setAssignNote(e.target.value)} />
            {assignMsg ? <div className={"msg-ctx-sub " + styles.assignMsg}>{assignMsg}</div> : null}
            <div className={styles.cardActions}>
              <button className="msg-ghost" onClick={() => setAssignRow(null)}>取消</button>
              <button className="msg-ghost" disabled={assignBusy || !assignTo.trim() || !assignNote.trim()} onClick={doAssign}>{assignBusy ? "提交中…" : "确认改派"}</button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="msg-manage-foot">
        {nextBefore ? <button className="msg-ghost" onClick={loadMore} disabled={loading}>{loading ? "加载中…" : "加载更多"}</button> : <span className="msg-count">已经到底了</span>}
        <span className={"msg-trace-foot " + styles.footPlain}>只读：重放 / 改派请在通信服务管理端执行。</span>
      </div>
    </main>
  );
}
