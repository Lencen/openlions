import { NextRequest, NextResponse } from "next/server";
import { sessionFetch, MACS_SESSION_ID, MACS_AGENT_ID } from "@/lib/server/macs-session";

export const dynamic = "force-dynamic";

// 2026-10-22 按线的会话列表（三查询 a）
// 服务端持有 session token；浏览器只拿到数据。失败返回 ok:false + reason（不静默归零）。
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(sp.get("limit") || 50), 1), 200);
  const cursor = sp.get("cursor");
  const p = "/api/sessions/" + encodeURIComponent(MACS_SESSION_ID) + "/conversations?limit=" + limit + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
  const r = await sessionFetch(p);
  return NextResponse.json({ ok: r.status < 300 && r.body ? true : false, status: r.status, ...(r.status < 300 && r.body ? r.body : { error: r.body?.error || ("MACS " + r.status) }) }, { status: r.status < 300 ? 200 : r.status });
}
