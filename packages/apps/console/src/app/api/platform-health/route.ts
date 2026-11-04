import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { safeStatus } from "@/lib/server/proxy-fetch";

// 2026-10-15 round-78: 读实时数据(上游 mind /api/v1/platform/health 的探活结果)的 BFF。
//   注: safeFetchJson 的 no-store fetch 使 build 期已 bailout 成动态; 显式声明为去隐式依赖/防回归。
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await safeFetchJson("http://localhost:3000/api/v1/platform/health");
  const data = r.ok && r.data !== null && r.data !== undefined ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : null;
  return new NextResponse(data, { status: safeStatus(r.status), headers: { "Content-Type": "application/json" } });
}
