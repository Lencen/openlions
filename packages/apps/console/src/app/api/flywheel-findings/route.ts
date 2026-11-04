import { NextResponse } from "next/server";
import { safeFetchJson, safeStatus } from "@/lib/server/proxy-fetch";
import { asOf } from "@/lib/server/lions-db";
// 2026-10-13 round 76-CA: 转发顶栏时间范围(③) —— mind 侧已 opt-in 支持 ?range=。
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const q = new URLSearchParams();
  const range = p.get("range");
  if (range) q.set("range", range);
  // 2026-10-13 round 76-CA: 页面一直传 ?limit=50, 但这条透传路由**把它丢了** -> 上游永远用默认 pageSize=20,
  //   于是"发现列表"只可能显示 20 条里的去重结果。这里把 limit 映射成上游的 pageSize(上游上限 100)。
  const limit = Number(p.get("limit"));
  if (Number.isFinite(limit) && limit > 0) q.set("pageSize", String(Math.min(100, Math.trunc(limit))));
  const status = p.get("status");
  if (status) q.set("status", status);
  const qs = q.toString();
  const r = await safeFetchJson("http://localhost:3000/api/v1/flywheel/findings" + (qs ? "?" + qs : ""));
  const data = r.ok && r.data !== null && r.data !== undefined ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : null;
  // 2026-10-16（round 77-S, 决策③逐源 + 77-M 机检清单）:
  //   /flywheel/findings 有 2 个源（本接口 + /api/flywheel-stats），而该页此前**完全没有**时刻 ✗。
  //   本接口原先无时刻字段, 这里补**顶层** asOf —— 与 77-J/77-P 已验证的写法一致,
  //   且**保持 status/headers 不变** ✓（77-J 我曾把这两个参数弄丢导致 TS1005, 先读全文件再改 ✓）。
  //   纯增量: 返回体是 {success,data,meta}, 顶层多一个兄弟键不影响既有读取 ✓;
  //   解析失败则原样返回, 不引入新失败面 ✓。
  // 注意: 本文件上方已有 `const status = p.get("status")`(上游筛选参数) —— 77-S 我第一次写成
  //   `const status = safeStatus(...)` 造成**同名重复定义**, 接口当场 500 ✗。故这里改名 resStatus。
  let body = data;
  const resStatus = safeStatus(r.status);
  if (typeof body === "string" && body.trim().startsWith("{")) {
    try { body = JSON.stringify({ ...JSON.parse(body), asOf: asOf() }); } catch { /* 原样返回 */ }
  }
  return new NextResponse(body, { status: resStatus, headers: { "Content-Type": "application/json" } });
}
