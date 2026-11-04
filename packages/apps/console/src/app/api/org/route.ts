import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";

export const dynamic = "force-dynamic";

// 组织架构 BFF (2026-09-21): 代理 mind /api/v1/org
const MIND = "http://localhost:3000/api/v1/org";

export async function GET() {
  // 2026-09-29 (agent-d 休假): 安全 fetch (失败返 502)
  const r = await safeFetchJson(MIND);
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  return NextResponse.json(r.data);
}

export async function POST(req: Request) {
  const body = await req.json();
  const r = await safeFetchJson(MIND, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  return NextResponse.json(r.data);
}
