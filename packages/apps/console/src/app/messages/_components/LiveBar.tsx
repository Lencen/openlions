"use client";
// 2026-10-21 实时状态条：连 MACS 的 SSE（经 console 服务端代理）。
// 交接要求：断线必须可见（黄条 + 重连计数），不能让用户以为"没新消息"。
import { useEffect, useRef, useState } from "react";
import styles from "../page.module.css";

export default function LiveBar({ agentId = "agent-operator" }: { agentId?: string }) {
  const [state, setState] = useState<"connecting" | "live" | "down">("connecting");
  const [retries, setRetries] = useState(0);
  const [events, setEvents] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  // 2026-10-21：SSE 事件可能短时间连发，按 100ms 合并再通知刷新（交接文档要求的合并渲染）
  const pendingRef = useRef(false);
  const flush = () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setTimeout(() => {
      pendingRef.current = false;
      window.dispatchEvent(new CustomEvent("macs:new-message"));
    }, 100);
  };

  useEffect(() => {
    let closed = false;
    const es = new EventSource("/api/macs/stream?agent_id=" + encodeURIComponent(agentId));
    esRef.current = es;
    es.onopen = () => { if (!closed) setState("live"); };
    es.onerror = () => {
      if (closed) return;
      setState("down");
      setRetries((n) => n + 1);
    };
    es.onmessage = () => { if (!closed) { setEvents((n) => n + 1); flush(); } };
    const onNamed = () => { if (!closed) { setEvents((n) => n + 1); flush(); } };
    es.addEventListener("message", onNamed as any);
    return () => { closed = true; es.close(); esRef.current = null; };
  }, [agentId]);

  const label = state === "live" ? "实时已连接" : state === "down" ? "实时连接已断开，正在自动重连（第 " + retries + " 次）" : "正在连接实时通道…";
  return (
    <div className={"msg-live" + (state === "down" ? " down" : "")} role="status" aria-live="polite">
      <span className={"msg-live-dot " + styles.dot} data-tone={state} aria-hidden="true" />
      <span>{label}</span>
      <span className="msg-live-meta">订阅 {agentId} · 已收到 {events} 条信号</span>
    </div>
  );
}
