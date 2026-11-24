import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson, safeStatus } from "@/lib/server/proxy-fetch";
import { requireFeature } from "@/lib/server/license-gate";

// 2026-10-15 round-78: 读实时数据(上游 portal :3006 日报)的 BFF。两处缺陷:
//   1) `status: r.status` 透传 -> 上游不可达时 safeFetchJson 返回 status=0, 直接塞进 NextResponse 抛
//      `RangeError: init["status"] must be in the range of 200 to 599`(76-EJ 同类漏网) -> 打挂请求/进程;
//   2) 未显式声明动态 -> 同 caliber 收口, 与已修的 /api/flywheel-status、/api/stats-overview 一致。
// 修法: 出口状态过 safeStatus(平台既有口径, lib/server/proxy-fetch.ts:31) + force-dynamic。
export const dynamic = "force-dynamic";

// 代理到 portal :3006 的 daily-report
// 2026-09-29 (agent-d 休假): 改用 safeFetchJson (8s timeout + 失败返 502)
export async function GET(req: NextRequest) {
  // 2026-11-04（open 版）：没有 portal 时明确返回"未启用"，不要走 license gate 变成 402 假错误。
  const portal = String(process.env.LIONS_PORTAL_URL || "").replace(/\/$/, "");
  if (!portal) {
    return NextResponse.json({ ok: false, available: false, reason: "门户未配置（open 版不含 portal）" }, { status: 200 });
  }
  // 2026-10-27（S2 门禁）：审计属 security.audit；**不能只隐藏 UI 而 API 放行**。
  const denied = await requireFeature("security.audit");
  if (denied) return denied;
  const date = req.nextUrl.searchParams.get("date");
  const url = date
    ? `${portal}/api/portal/daily-report?date=${date}`
    : `${portal}/api/portal/daily-report`;
  const r = await safeFetchJson(url);
  // 2026-11-15（B1-1 H-1）：portal 日报未下发 asOf → BFF 补查后时刻（与 lineage/overview 一致），
  // 页面「数据时刻」用该值；不得把请求时刻伪装成库内时刻。
  const fetchedAt = new Date().toISOString();
  let data = r.ok && r.data !== null && r.data !== undefined ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : null;
  if (data) {
    try {
      const o = JSON.parse(data);
      if (o && typeof o === "object") {
        if (!o.asOf) o.asOf = fetchedAt;
        data = JSON.stringify(o);
      }
    } catch {}
  }
  return new NextResponse(data, { status: safeStatus(r.status), headers: { "Content-Type": "application/json" } });
}