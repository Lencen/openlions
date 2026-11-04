"use client";
import type { Conversation } from "../_data";

const KIND_LABEL: Record<Conversation["kind"], string> = {
  "agent-agent": "智能体间",
  "agent-human": "人机",
  group: "群组",
};

export default function ConversationList({
  items, filters, filter, onFilter, activeId, onPick, search = "", onSearch,
  loading = false, error = null, onRetry,
}: {
  items: Conversation[];
  filters: { key: string; label: string }[];
  filter: string;
  onFilter: (k: any) => void;
  activeId: string;
  onPick: (id: string) => void;
  search?: string;
  onSearch?: (v: string) => void;
  /** 2026-10-22 四态：加载骨架 / 错误可重试 / 空态 */
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="msg-col msg-col-list">
      <div className="msg-col-head">
        <span className="msg-col-title">会话</span>
        <span className="msg-count">{items.length}</span>
      </div>
      <div className="msg-search-wrap">
        <input
          className="msg-input msg-conv-search"
          placeholder="搜索会话"
          value={search}
          onChange={(e) => onSearch?.(e.target.value)}
          aria-label="搜索会话"
        />
      </div>
      <div className="msg-filters" role="tablist" aria-label="会话筛选">
        {filters.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            className={"msg-filter" + (filter === f.key ? " active" : "")}
            onClick={() => onFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ul className="msg-conv-list">
        {loading && items.length === 0 ? (
          // 加载态：骨架行，避免"先空一下再突然出现"
          <>
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={"sk" + i} className="msg-skel-row" aria-hidden="true">
                <span className="msg-skel-bar w60" />
                <span className="msg-skel-bar w90" />
                <span className="msg-skel-bar w40" />
              </li>
            ))}
            <li className="msg-empty">正在读取会话…</li>
          </>
        ) : error ? (
          <li className="msg-error" role="alert">
            <span>会话列表读取失败：{String(error).slice(0, 60)}</span>
            <button className="msg-ghost" onClick={() => onRetry?.()} type="button">重试</button>
          </li>
        ) : items.length === 0 ? (
          <li className="msg-empty">{search ? "没有匹配的会话" : "暂无会话"}</li>
        ) : items.map((c) => (
          <li key={c.id}>
            <button
              className={"msg-conv" + (c.id === activeId ? " active" : "")}
              onClick={() => onPick(c.id)}
              aria-current={c.id === activeId}
            >
              <span className="msg-conv-top">
                <span className="msg-conv-dot" data-online={c.agent.online} aria-hidden="true" />
                <span className="msg-conv-title">{c.title}</span>
                <span className="msg-conv-time">{c.lastAt}</span>
              </span>
              <span className="msg-conv-preview">{c.preview}</span>
              <span className="msg-conv-meta">
                <span className="msg-tag">{KIND_LABEL[c.kind]}</span>
                {c.mention ? <span className="msg-tag mention">@我</span> : null}
                {c.failed ? <span className="msg-tag fail">投递失败</span> : null}
                {c.unread > 0 ? (
                  // 2026-10-22 与后端线对齐：这是"已送达但未回写已读"的条数，不等于"有人在找你"
                  <span className="msg-unread" title="已送达未读（对方尚未回写已读状态）">{c.unread}</span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
