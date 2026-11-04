"use client";
// 2026-10-21 未送达消息（失败/过期 + 未送达队列）—— 只读视图，Phase 2 排障入口
// 设计：不把"投递失败"与"处理未回复"混成一个列表；这里只管**送不到**的消息。
import { useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { PageHero } from "@/components/ui";

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
      <div className="panel" style={{ padding: "var(--sp-3)" }}>
        <div className="msg-col-head" style={{ border: "none", padding: 0 }}>
          <span className="msg-col-title">未送达明细</span>
          <Link href="/messages" className="msg-ghost" style={{ marginLeft: "auto" }}>返回消息工作区</Link>
        </div>
        {loading ? <div className="msg-empty">正在读取…</div> : messages.length === 0 ? (
          <div className="msg-empty">当前没有未送达消息（失败 {s.failed} · 过期 {s.expired} · 队列 {s.queue}）</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead><tr><th>时间</th><th>会话</th><th>发送方</th><th>摘要</th><th>状态</th><th>最后错误</th><th>操作</th></tr></thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id}>
                    <td className="td-mono">{fmtAt(m.at)}</td>
                    <td>{m.conversation}</td>
                    <td className="td-mono">{m.from}</td>
                    <td className="td-clip" title={m.text}>{m.text}</td>
                    <td><span className={"msg-pill t-" + (m.transport === "failed" ? "failed" : "expired")}>{m.transport === "failed" ? "投递失败" : "已过期"}</span></td>
                    <td className="td-clip" title={m.lastError || ""}>{m.lastError || "—"}</td>
                    <td>
                      {/* 2026-10-21：重试是真实写操作，二次确认后才发；只对失败/过期消息开放（其余状态后端返回 409，我们提前拦） */}
                      {pending === m.id ? (
                        <span style={{ display: "inline-flex", gap: 6 }}>
                          <button className="msg-ghost" style={{ color: "var(--status-crit)" }} disabled={busy === m.id} onClick={() => doRetry(m.id)}>
                            {busy === m.id ? "提交中…" : "确认重试"}
                          </button>
                          <button className="msg-ghost" onClick={() => setPending(null)}>取消</button>
                        </span>
                      ) : (
                        <button className="msg-ghost" onClick={() => { setPending(m.id); setMsg(null); }} title="会真实重新投递这条消息">重试</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {queue.length > 0 ? (
          <div style={{ marginTop: "var(--sp-4)" }}>
            <div className="msg-col-title" style={{ marginBottom: "var(--sp-2)" }}>未送达队列（{queue.length}）</div>
            <table className="tbl">
              <thead><tr><th>时间</th><th>目标</th><th>消息</th><th>原因</th><th>操作</th></tr></thead>
              <tbody>
                {queue.map((q: any) => (
                  <tr key={q.id}>
                    <td className="td-mono">{fmtAt(q.at)}</td>
                    <td className="td-mono">{q.target}</td>
                    <td className="td-mono">{q.messageId}</td>
                    <td className="td-clip" title={q.reason || ""}>{q.reason || "—"}</td>
                    <td>
                      {dlqPending === q.id ? (
                        <span style={{ display: "inline-flex", gap: 6 }}>
                          <button className="msg-ghost" style={{ color: "var(--status-crit)" }} disabled={dlqBusy === q.id} onClick={() => doReplay(q.id)}>
                            {dlqBusy === q.id ? "提交中…" : "确认重放"}
                          </button>
                          <button className="msg-ghost" onClick={() => setDlqPending(null)}>取消</button>
                        </span>
                      ) : (
                        <button className="msg-ghost" onClick={() => { setDlqPending(q.id); setMsg(null); }} title="把消息改回待投递并重新入队">重放</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {msg ? <div className="msg-trace-foot" style={{ borderTop: "1px dashed var(--border)", marginTop: "var(--sp-3)", color: "var(--status-warn)" }}>{msg}</div> : null}
        <div className="msg-trace-foot" style={{ borderTop: "1px dashed var(--border)", marginTop: "var(--sp-3)" }}>
          重试会真实重新投递（两次点击确认）；改派需要在通信服务管理端执行。
        </div>
      </div>
    </main>
  );
}
