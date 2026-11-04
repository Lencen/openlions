"use client";
// Phase 1 三栏骨架：会话列表 / 消息流 / 右侧上下文
// 断点（方案 §3.4 + 审视补充）：≥1440 三栏；1024–1439 右栏收为抽屉；<1024 单栏切换。
import { useEffect, useMemo, useState } from "react";
import { toMessage, type ApiMessage, type Conversation, type Message } from "../_data";
import ConversationList from "./ConversationList";
import MessageStream from "./MessageStream";
import ContextPanel from "./ContextPanel";
import TraceDrawer from "./TraceDrawer";

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "unread", label: "未读" },
  { key: "mention", label: "@我" },
  { key: "failed", label: "失败" },
] as const;

export default function MessagesLayout({
  conversations, live = false, initialConversationId = "", initialMessageId = "",
  loading = false, error = null, onRetry,
}: {
  conversations: Conversation[];
  live?: boolean;
  /** 会话列表加载中（骨架） */
  loading?: boolean;
  /** 会话列表读取失败（错误态 + 重试） */
  error?: string | null;
  onRetry?: () => void;
  /** 深链：直接打开某会话 */
  initialConversationId?: string;
  /** 深链：定位并高亮某条消息 */
  initialMessageId?: string;
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  // 2026-10-21：会话搜索（⌘K 聚焦）与"会话内消息搜索"分开——两件事经常同时需要
  const [query, setQuery] = useState("");
  const [msgQuery, setMsgQuery] = useState("");
  const [activeId, setActiveId] = useState(
    initialConversationId && conversations.some((c) => c.id === initialConversationId)
      ? initialConversationId
      : conversations[0]?.id ?? ""
  );
  const [ctxOpen, setCtxOpen] = useState(false);
  // Phase 2 骨架：追踪抽屉（点消息状态打开）
  const [traceMsg, setTraceMsg] = useState<Message | null>(null);
  // 真数据模式：按选中会话拉消息（游标分页第一页 50 条）。库不可用时保持空，不伪造。
  const [liveMsgs, setLiveMsgs] = useState<Message[]>([]);
  // 2026-10-21 会话内"加载更早"：用 API 返回的 nextBefore（seq 游标）继续往前翻，不用 offset。
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // 追踪抽屉：真实事件（MACS message_events）；没有则抽屉内部退回状态推导
  const [trace, setTrace] = useState<{ events: any[] | null; legacy: boolean; assignment: string | null }>({ events: null, legacy: false, assignment: null });
  const openTrace = (m: Message) => {
    setTraceMsg(m);
    setTrace({ events: null, legacy: false, assignment: null });
    if (!live) return;
    fetch("/api/macs/trace?id=" + encodeURIComponent(m.id))
      .then((r) => r.json())
      .then((j) => { if (j?.ok) setTrace({ events: j.events || [], legacy: !!(j.derived && j.derived.legacy_reply_relation_missing), assignment: j.assignment || null }); })
      .catch(() => {});
  };

  const list = useMemo(() => {
    let base = conversations;
    if (filter === "unread") base = base.filter((c) => c.unread > 0);
    else if (filter === "mention") base = base.filter((c) => c.mention);
    else if (filter === "failed") base = base.filter((c) => c.failed);
    const q = query.trim().toLowerCase();
    if (q) base = base.filter((c) => (c.title + " " + c.preview).toLowerCase().includes(q));
    return base;
  }, [conversations, filter, query]);
  const active = conversations.find((c) => c.id === activeId) ?? list[0] ?? null;

  // 2026-10-21 键盘：J/K 切会话、Esc 关抽屉、⌘K/Ctrl+K 聚焦会话搜索（方案 §3.5 的验收项）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      // 2026-10-22：⌘K 已统一交给全站 CommandPalette，这里不再抢占（避免两个入口打架）。
      if (e.key === "Escape") {
        if (traceMsg) setTraceMsg(null);
        else if (ctxOpen) setCtxOpen(false);
        return;
      }
      if (typing) return;
      if (e.key === "j" || e.key === "k") {
        if (!list.length) return;
        const idx = list.findIndex((c) => c.id === active?.id);
        const next = e.key === "j" ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
        if (list[next]) setActiveId(list[next].id);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [list, active?.id, traceMsg, ctxOpen]);

  // 2026-10-21 实时信号：收到 SSE 的"新消息"就重拉当前会话（不直接把事件塞进消息流，避免与游标分页冲突）
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onNew = () => setTick((n) => n + 1);
    window.addEventListener("macs:new-message", onNew as any);
    return () => window.removeEventListener("macs:new-message", onNew as any);
  }, []);

  useEffect(() => {
    if (!live || !active?.id) { setLiveMsgs([]); return; }
    let cancelled = false;
    setNextBefore(null);
    fetch("/api/macs/messages?conversation_id=" + encodeURIComponent(active.id) + "&limit=50")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j?.ok) return;
        setLiveMsgs((j.messages as ApiMessage[]).map(toMessage));
        setNextBefore(j.hasMore ? j.nextBefore ?? null : null);
      })
      .catch(() => { if (!cancelled) setLiveMsgs([]); });
    return () => { cancelled = true; };
  }, [live, active?.id, tick]);

  const loadOlder = () => {
    if (!live || !active?.id || !nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    fetch("/api/macs/messages?conversation_id=" + encodeURIComponent(active.id) + "&limit=50&before_seq=" + nextBefore)
      .then((r) => r.json())
      .then((j) => {
        if (!j?.ok) return;
        const older = (j.messages as ApiMessage[]).map(toMessage);
        setLiveMsgs((prev) => older.concat(prev));
        setNextBefore(j.hasMore ? j.nextBefore ?? null : null);
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false));
  };

  const shown = active && live ? { ...active, messages: liveMsgs } : active;

  // 2026-10-22 深链定位：消息加载后滚动到目标并高亮 2.5s（URL 里带了 message 才触发）
  useEffect(() => {
    if (!initialMessageId || !shown?.messages?.length) return;
    const el = document.querySelector('[data-message-id="' + initialMessageId + '"]');
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("msg-target");
    const t = setTimeout(() => el.classList.remove("msg-target"), 4000);
    return () => clearTimeout(t);
  }, [initialMessageId, shown?.messages?.length]);

  const deepLinkMissing = !!initialConversationId && !conversations.some((c) => c.id === initialConversationId);
  return (
    <section className="msg-shell">
      {deepLinkMissing ? (
        <div className="msg-deeplink-warn" role="status">
          深链指定的会话 <span className="td-mono">{initialConversationId}</span> 不在当前列表里（可能已失效或无权限），已回到默认会话。
        </div>
      ) : null}
      <ConversationList
        items={list}
        filters={FILTERS as unknown as { key: string; label: string }[]}
        filter={filter}
        onFilter={setFilter}
        activeId={active?.id ?? ""}
        onPick={setActiveId}
        search={query}
        onSearch={setQuery}
        loading={loading}
        error={error}
        onRetry={onRetry}
      />
      <MessageStream
        conversation={shown}
        loading={live && !!active && liveMsgs.length === 0}
        onOpenContext={() => setCtxOpen((v) => !v)}
        onTrace={openTrace}
        search={msgQuery}
        onSearch={setMsgQuery}
        hasOlder={live && !!nextBefore}
        loadingOlder={loadingOlder}
        onLoadOlder={loadOlder}
      />
      <ContextPanel conversation={shown} open={ctxOpen} onClose={() => setCtxOpen(false)} onOpenTrace={openTrace} />
      <TraceDrawer message={traceMsg} onClose={() => setTraceMsg(null)} events={trace.events} legacy={trace.legacy} assignment={trace.assignment} />
    </section>
  );
}
