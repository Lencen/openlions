"use client";
/**
 * TopNavNotifications.tsx — 顶栏通知聚合（2026-10-22）
 *
 * 聚合三类**真实**状态，不伪造数字：
 *   1) 本线未确认：/api/macs/session-inbox 的 count（服务端 read 为准）
 *   2) 传输待处理：同一接口的 pendingDelivery（还没送达，SLO 关心这个）
 *   3) 未送达：/api/macs/failed 的 summary.failed + summary.expired
 * 未确认条目带 conversation_id → 点击直接深链 /messages?conversation=&message=（目标 ④）。
 * 接口失败时显示"数据不可达"，不显示 0 冒充正常。
 */
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/Icon";
import Link from "next/link";

type InboxItem = {
  message_id: string; from?: string; text?: string; created_at?: string;
  delivery_status?: string; conversation_id?: string | null;
  processing_state?: string | null; transport_status?: string | null; last_error?: string | null;
};

const STATE_LABEL: Record<string, string> = {
  read: "已读", delivered: "已送达", pending: "传输中", failed: "未送达",
  processing: "处理中", stale: "陈旧", acked: "已确认",
};

export default function TopNavNotifications() {
  const [open, setOpen] = useState(false);
  const [inbox, setInbox] = useState<{ ok: boolean; count: number | null; pendingDelivery: number; items: InboxItem[]; reason?: string } | null>(null);
  const [failed, setFailed] = useState<{ failed: number; expired: number; queue: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const a = await fetch("/api/macs/session-inbox").then((r) => r.json());
        if (alive) setInbox(a);
        const b = await fetch("/api/macs/failed").then((r) => r.json());
        if (alive && b && b.summary) setFailed({ failed: b.summary.failed ?? 0, expired: b.summary.expired ?? 0, queue: b.summary.queue ?? 0 });
      } catch {
        if (alive) setInbox({ ok: false, count: null, pendingDelivery: 0, items: [], reason: "数据不可达" });
      }
    };
    load();
    const t = window.setInterval(load, 30000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const unread = inbox?.ok ? (inbox.count ?? 0) : null;
  const pending = inbox?.pendingDelivery ?? 0;
  const undelivered = failed ? failed.failed + failed.expired : null;
  const total = (unread ?? 0) + (undelivered ?? 0);

  return (
    <div className="notify" ref={boxRef}>
      <button
        type="button"
        className="notify-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="通知"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="inbox" size={16} />
        {total > 0 ? <span className="notify-badge">{total > 99 ? "99+" : total}</span> : null}
      </button>
      {open ? (
        <div className="notify-panel" role="dialog" aria-label="通知">
          <div className="notify-head">
            <strong>通知</strong>
            <span className="notify-sub">
              未确认 {unread === null ? "不可达" : unread} · 传输待处理 {pending} · 未送达 {undelivered === null ? "不可达" : undelivered}
            </span>
          </div>
          {inbox && !inbox.ok ? (
            <div className="notify-empty">本线收件箱不可达（{inbox.reason || "watcher 未产出镜像"}）——不显示 0 冒充正常。</div>
          ) : null}
          <div className="notify-list">
            {(inbox?.items || []).slice(0, 6).map((it) => {
              const href = it.conversation_id
                ? "/messages?conversation=" + encodeURIComponent(it.conversation_id) + "&message=" + encodeURIComponent(it.message_id)
                : "/messages/session";
              const st = it.processing_state || it.delivery_status || "";
              return (
                <Link key={it.message_id} href={href} className="notify-item" onClick={() => setOpen(false)}>
                  <span className="notify-item-top">
                    <span className="notify-from">{it.from || "未知来源"}</span>
                    <span className={"notify-state s-" + st}>{STATE_LABEL[st] || st || "未知"}</span>
                  </span>
                  <span className="notify-text">{(it.text || "").slice(0, 80)}</span>
                  <span className="notify-time">{it.created_at || ""}</span>
                </Link>
              );
            })}
            {(inbox?.ok && (inbox.items || []).length === 0) ? <div className="notify-empty">没有未确认消息。</div> : null}
          </div>
          <div className="notify-foot">
            <Link href="/messages/session" onClick={() => setOpen(false)}>会话线详情</Link>
            <Link href="/messages/failed" onClick={() => setOpen(false)}>未送达明细</Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
