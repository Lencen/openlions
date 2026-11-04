import { NextResponse } from "next/server";
import { safeFetchJson, safeStatus } from "@/lib/server/proxy-fetch";

// 2026-10-15 round-78: 读实时数据(上游 mind 反思列表/详情)的 BFF。两处缺陷同 daily-report:
//   1) `status: r.status` 透传 -> 上游不可达时 status=0 -> RangeError(76-EJ 同类漏网);
//   2) 显式 force-dynamic(读实时数据), 口径同 /api/flywheel-status。
export const dynamic = "force-dynamic";

// 2026-09-09 P3: 反思列表透传 + ?detail=<theme> 单行详情(本体+派生任务回显)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const detail = url.searchParams.get("detail");
  let mindUrl = "http://localhost:3000/api/v1/flywheel/reflections";
  if (detail) {
    mindUrl = mindUrl + "/" + encodeURIComponent(detail);
  } else {
    const q = new URLSearchParams();
    const limit = url.searchParams.get("limit");
    const status = url.searchParams.get("status");
    if (limit) q.set("limit", limit);
    if (status) q.set("status", status);
    const range = url.searchParams.get("range");   // 2026-10-13 round 76-CA: 转发顶栏时间范围(③)
    if (range) q.set("range", range);
    const qs = q.toString();
    if (qs) mindUrl = mindUrl + "?" + qs;
  }
  const r = await safeFetchJson(mindUrl);
  const data = r.ok && r.data !== null && r.data !== undefined ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : null;
  return new NextResponse(data, { status: safeStatus(r.status), headers: { "Content-Type": "application/json" } });
}
