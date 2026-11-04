import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { asOf } from "@/lib/server/lions-db";

// 2026-10-15 round-78: 读实时数据(上游 mind pipeline.history 执行历史)的 BFF。
//   注: safeFetchJson 的 no-store fetch 使 build 期已 bailout 成动态; 显式声明为去隐式依赖/防回归。
export const dynamic = "force-dynamic";

export async function GET() {
    const r = await safeFetchJson("http://localhost:3000/api/trpc/pipeline.history");
  if (r.ok === false) {
    return NextResponse.json({ _error: r.error }, { status: 502 });
  }
  // 2026-10-16 round 77-AF（决策③逐源 + 77-M 机检清单）:
  //   /system/pipeline 有 2 个源（本接口的执行历史 + /api/flywheel-dashboard 的定时配置）, 而该页**没有**时刻 ✗。
  //   本接口原先无时刻字段, 这里补**顶层** asOf —— 与 77-J/77-P/77-S/77-AC/77-AD 同写法。
  //   纯增量: 返回体 {logs,summary}, 3 个消费者都读 logs/summary; 非对象则原样 ✓; 本文件**无** status 变量 ✓。
  const data = r.data;
  let payload = data?.result?.data?.json || data?.result?.data || { logs: [] };
  if (payload && typeof payload === "object" && !Array.isArray(payload)) payload = { ...payload, asOf: asOf() };
  return NextResponse.json(payload);
}
