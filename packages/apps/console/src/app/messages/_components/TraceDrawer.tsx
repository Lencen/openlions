"use client";
// Phase 2 骨架：消息追踪抽屉（mock 数据，不依赖 MACS 真实 trace 接口）
// 目的：把"3 次点击说清为什么没回"的交互路径先立起来——点消息状态 → 抽屉显示时间线。
// 时间线刻意分成**传输**与**处理**两条泳道，与列表里的两枚徽标一一对应（同一份事实，不另造口径）。
import type { Message } from "../_data";

const KIND_LABEL: Record<string, string> = {
  transport: "传输",
  brain: "处理",
  system: "系统",
};

export interface TraceEvent {
  at: string;
  kind: "transport" | "brain" | "system";
  label: string;
  detail?: string;
}

/** 由消息自身的两个状态推导时间线（mock 阶段保证与徽标一致；接口就绪后换成 GET trace） */
export function buildTrace(m: Message): TraceEvent[] {
  const out: TraceEvent[] = [];
  out.push({ at: m.at, kind: "transport", label: "已入队", detail: "进入发送队列" });
  if (m.transport === "failed" || m.transport === "expired") {
    out.push({ at: m.at, kind: "transport", label: m.transport === "failed" ? "投递失败" : "投递过期", detail: "对方离线超过阈值或通道不可达" });
  } else {
    out.push({ at: m.at, kind: "transport", label: m.transport === "read" ? "已读" : "已送达", detail: m.transport === "read" ? "对方打开会话" : "已写入对方收件箱" });
  }
  if (m.brain) {
    out.push({ at: m.at, kind: "brain", label: "进入处理", detail: "对方开始读取上下文" });
    if (m.brain === "replied") out.push({ at: m.at, kind: "brain", label: "已回复" });
    else if (m.brain === "timeout") out.push({ at: m.at, kind: "brain", label: "处理超时", detail: "超过大脑时限仍未回复" });
    else if (m.brain === "ratelimited") out.push({ at: m.at, kind: "brain", label: "被限流", detail: "触发速率限制，未处理" });
    else if (m.brain === "unreplied") out.push({ at: m.at, kind: "brain", label: "尚未回复", detail: "已送达但对方还没有响应" });
    else out.push({ at: m.at, kind: "brain", label: "无需回复" });
  }
  if (m.legacy) out.push({ at: m.at, kind: "system", label: "历史消息", detail: "缺少引用关系记录（legacy_reply_relation_missing）" });
  return out;
}

// 真实事件（MACS message_events）→ 时间线；没有事件时退回按消息状态推导，保证抽屉永远可用
const EVENT_META: Record<string, { kind: "transport" | "brain" | "system"; label: string }> = {
  ingress: { kind: "transport", label: "入站" },
  sse_push: { kind: "transport", label: "推送到客户端" },
  delivered: { kind: "transport", label: "已送达" },
  read: { kind: "transport", label: "已读" },
  replied: { kind: "brain", label: "已回复" },
  callback_reply: { kind: "brain", label: "回调回复" },
  retry: { kind: "system", label: "重试" },
  assigned: { kind: "system", label: "分配负责人" },
};

const hms = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8);
};

export default function TraceDrawer({
  message, onClose, events: realEvents, legacy, assignment,
}: {
  message: Message | null;
  onClose: () => void;
  events?: { at: string | null; type: string; actor: string | null; detail: string }[] | null;
  legacy?: boolean;
  /** 当前负责人（来自 trace 的 assigned 事件） */
  assignment?: string | null;
}) {
  if (!message) return null;
  const mapped: TraceEvent[] | null = realEvents && realEvents.length
    ? realEvents.map((e) => {
        const meta = EVENT_META[e.type] || { kind: "system" as const, label: e.type };
        return { at: hms(e.at), kind: meta.kind, label: meta.label, detail: [e.actor ? "by " + e.actor : "", e.detail].filter(Boolean).join(" · ") };
      })
    : null;
  const events = mapped || buildTrace(message);
  return (
    <div className="msg-trace-mask" role="dialog" aria-modal="true" aria-label="消息追踪" onClick={onClose}>
      <aside className="msg-trace" onClick={(e) => e.stopPropagation()}>
        <div className="msg-trace-head">
          <span className="msg-trace-title">消息追踪</span>
          <button className="msg-ghost" onClick={onClose} aria-label="关闭追踪">关闭</button>
        </div>
        <div className="msg-trace-meta">
          <div className="msg-ctx-k">消息</div>
          <div className="msg-trace-id">{message.id}</div>
          <div className="msg-trace-body">{message.body}</div>
        </div>
        {assignment ? (
          <div className="msg-trace-meta">
            <div className="msg-ctx-k">当前负责人</div>
            <div className="msg-ctx-v">{assignment}</div>
          </div>
        ) : null}
        <ol className="msg-trace-list">
          {events.map((e, i) => (
            <li key={i} className={"msg-trace-item " + e.kind}>
              <span className="msg-trace-dot" aria-hidden="true" />
              <span className="msg-trace-at">{e.at}</span>
              <span className="msg-trace-kind">{KIND_LABEL[e.kind]}</span>
              <span className="msg-trace-label">{e.label}</span>
              {e.detail ? <span className="msg-trace-detail">{e.detail}</span> : null}
            </li>
          ))}
        </ol>
        <div className="msg-trace-foot">
          {mapped ? "真实事件（来自消息事件表）" : "该消息暂无事件记录，按当前状态推导"}
          {legacy ? " · 历史消息缺引用关系" : ""} · 写操作仍禁用
        </div>
      </aside>
    </div>
  );
}
