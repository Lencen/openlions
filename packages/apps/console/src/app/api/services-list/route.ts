import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";

// 2026-10-15 round-78: 读实时数据(上游 mind agent.listServices 业务服务列表)的 BFF。
//   注: safeFetchJson 的 no-store fetch 使 build 期已 bailout 成动态; 显式声明为去隐式依赖/防回归。
export const dynamic = "force-dynamic";

export async function GET() {
    const r = await safeFetchJson("http://localhost:3000/api/trpc/agent.listServices?input=%7B%22json%22%3Anull%7D");
  if (r.ok === false) {
    return NextResponse.json({ _error: r.error }, { status: 502 });
  }
  const data = r.data;  const svcs = data?.result?.data?.json || data?.result?.data || [];
  const mapped = Array.isArray(svcs) ? svcs.map((s: any) => ({
    ...s,
    display_name: s.displayName || s.display_name || s.name,
    available_perms: typeof s.available_perms === "string" ? JSON.parse(s.available_perms || "[]") : (s.available_perms || []),
  })) : [];
  return NextResponse.json(mapped);
}
