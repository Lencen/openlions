import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { safeStatus } from "@/lib/server/proxy-fetch";
import { asOf } from "@/lib/server/lions-db";

// 2026-10-15 round-78: 读实时数据(上游 mind /api/v1/flywheel/stats)的 BFF, 不该是静态快照。
//   注: safeFetchJson 里的 fetch(cache:"no-store") 在 build 期会触发 Next static bailout, 本路由
//   实际已非静态(见 mind /api/v1/platform/health 同机制实测); 显式声明以去掉对 patch-fetch
//   细节的隐式依赖并防止未来改 helper 时静默变回冻结(口径同 /api/flywheel-status)。
export const dynamic = "force-dynamic";

export async function GET() {
  // 2026-09-29 (agent-d 休假): 安全 fetch (8s timeout + 失败返 502)
  const r = await safeFetchJson("http://localhost:3000/api/v1/flywheel/stats");
  const data = r.ok && r.data !== null && r.data !== undefined ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : null;
  // 2026-10-16（round 77-P, 铁律 2「逐源」+ 77-M 机检清单）:
  //   /system/health 有 3 个源, 其中"飞轮健康度"的数字来自本接口, 而该页此前把**会话档案**的 asOf
  //   标成了全页时刻 ✗ —— 又一次"借时刻"。本接口原先无时刻字段, 这里补**顶层** asOf。
  //   纯增量(与 /api/stats 同一写法, 已在 77-J 实测): 6 个消费者都读嵌套的 data 层, 顶层多键会被忽略 ✓;
  //   解析失败则原样返回, 不引入新失败面 ✓; **保持 status/headers 不变** ✓（77-J 我曾把这两参数弄丢过 ✗）。
  let body = data;
  const status = safeStatus(r.status);
  if (typeof body === "string" && body.trim().startsWith("{")) {
    try { body = JSON.stringify({ ...JSON.parse(body), asOf: asOf() }); } catch { /* 原样返回 */ }
  }
  return new NextResponse(body, { status, headers: { "Content-Type": "application/json" } });
}
