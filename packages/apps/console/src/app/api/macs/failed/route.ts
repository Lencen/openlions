import { NextResponse } from "next/server";
import { openMacs, q } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-21 失败/未送达视图（只读）：投递失败、投递过期的消息 + 未送达队列。
// 口径：delivery_status ∈ {failed, expired}；未送达队列 = dead_letter_queue（当前 0 条，如实显示空态）。
// 写操作（重放/重试）不在此路由 —— 交接文档要求走 MACS admin BFF。
export async function GET() {
  const db = openMacs();
  if (!db) return NextResponse.json({ ok: false, reason: "MACS 库未配置", summary: null, messages: [], queue: [] });
  const textOf = (raw: any): string => {
    if (!raw) return "";
    try { const v = JSON.parse(String(raw)); if (v && typeof v === "object" && typeof v.text === "string") return v.text; } catch {}
    return String(raw);
  };
  const countOne = async (sql: string): Promise<number> => {
    const rows = await q(db, sql);
    return Number((rows && rows[0] && rows[0].c) || 0);
  };
  const expired = await countOne("SELECT COUNT(*) c FROM messages WHERE delivery_status = 'expired'");
  const failed = await countOne("SELECT COUNT(*) c FROM messages WHERE delivery_status = 'failed'");
  let dlq = 0;
  try { dlq = await countOne("SELECT COUNT(*) c FROM dead_letter_queue"); } catch { dlq = 0; }

  const base =
    "SELECT m.message_id, m.conversation_id, m.sender_id, m.content, m.delivery_status, m.processing_state, " +
    "m.last_error, m.created_at, c.title, c.participant_ids " +
    "FROM messages m LEFT JOIN conversations c ON c.conversation_id = m.conversation_id " +
    "WHERE m.delivery_status IN ('failed','expired') ORDER BY m.created_at DESC LIMIT 50";
  const rows = await q(db, base);
  const names = (raw: any): string[] => {
    try { const v = JSON.parse(String(raw ?? "[]")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
  };
  const messages = (rows || []).map((r: any) => {
    const ps = names(r.participant_ids);
    return {
      id: String(r.message_id ?? ""),
      conversationId: String(r.conversation_id ?? ""),
      conversation: r.title ? String(r.title) : ps.length === 2 ? ps[0] + " ↔ " + ps[1] : ps.join(", "),
      from: String(r.sender_id ?? ""),
      text: textOf(r.content).slice(0, 120),
      transport: String(r.delivery_status ?? ""),
      brain: r.processing_state ? String(r.processing_state) : null,
      lastError: r.last_error ? String(r.last_error).slice(0, 160) : null,
      at: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
  });

  let queue: any[] = [];
  try {
    const qr = await q(db, "SELECT id, message_id, target_agent_id, reason, created_at FROM dead_letter_queue ORDER BY created_at DESC LIMIT 20");
    queue = (qr || []).map((r: any) => ({ id: Number(r.id), messageId: String(r.message_id ?? ""), target: String(r.target_agent_id ?? ""), reason: r.reason ? String(r.reason).slice(0, 160) : null, at: r.created_at ? new Date(r.created_at).toISOString() : null }));
  } catch { queue = []; }

  return NextResponse.json({ ok: true, summary: { expired, failed, queue: dlq }, messages, queue });
}
