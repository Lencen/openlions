import { NextResponse } from "next/server";
import { safeFetchJson, safeStatus } from "@/lib/server/proxy-fetch";

export const dynamic = "force-dynamic";

export async function GET() {
  const r = await safeFetchJson("http://localhost:3000/api/v1/flywheel/ops");
  return NextResponse.json(r.ok ? r.data : { error: "上游暂不可用" }, { status: safeStatus(r.status) });
}
