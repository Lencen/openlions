import { NextRequest, NextResponse } from "next/server";
import { openMacs, q } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-21 消息管理表格（只读）。
// 与"会话工作区"的区别：这里是**跨会话**的筛选与浏览，用于找问题消息；写操作（重放/改派）仍走通信服务管理端。
// 筛选：transport（传输态）、brain（处理态）、q（正文/会话关键字）、since（小时）。游标：before_seq。
export async function GET(req: NextRequest) {
  const db = openMacs();
  const sp = req.nextUrl.searchParams;
  if (!db) return NextResponse.json({ ok: false, reason: "MACS 库未配置", messages: [], total: 0 });
  const transport = sp.get("transport") || "";
  const brain = sp.get("brain") || "";
  const kw = (sp.get("q") || "").trim();
  const sinceH = Number(sp.get("since") || 0);
  const limit = Math.min(Math.max(Number(sp.get("limit") || 50), 1), 200);
  const beforeSeq = sp.get("before_seq");

  const where: string[] = ["1=1"];
  const params: any[] = [];
  if (transport) { where.push("m.delivery_status = ?"); params.push(transport); }
  if (brain) { where.push("m.processing_state = ?"); params.push(brain); }
  if (sinceH > 0) { where.push("m.created_at >= now() - (? || ' hours')::interval"); params.push(String(sinceH)); }
  if (kw) {
    where.push("(m.content ILIKE ? OR c.title ILIKE ? OR m.sender_id ILIKE ?)");
    const like = "%" + kw + "%";
    params.push(like, like, like);
  }
  if (beforeSeq) { where.push("m.seq < ?"); params.push(Number(beforeSeq)); }
  const whereSql = where.join(" AND ");

  const countRows = await q(db,
    "SELECT COUNT(*) c FROM messages m LEFT JOIN conversations c ON c.conversation_id = m.conversation_id WHERE " + whereSql,
    ...params);
  const total = Number((countRows && countRows[0] && countRows[0].c) || 0);

  const rows = await q(db,
    "SELECT m.message_id, m.conversation_id, m.sender_id, m.content, m.message_type, m.delivery_status, " +
    "m.processing_state, m.reply_to_id, m.client_message_id, m.last_error, m.created_at, m.seq, " +
    "c.title, c.participant_ids " +
    "FROM messages m LEFT JOIN conversations c ON c.conversation_id = m.conversation_id " +
    "WHERE " + whereSql + " ORDER BY m.seq DESC NULLS LAST, m.created_at DESC LIMIT ?",
    ...params, limit + 1);

  const textOf = (raw: any): string => {
    if (!raw) return "";
    try { const v = JSON.parse(String(raw)); if (v && typeof v === "object" && typeof v.text === "string") return v.text; } catch {}
    return String(raw);
  };
  const names = (raw: any): string[] => {
    try { const v = JSON.parse(String(raw ?? "[]")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
  };
  const hasMore = (rows || []).length > limit;
  const page = (rows || []).slice(0, limit);
  const messages = page.map((r: any) => {
    const ps = names(r.participant_ids);
    return {
      id: String(r.message_id ?? ""),
      conversationId: String(r.conversation_id ?? ""),
      conversation: r.title ? String(r.title) : ps.length === 2 ? ps[0] + " ↔ " + ps[1] : ps.join(", "),
      from: String(r.sender_id ?? ""),
      text: textOf(r.content).slice(0, 160),
      type: String(r.message_type ?? ""),
      transport: r.delivery_status ? String(r.delivery_status) : null,
      brain: r.processing_state ? String(r.processing_state) : null,
      replyTo: r.reply_to_id ? String(r.reply_to_id) : null,
      clientId: r.client_message_id ? String(r.client_message_id) : null,
      lastError: r.last_error ? String(r.last_error).slice(0, 160) : null,
      at: r.created_at ? new Date(r.created_at).toISOString() : null,
      seq: r.seq != null ? Number(r.seq) : null,
    };
  });

  return NextResponse.json({
    ok: true, total, count: messages.length, hasMore,
    nextBefore: hasMore && messages.length ? messages[messages.length - 1].seq : null,
    filters: { transport, brain, q: kw, since: sinceH },
    messages,
  });
}
