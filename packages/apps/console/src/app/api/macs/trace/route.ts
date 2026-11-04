import { NextRequest, NextResponse } from "next/server";
import { openMacs, q } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-21 消息追踪（只读）：消息本体 + message_events 时间线。
// 交接文档提到 trace 里要标 legacy_reply_relation_missing；这里按可复算的口径推导：
//   context 里记录了 reply_to，但 reply_to_id 为空 => 历史消息缺引用关系（后端统计为 98 条）。
// 写操作（retry/assign）不在此路由，走 MACS admin BFF。
export async function GET(req: NextRequest) {
  const db = openMacs();
  if (!db) return NextResponse.json({ ok: false, reason: "MACS 库未配置" }, { status: 503 });
  const id = decodeURIComponent(req.nextUrl.searchParams.get("id") || "").trim();
  if (!id) return NextResponse.json({ ok: false, reason: "缺少消息 id" }, { status: 400 });

  const msgRows = await q(db,
    "SELECT message_id, conversation_id, sender_id, content, message_type, delivery_status, " +
    "processing_state, reply_to_id, client_message_id, last_error, created_at, delivered_at, read_at, context " +
    "FROM messages WHERE message_id = ? LIMIT 1", id);
  const m: any = (msgRows || [])[0];
  if (!m) return NextResponse.json({ ok: false, reason: "消息不存在" }, { status: 404 });

  const evRows = await q(db,
    "SELECT event_type, actor, detail, created_at FROM message_events WHERE message_id = ? ORDER BY created_at ASC LIMIT 200", id);

  const textOf = (raw: any): string => {
    if (!raw) return "";
    try { const v = JSON.parse(String(raw)); if (v && typeof v === "object" && typeof v.text === "string") return v.text; } catch {}
    return String(raw);
  };
  const detailOf = (raw: any): string => {
    if (!raw) return "";
    try {
      const v = JSON.parse(String(raw));
      if (v && typeof v === "object") return Object.keys(v).slice(0, 4).map((k) => k + "=" + String(v[k]).slice(0, 40)).join(" · ");
    } catch {}
    return String(raw).slice(0, 120);
  };
  let ctxReplyTo = false;
  try { const c = JSON.parse(String(m.context || "{}")); ctxReplyTo = !!(c && (c.reply_to || c.replyTo)); } catch {}

  // 当前负责人：取最近一次 assigned 事件里的 assigned_to（后台 assign 会 revoke 旧的再插新的）
  let assignment: string | null = null;
  for (const e of evRows || []) {
    if (String(e.event_type) === "assigned") {
      try { const d = JSON.parse(String(e.detail || "{}")); if (d && d.assigned_to) assignment = String(d.assigned_to); } catch {}
    }
  }

  const events = (evRows || []).map((e: any) => ({
    at: e.created_at ? new Date(e.created_at).toISOString() : null,
    type: String(e.event_type || ""),
    actor: e.actor ? String(e.actor) : null,
    detail: detailOf(e.detail),
  }));

  return NextResponse.json({
    ok: true,
    message: {
      id: String(m.message_id), conversation_id: String(m.conversation_id), from: String(m.sender_id || ""),
      text: textOf(m.content), type: String(m.message_type || ""),
      transport: m.delivery_status ? String(m.delivery_status) : null,
      brain: m.processing_state ? String(m.processing_state) : null,
      replyTo: m.reply_to_id ? String(m.reply_to_id) : null,
      clientId: m.client_message_id ? String(m.client_message_id) : null,
      lastError: m.last_error ? String(m.last_error) : null,
      createdAt: m.created_at ? new Date(m.created_at).toISOString() : null,
      deliveredAt: m.delivered_at ? new Date(m.delivered_at).toISOString() : null,
      readAt: m.read_at ? new Date(m.read_at).toISOString() : null,
    },
    derived: { legacy_reply_relation_missing: ctxReplyTo && !m.reply_to_id },
    assignment,
    events,
  });
}
