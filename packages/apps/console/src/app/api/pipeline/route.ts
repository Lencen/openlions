import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
export async function GET(req: Request) {
  const url = new URL(req.url);
  const input = url.searchParams.get('input') || '{"json":{"limit":50}}';
    const r = await safeFetchJson(`http://localhost:3000/api/trpc/flywheel.getEvents?input=${encodeURIComponent(input)}`);
  if (r.ok === false) {
    return NextResponse.json({ _error: r.error }, { status: 502 });
  }
  const data = r.data;  const events = data?.result?.data?.json || data?.result?.data || [];
  return NextResponse.json(events);
}
