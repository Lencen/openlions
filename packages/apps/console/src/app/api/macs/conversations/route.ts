import { NextRequest, NextResponse } from "next/server";
import { openMacs, q } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-21 MACS 会话列表（只读，lions_macs_ro）
// 依据后端交接：/api/messages 分页用游标；列表页这里直读 PG（只读角色），写操作走 MACS admin BFF。
// 口径：传输态 delivery_status 与处理态 processing_state **分开**返回，UI 分列展示。
export async function GET(req: NextRequest) {
  const db = openMacs();
  if (!db) return NextResponse.json({ ok: false, reason: "MACS 库未配置", conversations: [] });
  // “我”是谁：console 的运营身份（默认 agent-operator，可用 ?as= 覆盖）
  const as = (req?.nextUrl?.searchParams.get("as") || "agent-operator").trim();
  // 2026-10-21 未读/提及改成真数据：
  //   未读 = 该会话里**别人发给我**、已送达但没有 read_at 的消息数；
  //   @我  = 内容里出现 @我的 且未读的条数。之前恒为 0 是假数据（方案要求"未读"必须有意义）。
  const rows = await q(
    db,
    `SELECT c.conversation_id, c.type, c.title, c.participant_ids, c.last_message_at,
            m.sender_id, m.content, m.delivery_status, m.processing_state,
            COALESCE(u.unread, 0) AS unread,
            COALESCE(u.mentions, 0) AS mentions
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT sender_id, content, delivery_status, processing_state
           FROM messages WHERE conversation_id = c.conversation_id
          ORDER BY seq DESC NULLS LAST, created_at DESC LIMIT 1
       ) m ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS unread,
                COUNT(*) FILTER (WHERE content LIKE '%@' || ? || '%')::int AS mentions
           FROM messages x
          WHERE x.conversation_id = c.conversation_id
            AND x.sender_id <> ?
            AND x.delivery_status = 'delivered'
            AND x.read_at IS NULL
       ) u ON true
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC NULLS LAST
      LIMIT 100`,
    as, as
  );
  // participant_ids 是 JSON 数组字符串、content 是 {"text": ...} 的 JSON：
  //   直接显示会变成 '["agent-a", "agent-b"]' 和 '{"text": "..."}'（实测如此），必须先解析。
  const names = (raw: any): string[] => {
    try {
      const v = JSON.parse(String(raw ?? "[]"));
      return Array.isArray(v) ? v.map((x) => String(x)) : [];
    } catch { return []; }
  };
  const textOf = (raw: any): string => {
    if (!raw) return "";
    try {
      const v = JSON.parse(String(raw));
      if (v && typeof v === "object" && typeof v.text === "string") return v.text;
      return String(raw);
    } catch { return String(raw); }
  };
  const conversations = (rows || []).map((r: any) => {
    const ps = names(r.participant_ids);
    const title = r.title ? String(r.title) : ps.length === 2 ? ps[0] + " ↔ " + ps[1] : ps.length ? "群组（" + ps.length + " 人）" : String(r.conversation_id ?? "");
    return {
      id: String(r.conversation_id ?? ""),
      type: String(r.type ?? ""),
      title,
      participants: ps,
      lastAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
      lastFrom: r.sender_id ? String(r.sender_id) : null,
      preview: textOf(r.content).slice(0, 80),
      transport: r.delivery_status ? String(r.delivery_status) : null,
      brain: r.processing_state ? String(r.processing_state) : null,
      unread: Number(r.unread || 0),
      mentions: Number(r.mentions || 0),
    };
  });
  return NextResponse.json({ ok: true, count: conversations.length, conversations, asOf: new Date().toISOString() });
}
