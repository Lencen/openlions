import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";

export const dynamic = "force-dynamic";
const MIND = "http://localhost:3000/api/v1/rbac";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const agent = u.searchParams.get("agent") || "";
  // 2026-09-29 (agent-d 休假): 安全 fetch (失败返 502)
  const r = await safeFetchJson(MIND + (agent ? "?agent=" + encodeURIComponent(agent) : ""));
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  return NextResponse.json(r.data);
}

export async function POST(req: Request) {
  const b = await req.json();
  const r = await safeFetchJson(MIND, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  return NextResponse.json(r.data);
}
