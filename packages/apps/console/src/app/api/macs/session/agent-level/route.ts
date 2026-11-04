import { NextRequest, NextResponse } from "next/server";
import { openMacs, q } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-22 同 agent 会话（agent 级）最近消息——只读 PG。
// 为什么不用 /api/messages：session token 对 agent 级接口是 403；而 agent key 属 admin 级，
//   没必要为"读一眼"再挂一个高权凭证。console 本来就以只读角色读 lions_macs，这里复用。
// 用途：后端的回信几乎都是 agent 级（无 target_session_id），session inbox/wake 看不到，
//   靠这条把"同 agent 之间说了什么"显示出来（主动读的可见性缺口）。
const DEFAULT_CONV = process.env.MACS_AGENT_CONVERSATION || "conv_88fcda3d8f9c";

export async function GET(req: NextRequest) {
  const db = openMacs();
  if (!db) return NextResponse.json({ ok: false, error: "消息库不可用" }, { status: 503 });
  const sp = req.nextUrl.searchParams;
  const cid = sp.get("conversation_id") || DEFAULT_CONV;
  const limit = Math.min(Math.max(Number(sp.get("limit") || 10), 1), 50);
  const rows = await q(
    db,
    "SELECT message_id, sender_id, target_session_id, delivery_status, processing_state, content, created_at, seq " +
      "FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?",
    cid, limit
  ).catch(() => []);
  const textOf = (raw: any): string => {
    if (!raw) return "";
    try { const v = JSON.parse(String(raw)); if (v && typeof v === "object" && typeof v.text === "string") return v.text; } catch {}
    return String(raw);
  };
  const messages = (rows || []).map((r: any) => ({
    message_id: String(r.message_id ?? ""),
    sender_id: String(r.sender_id ?? ""),
    target_session_id: r.target_session_id ? String(r.target_session_id) : null,
    delivery_status: r.delivery_status ? String(r.delivery_status) : null,
    processing_state: r.processing_state ? String(r.processing_state) : null,
    text: textOf(r.content).slice(0, 400),
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    seq: r.seq != null ? Number(r.seq) : null,
  }));
  return NextResponse.json({ ok: true, conversation_id: cid, count: messages.length, messages });
}
