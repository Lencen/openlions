import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { safeStatus } from "@/lib/server/proxy-fetch";

// 2026-10-15 round-78: 本路由是**读实时数据**的 BFF(上游 mind flywheel.getStatus), 原有两个缺陷:
//   1) 出口状态码透传 r.status —— 上游不可达时 safeFetchJson 返回 status=0, 直接塞进 NextResponse
//      抛 `RangeError: init["status"] must be in the range of 200 to 599, inclusive.`(即 76-EJ 同类漏网)。
//   2) 只导出 `GET()`(无请求对象/无动态函数), 被 Next 当成可静态化的 route handler, 在**构建期预渲染**
//      —— 构建时就去连上游: mind 停机 -> 上面的 RangeError 打断 `next build`(实测 2026-10-15);
//      mind 在线 -> 把构建时刻的快照冻进 .next 静态产物(与 portal `api/portal/agents` 2026-10-15
//      记录的 `x-nextjs-cache: HIT` 冻结同一类错误)。
// 修法: 出口状态一律过 safeStatus(平台既有口径, 见 lib/server/proxy-fetch.ts), 并显式 force-dynamic
//   (与 portal agents / readyz、console readyz 同口径) —— 读实时数据的 API 路由不该被预渲染。
//   两处都必需: 只改状态码则构建期依赖上游 + 静态缓存说谎; 只声明动态则运行时上游不可达仍会 RangeError。
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await safeFetchJson("http://localhost:3000/api/trpc/flywheel.getStatus");
  const data = r.ok && r.data !== null && r.data !== undefined ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : null;
  return new NextResponse(data, { status: safeStatus(r.status), headers: { "Content-Type": "application/json" } });
}
