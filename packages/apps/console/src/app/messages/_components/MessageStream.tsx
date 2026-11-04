"use client";
import type { Conversation, Message } from "../_data";

const TRANSPORT_LABEL: Record<Message["transport"], string> = {
  queued: "排队中", delivered: "已送达", read: "已读", failed: "投递失败", expired: "已过期",
};
const BRAIN_LABEL: Record<NonNullable<Message["brain"]>, string> = {
  unreplied: "未回复", replied: "已回复", timeout: "大脑超时", ratelimited: "被限流", no_reply_needed: "无需回复",
};

/** 传输态与处理态**分列**：合并成一个徽标就分不清"送到了但没人处理"（排障核心场景）。 */
function StatusPair({ m, onTrace }: { m: Message; onTrace: () => void }) {
  return (
    <span className="msg-status">
      <button className={"msg-pill clickable t-" + m.transport} onClick={onTrace} title="查看这条消息的追踪时间线">{TRANSPORT_LABEL[m.transport]}</button>
      {m.brain ? <span className={"msg-pill b-" + m.brain}>{BRAIN_LABEL[m.brain]}</span> : null}
      {m.legacy ? <span className="msg-pill legacy" title="历史消息未记录引用关系">历史</span> : null}
    </span>
  );
}

export default function MessageStream({
  conversation, onOpenContext, onTrace, loading = false,
  search = "", onSearch,
  hasOlder = false, loadingOlder = false, onLoadOlder,
}: {
  conversation: Conversation | null;
  onOpenContext: () => void;
  onTrace: (m: Message) => void;
  loading?: boolean;
  /** 会话内消息搜索（在已加载的消息里过滤） */
  search?: string;
  onSearch?: (v: string) => void;
  /** 2026-10-21：这之上还有更早的消息（游标 nextBefore 存在） */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}) {
  const q = search.trim().toLowerCase();
  const shownMsgs = q && conversation
    ? conversation.messages.filter((m) => (m.body + " " + m.who).toLowerCase().includes(q))
    : conversation?.messages ?? [];
  if (!conversation) {
    return (
      <div className="msg-col msg-col-stream">
        <div className="msg-empty-lg">左侧选一个会话开始</div>
      </div>
    );
  }
  return (
    <div className="msg-col msg-col-stream">
      <div className="msg-col-head">
        <span className="msg-col-title">{conversation.title}</span>
        <input
          className="msg-input msg-in-search"
          placeholder="在会话内搜索"
          value={search}
          onChange={(e) => onSearch?.(e.target.value)}
          aria-label="在会话内搜索消息"
        />
        <button className="msg-ghost" onClick={onOpenContext} aria-label="打开或收起上下文面板">上下文</button>
      </div>
      <div className="msg-stream" aria-live="polite">
        {hasOlder ? (
          <div className="msg-older">
            <button className="msg-ghost" onClick={onLoadOlder} disabled={loadingOlder}>
              {loadingOlder ? "加载中…" : "加载更早的消息"}
            </button>
          </div>
        ) : null}
        {loading ? (
          // 加载态骨架：3 行气泡轮廓，比"正在读取…"更像产品
          <div className="msg-skel-stream" aria-busy="true" aria-label="正在读取消息">
            {[0, 1, 2].map((i) => (
              <div key={"msk" + i} className="msg-skel-bubble">
                <span className="msg-skel-bar w30" />
                <span className="msg-skel-bar w80" />
              </div>
            ))}
          </div>
        ) : null}
        {q && shownMsgs.length === 0 ? <div className="msg-empty">已加载的消息里没有匹配“{search}”的内容</div> : null}
        {shownMsgs.map((m) => (
          <div key={m.id} data-message-id={m.id} className={"msg-row " + (m.from === "human" ? "human" : "peer")}>
            <div className="msg-bubble">
              <div className="msg-bubble-head">
                <span className="msg-who">{m.who}</span>
                <span className="msg-at">{m.at}</span>
              </div>
              <div className="msg-body">{m.body}</div>
              <StatusPair m={m} onTrace={() => onTrace(m)} />
            </div>
          </div>
        ))}
      </div>
      <div className="msg-composer">
        {/* Phase 2 才允许写：现在明确禁用，避免误以为能发消息 */}
        <input className="msg-input" placeholder="发送将在下一阶段开放（当前只读）" disabled />
        <button className="msg-send" disabled title="下一阶段开放">发送</button>
      </div>
    </div>
  );
}
