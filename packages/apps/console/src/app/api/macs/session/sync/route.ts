import { NextRequest, NextResponse } from "next/server";
import { sessionFetch, MACS_SESSION_ID, MACS_AGENT_ID } from "@/lib/server/macs-session";

export const dynamic = "force-dynamic";

// 2026-10-22 会话同步历史（三查询 b）
// 服务端持有 session token；浏览器只拿到数据。失败返回 ok:false + reason（不静默归零）。
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const cid = sp.get("conversation_id") || "";
  if (!cid) return NextResponse.json({ ok: false, error: "缺少 conversation_id" }, { status: 400 });
  const limit = Math.min(Math.max(Number(sp.get("limit") || 50), 1), 200);
  const cursor = sp.get("cursor");
  const p = "/api/conversations/" + encodeURIComponent(cid) + "/sync?session_id=" + encodeURIComponent(MACS_SESSION_ID) + "&limit=" + limit + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
  const r = await sessionFetch(p);
  return NextResponse.json({ ok: r.status < 300 && r.body ? true : false, status: r.status, ...(r.status < 300 && r.body ? r.body : { error: r.body?.error || ("MACS " + r.status) }) }, { status: r.status < 300 ? 200 : r.status });
}
