import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { safeStatus } from "@/lib/server/proxy-fetch";
import { asOf } from "@/lib/server/lions-db";
import { mindAdminHeaders } from "@/lib/server/mind-admin";

// 2026-10-15 round-78: 读实时数据(上游 mind /api/v1/memory/stats)的 BFF。
//   注: safeFetchJson 的 no-store fetch 使 build 期已 bailout 成动态; 显式声明为去隐式依赖/防回归。
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await safeFetchJson("http://localhost:3000/api/v1/memory/stats", { headers: mindAdminHeaders() });
  const data = r.ok && r.data !== null && r.data !== undefined ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : null;
  // 2026-10-16（round 77-J, 铁律 2「每个数字带数据时刻」的**逐源**落法）:
  //   /cognitive 的"记忆/知识"数字来自本接口, 而该页此前把**飞轮看板的**时刻标在了它们头上 ✗ ——
  //   这正是铁律 2 要防的"不同来源的数字混着不同时刻" ✗。本接口原先没有时刻字段, 这里补一个**顶层** asOf
  //   （纯增量: 5 个消费者都读嵌套的 data 层, 顶层多键会被忽略 ✓; 解析失败则原样返回, 不引入新失败面 ✓）。
  let body = data;
  const status = safeStatus(r.status);
  if (typeof body === "string" && body.trim().startsWith("{")) {
    try { body = JSON.stringify({ ...JSON.parse(body), asOf: asOf() }); } catch { /* 原样返回 */ }
  }
  return new NextResponse(body, { status, headers: { "Content-Type": "application/json" } });
}
