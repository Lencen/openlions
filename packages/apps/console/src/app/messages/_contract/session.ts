// 2026-10-22 MACS Session Principal 三查询契约类型（**B 定稿字段**）
// 来源：docs/practices/2026-10-22-macs-session-principal-contract.md §7
// 纪律：字段名必须与后端实现逐字一致；枚举由服务端给，前端不做二次推导。

export type TransportStatus = "queued" | "delivered" | "read" | "failed" | "expired";
export type ProcessingState = "pending" | "delivered" | "read" | "replied" | "brain_timeout" | "rate_limited";
export type Direction = "in" | "out";

/** a) 按线的会话列表：GET /api/sessions/{sid}/conversations */
export interface SessionConversationLastMessage {
  message_id: string;
  text: string;
  created_at: string;
  transport_status: TransportStatus;
  processing_state: ProcessingState;
  sender_id: string;
  sender_session_id: string | null;
}
export interface SessionConversationRow {
  conversation_id: string;
  participants: string[];
  /** B 补1：展示名，与 participants 同序同长 */
  participant_display: string[];
  last_message: SessionConversationLastMessage | null;
  unread_count: number;
  mention_count: number;
  claim: { session_id: string; lease_expires_at: string } | null;
}
export interface SessionConversationsResponse {
  conversations: SessionConversationRow[];
  next_cursor: string | null;
}

/** b) 会话同步历史：GET /api/conversations/{cid}/sync */
export interface SyncEvent {
  event_type: string;
  /** B 补5：谁触发的 */
  actor: string | null;
  created_at: string;
  detail?: string;
}
export interface SyncMessageRow {
  message_id: string;
  created_at: string;
  sender_id: string;
  sender_session_id: string | null;
  target_session_id: string | null;
  /** B 补4：相对请求 session 的方向 */
  direction: Direction;
  transport_status: TransportStatus;
  processing_state: ProcessingState;
  text: string;
  text_length: number;
  /** B 补3：排障三件套 */
  reply_to_id: string | null;
  client_message_id: string | null;
  last_error: string | null;
  events: SyncEvent[];
}
export interface SyncResponse {
  messages: SyncMessageRow[];
  next_cursor: string | null;
}

/** c) 跨线聚合：GET /api/agents/{aid}/sessions/overview */
export interface SessionOverviewRow {
  session_id: string;
  label: string;
  status: string;
  online: boolean;
  stale: boolean;
  /** B 补6：为什么 stale + 最近心跳 + 最老待处理 */
  stale_reason: string | null;
  last_heartbeat_at: string;
  pending_count: number;
  claim_count: number;
  unread_count: number;
  oldest_pending_at: string | null;
}
export interface SessionsOverviewResponse {
  agent_id: string;
  sessions: SessionOverviewRow[];
}
