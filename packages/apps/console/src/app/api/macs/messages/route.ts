import { NextRequest, NextResponse } from "next/server";
import { openMacs, q } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-21 MACS 消息分页（只读 lions_macs_ro）。
// 游标用表里的 seq（单调递增），不用 offset；before_seq 为空表示第一页。
// 返回按时间正序，供 UI 直接渲染；hasMore/nextBefore 用于向上加载更早消息。
export async function GET(req: NextRequest) {
  const db = openMacs();
  if (!db) return NextResponse.json({ ok: false, reason: "MACS 库未配置" }, { status: 503 });
  const cid = req.nextUrl.searchParams.get("conversation_id") || "";
  if (!cid) return NextResponse.json({ ok: false, reason: "缺少 conversation_id" }, { status: 400 });
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") || 50), 1), 200);
  const beforeSeq = req.nextUrl.searchParams.get("before_seq");
  const base =
    "SELECT message_id, conversation_id, sender_id, content, message_type, " +
    "delivery_status, processing_state, reply_to_id, client_message_id, last_error, " +
    "created_at, delivered_at, read_at, seq FROM messages WHERE conversation_id = ? ";
  const sql = base + (beforeSeq ? "AND seq < ? " : "") + "ORDER BY seq DESC NULLS LAST, created_at DESC LIMIT ?";
  const params: any[] = beforeSeq ? [cid, Number(beforeSeq), limit + 1] : [cid, limit + 1];
  const rows = await q(db, sql, ...params);
  const hasMore = (rows || []).length > limit;
  const page = (rows || []).slice(0, limit).reverse();
  // content 是 {"text": ...} 的 JSON，直接显示会变成 '{"text": "..."}'
  const textOf = (raw: any): string => {
    if (!raw) return "";
    try { const v = JSON.parse(String(raw)); if (v && typeof v === "object" && typeof v.text === "string") return v.text; } catch {}
    return String(raw);
  };
  const messages = page.map((r: any) => ({
    id: String(r.message_id ?? ""),
    from: String(r.sender_id ?? ""),
    text: textOf(r.content),
    type: String(r.message_type ?? ""),
    transport: r.delivery_status ? String(r.delivery_status) : null,
    brain: r.processing_state ? String(r.processing_state) : null,
    replyTo: r.reply_to_id ? String(r.reply_to_id) : null,
    clientId: r.client_message_id ? String(r.client_message_id) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    at: r.created_at ? new Date(r.created_at).toISOString() : null,
    seq: r.seq != null ? Number(r.seq) : null,
  }));
  return NextResponse.json({ ok: true, conversation_id: cid, count: messages.length, hasMore, nextBefore: hasMore && page.length ? (page[0] as any).seq : null, messages });
}
