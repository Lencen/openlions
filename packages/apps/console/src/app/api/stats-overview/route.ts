import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { safeStatus } from "@/lib/server/proxy-fetch";
import { asOf } from "@/lib/server/lions-db";

// 2026-10-15 round-78: 同 /api/flywheel-status —— 读实时概览数据的 BFF, 两个缺陷同源:
//   1) `status: r.status` 透传: 上游(mind)不可达时 r.status=0 -> RangeError(76-EJ 同类漏网);
//   2) 无参 `GET()` 被 Next 在构建期预渲染, 构建时即连上游 -> 停机构建时炸 / 在线时冻结快照。
// 修法: safeStatus 收口出口状态 + 显式 force-dynamic。两处都必需, 理由见 flywheel-status 注释。
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await safeFetchJson("http://localhost:3000/api/trpc/stats.getOverview");
  const data = r.ok && r.data !== null && r.data !== undefined ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : null;
  // 2026-10-15（round 76-GM, 规范铁律 2）：**顶层加一个 asOf** —— "这份数据是什么时候取的"。
  //   上游 mind 的 trpc 响应里没有"数据时刻" ✗, 而 /system 这一页此前**完全没有** ✗(连全局筛选条都没有)。
  //   纯增量: 该接口只有 1 个消费者(/system), 且它读的是**嵌套的 result.data…** ✓ -> 顶层多键会被忽略 ✓。
  let body = data;
  if (body && typeof body === "string" && body.trim().startsWith("{")) {
    try { body = JSON.stringify({ ...JSON.parse(body), asOf: asOf() }); } catch { body = data; }
  }
  return new NextResponse(body, { status: safeStatus(r.status), headers: { "Content-Type": "application/json" } });
}
