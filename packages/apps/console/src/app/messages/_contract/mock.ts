// 2026-10-22 三查询 mock（字段名与 B 定稿一致；接口上线后整文件替换为真实 fetch）
import type { SessionConversationsResponse, SessionsOverviewResponse, SyncResponse } from "./session";

export const MOCK_CONVERSATIONS: SessionConversationsResponse = {
  conversations: [
    {
      conversation_id: "conv_demo_1",
      participants: ["agent-d", "agent-operator"],
      participant_display: ["agent-x(执行体)", "operator"],
      last_message: {
        message_id: "msg_demo_1", text: "契约草案已发，请确认 A–D", created_at: "2026-10-22T10:19:37+08:00",
        transport_status: "delivered", processing_state: "read",
        sender_id: "agent-d", sender_session_id: "sess_5f3550236bda419f",
      },
      unread_count: 0, mention_count: 0,
      claim: { session_id: "sess_5f3550236bda419f", lease_expires_at: "2026-10-22T11:00:00+08:00" },
    },
    {
      conversation_id: "conv_demo_2",
      participants: ["agent-d", "agent-d"],
      participant_display: ["agent-x(执行体)", "agent-x(执行体)"],
      last_message: {
        message_id: "msg_demo_2", text: "[frontend-line · 三项已交付]", created_at: "2026-10-22T10:41:00+08:00",
        transport_status: "read", processing_state: "replied",
        sender_id: "agent-d", sender_session_id: "sess_6e51d32248ca4180",
      },
      unread_count: 1, mention_count: 0, claim: null,
    },
  ],
  next_cursor: "cursor_demo_1",
};

export const MOCK_SYNC: SyncResponse = {
  messages: [
    {
      message_id: "msg_demo_2", created_at: "2026-10-22T10:41:00+08:00",
      sender_id: "agent-d", sender_session_id: "sess_6e51d32248ca4180", target_session_id: null,
      direction: "out", transport_status: "read", processing_state: "replied",
      text: "[frontend-line · 三项已交付]", text_length: 24,
      reply_to_id: "msg_demo_1", client_message_id: "cli_demo_1", last_error: null,
      events: [
        { event_type: "ingress", actor: "agent-d", created_at: "2026-10-22T10:41:00+08:00" },
        { event_type: "sse_push", actor: null, created_at: "2026-10-22T10:41:00+08:00" },
        { event_type: "delivered", actor: null, created_at: "2026-10-22T10:41:01+08:00" },
      ],
    },
    {
      message_id: "msg_demo_1", created_at: "2026-10-22T10:19:37+08:00",
      sender_id: "agent-d", sender_session_id: "sess_5f3550236bda419f", target_session_id: "sess_6e51d32248ca4180",
      direction: "in", transport_status: "delivered", processing_state: "read",
      text: "契约草案已发，请确认 A–D", text_length: 16,
      reply_to_id: null, client_message_id: null, last_error: null,
      events: [{ event_type: "ingress", actor: "agent-d", created_at: "2026-10-22T10:19:37+08:00" }],
    },
  ],
  next_cursor: null,
};

export const MOCK_OVERVIEW: SessionsOverviewResponse = {
  agent_id: "agent-d",
  sessions: [
    { session_id: "sess_6e51d32248ca4180", label: "frontend-line", status: "online", online: true, stale: false,
      stale_reason: null, last_heartbeat_at: "2026-10-22T10:41:50+08:00", pending_count: 0, claim_count: 0,
      unread_count: 5, oldest_pending_at: null },
    { session_id: "sess_5f3550236bda419f", label: "macs-line", status: "online", online: true, stale: false,
      stale_reason: null, last_heartbeat_at: "2026-10-22T10:40:00+08:00", pending_count: 0, claim_count: 1,
      unread_count: 0, oldest_pending_at: null },
    { session_id: "sess_85288d2687b747b5", label: "responder-operator", status: "online", online: true, stale: true,
      stale_reason: "heartbeat 超 120s", last_heartbeat_at: "2026-10-22T10:20:00+08:00", pending_count: 2,
      claim_count: 0, unread_count: 2, oldest_pending_at: "2026-10-22T09:55:00+08:00" },
  ],
};
