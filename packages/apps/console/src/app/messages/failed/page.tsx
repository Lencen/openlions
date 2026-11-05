"use client";
// 2026-10-21 未送达消息（失败/过期 + 未送达队列）—— 只读视图，Phase 2 排障入口
// 设计：不把"投递失败"与"处理未回复"混成一个列表；这里只管**送不到**的消息。
// 2026-11-05 P2 呈现层（批 4/5）：内联 style 清零 + 两张手写 .tbl 表 → 白名单 DataTable。
//   取数（/api/macs/failed、/api/macs/retry、/api/macs/dlq-replay）与两次点击确认的语义一字未改；
//   两张表的表头（时间/会话/发送方/摘要/状态/最后错误/操作 、时间/目标/消息/原因/操作）也一字未改。
import { useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { PageHero } from "@/components/ui";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./page.module.css";

const fmtAt = (iso: string | null): string => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—");

export default function FailedMessagesPage() {
  const { data, loading } = useApi<any>("/api/macs/failed");
  // 2026-10-21 重试是**真实写操作**：两次点击（第一次只是"准备"，第二次才发），并显示结果。
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // 未送达队列重放（admin 写操作，同样两次点击）
  const [dlqPending, setDlqPending] = useState<number | null>(null);
  const [dlqBusy, setDlqBusy] = useState<number | null>(null);
  const doReplay = async (id: number) => {
    setDlqBusy(id);
    setMsg(null);
    try {
      const r = await fetch("/api/macs/dlq-replay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, confirm: true }) });
      const j = await r.json().catch(() => ({}));
      setMsg(j.ok ? "已重放并重新入队" : "重放失败：" + (j.error || j.result?.error || ("状态码 " + r.status)));
    } catch (e: any) {
      setMsg("重放失败：" + String(e?.message || e));
    } finally {
      setDlqBusy(null);
      setDlqPending(null);
    }
  };
  const doRetry = async (id: string) => {
    setBusy(id);
    setMsg(null);
    try {
      const r = await fetch("/api/macs/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: id, confirm: true }) });
      const j = await r.json().catch(() => ({}));
      setMsg(j.ok ? "已重新入队（" + (j.result?.action || "已重试") + "）" : "重试失败：" + (j.error || j.result?.error || ("状态码 " + r.status)));
    } catch (e: any) {
      setMsg("重试失败：" + String(e?.message || e));
    } finally {
      setBusy(null);
      setPending(null);
    }
  };
  const s = data?.summary || { expired: 0, failed: 0, queue: 0 };
  const messages: any[] = data?.messages || [];
  const queue: any[] = data?.queue || [];

  // 未送达明细的列：与改前 <thead> 逐列对应
  const messageColumns: DataColumn<any>[] = [
    { key: "at", title: "时间", render: (m) => <span className="mono">{fmtAt(m.at)}</span> },
    { key: "conversation", title: "会话", render: (m) => m.conversation },
    { key: "from", title: "发送方", render: (m) => <span className="mono">{m.from}</span> },
    { key: "text", title: "摘要", render: (m) => <span className={styles.clip} title={m.text}>{m.text}</span> },
    {
      key: "transport", title: "状态",
      render: (m) => <span className={"msg-pill t-" + (m.transport === "failed" ? "failed" : "expired")}>{m.transport === "failed" ? "投递失败" : "已过期"}</span>,
    },
    { key: "lastError", title: "最后错误", render: (m) => <span className={styles.clip} title={m.lastError || ""}>{m.lastError || "—"}</span> },
    {
      key: "op", title: "操作",
      render: (m) => (
        /* 2026-10-21：重试是真实写操作，二次确认后才发；只对失败/过期消息开放（其余状态后端返回 409，我们提前拦） */
        pending === m.id ? (
          <span className={styles.inlineBtns}>
            <button className={"msg-ghost " + styles.ghostDanger} disabled={busy === m.id} onClick={() => doRetry(m.id)}>
              {busy === m.id ? "提交中…" : "确认重试"}
            </button>
            <button className="msg-ghost" onClick={() => setPending(null)}>取消</button>
          </span>
        ) : (
          <button className="msg-ghost" onClick={() => { setPending(m.id); setMsg(null); }} title="会真实重新投递这条消息">重试</button>
        )
      ),
    },
  ];

  // 未送达队列的列：与改前 <thead> 逐列对应
  const queueColumns: DataColumn<any>[] = [
    { key: "at", title: "时间", render: (q) => <span className="mono">{fmtAt(q.at)}</span> },
    { key: "target", title: "目标", render: (q) => <span className="mono">{q.target}</span> },
    { key: "messageId", title: "消息", render: (q) => <span className="mono">{q.messageId}</span> },
    { key: "reason", title: "原因", render: (q) => <span className={styles.clip} title={q.reason || ""}>{q.reason || "—"}</span> },
    {
      key: "op", title: "操作",
      render: (q) => (
        dlqPending === q.id ? (
          <span className={styles.inlineBtns}>
            <button className={"msg-ghost " + styles.ghostDanger} disabled={dlqBusy === q.id} onClick={() => doReplay(q.id)}>
              {dlqBusy === q.id ? "提交中…" : "确认重放"}
            </button>
            <button className="msg-ghost" onClick={() => setDlqPending(null)}>取消</button>
          </span>
        ) : (
          <button className="msg-ghost" onClick={() => { setDlqPending(q.id); setMsg(null); }} title="把消息改回待投递并重新入队">重放</button>
        )
      ),
    },
  ];

  return (
    <main className="page">
      <PageHero
        title="未送达消息"
        subtitle="投递失败与过期的消息、以及未送达队列。这里只回答“为什么没送到”，不回答“为什么没回”。"
      />
      <div className="metric-row">
        <div className="metric-card"><div className="m-label">投递失败</div><div className="m-value">{s.failed}</div></div>
        <div className="metric-card"><div className="m-label">投递过期</div><div className="m-value">{s.expired}</div></div>
        <div className="metric-card"><div className="m-label">未送达队列</div><div className="m-value">{s.queue}</div></div>
      </div>
      <div className={"panel " + styles.panelPad}>
        <div className={"msg-col-head " + styles.colHeadPlain}>
          <span className="msg-col-title">未送达明细</span>
          <Link href="/messages" className={"msg-ghost " + styles.ghostEnd}>返回消息工作区</Link>
        </div>
        <div className={styles.tableScroll}>
          <DataTable
            columns={messageColumns}
            rows={messages}
            rowKey={(m) => String(m.id)}
            loading={loading}
            empty={{ title: `当前没有未送达消息（失败 ${s.failed} · 过期 ${s.expired} · 队列 ${s.queue}）` }}
          />
        </div>
        {queue.length > 0 ? (
          <div className={styles.queueBlock}>
            <div className={"msg-col-title " + styles.colTitleGap}>未送达队列（{queue.length}）</div>
            <DataTable columns={queueColumns} rows={queue} rowKey={(q) => String(q.id)} empty={{ title: "队列为空" }} />
          </div>
        ) : null}
        {msg ? <div className={"msg-trace-foot " + styles.footNote + " " + styles.footWarn}>{msg}</div> : null}
        <div className={"msg-trace-foot " + styles.footNote}>
          重试会真实重新投递（两次点击确认）；改派需要在通信服务管理端执行。
        </div>
      </div>
    </main>
  );
}
