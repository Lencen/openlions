import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { mindAdminHeaders } from "@/lib/server/mind-admin";
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  if (!id) return NextResponse.json({});
  // mind.memory.get 接受 z.string() (raw id), tRPC v11 raw input 直接是 JSON 字符串
    const r = await safeFetchJson(`http://localhost:3000/api/trpc/memory.get?input=${encodeURIComponent(JSON.stringify(id))}`, { headers: mindAdminHeaders() });
  if (r.ok === false) {
    return NextResponse.json({ _error: r.error }, { status: 502 });
  }
  const data = r.data;  return NextResponse.json(data);
}