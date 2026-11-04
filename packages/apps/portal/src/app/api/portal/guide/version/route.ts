import { NextResponse } from "next/server";
import { GUIDE_VERSION, GUIDE_UPDATED_AT } from "@/lib/platform-guide";

// GET /api/portal/guide/version — 心跳用: 对比版本, 变了就拉全量 guide
export async function GET() {
  return NextResponse.json({ ok: true, version: GUIDE_VERSION, updatedAt: GUIDE_UPDATED_AT });
}
