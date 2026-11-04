// 2026-10-21 MACS 消息工作区 —— 设计稿数据（Phase 1 骨架期）
// 字段命名刻意对齐方案 §4.2：传输态(transport) 与 处理态(brain) **分开**，
//   因为排障最常见的问题是"送到了但没人处理"，合成一个状态就看不出来。
export type TransportStatus = "queued" | "delivered" | "read" | "failed" | "expired";
export type BrainStatus = "unreplied" | "replied" | "timeout" | "ratelimited" | "no_reply_needed";

export interface Message {
  id: string;
  from: "agent" | "human";
  who: string;
  body: string;
  at: string;          // HH:MM
  transport: TransportStatus;
  brain?: BrainStatus; // 仅对 agent 收到的消息有意义
  legacy?: boolean;    // 历史消息缺 reply_to_id
}

export interface Conversation {
  id: string;
  title: string;
  kind: "agent-agent" | "agent-human" | "group";
  unread: number;
  mention: boolean;
  failed: boolean;
  lastAt: string;
  preview: string;
  agent: { id: string; name: string; online: boolean };
  messages: Message[];
}

export const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: "c1", title: "DeepSeek ↔ leo", kind: "agent-agent", unread: 2, mention: false, failed: false,
    lastAt: "16:02", preview: "那四条读取路径我已改完，你那边验收一下？",
    agent: { id: "agent-d", name: "DeepSeek", online: true },
    messages: [
      { id: "m1", from: "agent", who: "leo", body: "飞轮看板还有一处读的是旧库，要不要我一起改？", at: "15:58", transport: "read", brain: "replied" },
      { id: "m2", from: "agent", who: "DeepSeek", body: "那四条读取路径我已改完，你那边验收一下？", at: "16:02", transport: "delivered", brain: "unreplied" },
    ],
  },
  {
    id: "c2", title: "与 运营者·operator", kind: "agent-human", unread: 0, mention: true, failed: false,
    lastAt: "15:41", preview: "待办里那 5 件超 7 天未动的，我今天处理。",
    agent: { id: "operator", name: "运营者·operator", online: true },
    messages: [
      { id: "m3", from: "human", who: "operator", body: "待办里那 5 件超 7 天未动的，我今天处理。", at: "15:41", transport: "read" },
      { id: "m4", from: "agent", who: "DeepSeek", body: "收到，我把清单和证据链接一起贴给你。", at: "15:42", transport: "read", brain: "replied" },
    ],
  },
  {
    id: "c3", title: "通信服务：投递失败（3 条）", kind: "group", unread: 3, mention: false, failed: true,
    lastAt: "15:12", preview: "投递过期：对方离线超过 30 分钟。",
    agent: { id: "macs", name: "通信服务", online: true },
    messages: [
      { id: "m5", from: "agent", who: "utc", body: "在吗？有个任务需要你确认。", at: "14:50", transport: "expired", brain: "no_reply_needed", legacy: true },
      { id: "m6", from: "agent", who: "晨光", body: "投递过期：对方离线超过 30 分钟。", at: "15:12", transport: "failed", brain: "timeout" },
    ],
  },
];

// ── 2026-10-21 真数据映射（MACS 已切 PG；页面在库就绪时走这里） ──────────────
// 后端交接的字段是 snake_case + JSON 文本；这里集中做一次映射，组件不感知数据来源。
export interface ApiConversation {
  id: string; type: string; title: string; participants: string[];
  lastAt: string | null; lastFrom: string | null; preview: string;
  transport: string | null; brain: string | null;
  unread?: number; mentions?: number;
}
export interface ApiMessage {
  id: string; from: string; text: string; type: string;
  transport: string | null; brain: string | null; replyTo: string | null;
  clientId: string | null; lastError: string | null; at: string | null; seq: number | null;
}

const TRANSPORT_MAP: Record<string, TransportStatus> = {
  pending: "queued", queued: "queued", delivered: "delivered", read: "read",
  failed: "failed", expired: "expired",
};
// MACS 的 processing_state 是 pending/delivered/read/replied，语义接近"处理进度"而不是"回没回"；
//   按原义标注（不硬套我们的五个枚举），避免把"已读未回"说成"已回复"。
const BRAIN_MAP: Record<string, BrainStatus> = {
  pending: "unreplied", delivered: "unreplied", read: "unreplied", replied: "replied",
  timeout: "timeout", ratelimited: "ratelimited",
};
const BRAIN_LABEL_OVERRIDE: Partial<Record<string, string>> = {
  pending: "未处理", delivered: "未处理", read: "已读未回",
};
export function brainLabel(m: ApiMessage | { brain?: BrainStatus | null }): string {
  const b = (m as any).brain as string | undefined | null;
  if (b && BRAIN_LABEL_OVERRIDE[b]) return BRAIN_LABEL_OVERRIDE[b]!;
  return "";
}

const hhmm = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 5);
};

export function toConversation(c: ApiConversation): Conversation {
  return {
    id: c.id,
    title: c.title || c.id,
    kind: c.type === "group" ? "group" : "agent-human",
    unread: Number(c.unread || 0),
    mention: Number(c.mentions || 0) > 0,
    failed: c.transport === "failed" || c.transport === "expired",
    lastAt: hhmm(c.lastAt),
    preview: c.preview || "（无消息）",
    agent: { id: c.lastFrom || "", name: c.lastFrom || c.title || "", online: false },
    messages: [],
  };
}

export function toMessage(m: ApiMessage): Message {
  return {
    id: m.id,
    from: "agent",
    who: m.from,
    body: m.text,
    at: hhmm(m.at),
    transport: TRANSPORT_MAP[String(m.transport || "")] || "queued",
    brain: m.brain ? (BRAIN_MAP[String(m.brain)] || "unreplied") : undefined,
    // 历史标注只认后端 trace 的 derived.legacy_reply_relation_missing（98 条）；
    //   不能拿 replyTo 为空来推断——大量正常消息本来就没有引用关系（实测会对几乎全部消息误标）。
    legacy: false,
  };
}

