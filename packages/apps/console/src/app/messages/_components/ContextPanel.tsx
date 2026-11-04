"use client";
import type { Conversation } from "../_data";

export default function ContextPanel({
  conversation, open, onClose, onOpenTrace,
}: {
  conversation: Conversation | null;
  open: boolean;
  onClose: () => void;
  onOpenTrace: (m: any) => void;
}) {
  return (
    <aside className={"msg-col msg-col-ctx" + (open ? " open" : "")} aria-label="会话上下文">
      <div className="msg-col-head">
        <span className="msg-col-title">上下文</span>
        <button className="msg-ghost msg-ctx-close" onClick={onClose} aria-label="关闭上下文">关闭</button>
      </div>
      {!conversation ? <div className="msg-empty">未选择会话</div> : (
        <div className="msg-ctx-body">
          <div className="msg-ctx-block">
            <div className="msg-ctx-k">对方</div>
            <div className="msg-ctx-v">{conversation.agent.name}</div>
            <div className="msg-ctx-sub">{conversation.agent.online ? "在线" : "离线"}</div>
          </div>
          <div className="msg-ctx-block">
            <div className="msg-ctx-k">状态口径</div>
            <div className="msg-ctx-sub">传输态看“送到没”，处理态看“回没回 / 为什么没回”。</div>
          </div>
          <div className="msg-ctx-block">
            <div className="msg-ctx-k">投递诊断</div>
            <button
              className="msg-ghost"
              disabled={!conversation?.messages?.length}
              title={conversation?.messages?.length ? "查看最近一条消息的追踪时间线" : "该会话还没有消息"}
              onClick={() => { const ms = conversation?.messages || []; if (ms.length) onOpenTrace(ms[ms.length - 1]); }}
            >
              查看最近一条的追踪
            </button>
          </div>
          <div className="msg-ctx-block">
            <div className="msg-ctx-k">操作</div>
            <button className="msg-ghost" disabled title="下一阶段开放">重放 / 接管（下一阶段）</button>
          </div>
        </div>
      )}
    </aside>
  );
}
