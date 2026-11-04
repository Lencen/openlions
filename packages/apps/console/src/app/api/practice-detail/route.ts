import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  if (!id) return NextResponse.json({});
    const r = await safeFetchJson(`http://localhost:3000/api/trpc/practice.get?input=${encodeURIComponent(JSON.stringify(id))}`);
  if (r.ok === false) {
    return NextResponse.json({ _error: r.error }, { status: 502 });
  }
  const data = r.data;  return NextResponse.json(data);
}