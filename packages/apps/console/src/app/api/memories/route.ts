import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { asOf } from "@/lib/server/lions-db";
import { mindAdminHeaders } from "@/lib/server/mind-admin";

// 记忆列表 proxy: 透传 search/tier/sortBy/sortOrder/quick 到 memory.list (后端已支持)
// 2026-09-29 (agent-d 休假): 改用 safeFetchJson (8s timeout + 失败返 502)
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const input = encodeURIComponent(JSON.stringify({
    page: Number(sp.get("page") || 1),
    pageSize: Number(sp.get("pageSize") || 10),
    search: sp.get("search") || undefined,
    tier: sp.get("tier") || undefined,
    sortBy: (sp.get("sortBy") as any) || "updatedAt",
    sortOrder: (sp.get("sortOrder") as any) || "desc",
    // 2026-09-14 UI-7: 常用快捷筛选 (高质量/近7天/被引用过/待复核)
    quick: sp.get("quick") || undefined,
    // 2026-09-03: 默认只看 active (superseded=null), 归档 meta 不进列表; activeOnly=false 看全部
    activeOnly: sp.get("activeOnly") !== "false",
    // 2026-10-13 round 76-CJ: 顶栏全局时间范围(③) -> tRPC memory.list 的 range
    range: sp.get("range") || undefined,
  }));
  // 2026-10-23 R2-b: 管理端带 admin 头 -> mind 侧按 root_admin 返回全量
  const r = await safeFetchJson(`http://localhost:3000/api/trpc/memory.list?input=${input}`, { headers: mindAdminHeaders() });
  if (r.ok === false) return NextResponse.json({ items: [], total: 0, _error: r.error }, { status: 502 });
  const data = r.data;
  // 2026-10-16 round 77-AC（决策③逐源 + 77-M 机检清单）:
  //   /cognitive/memory 有 2 个源（本接口的列表 + /api/stats 的 KPI）, 而该页此前**完全没有**时刻 ✗。
  //   本接口原先无时刻字段, 这里补**顶层** asOf —— 与 77-J/77-P/77-S 同写法。
  //   纯增量: 返回体是 {items,total}, 顶层加兄弟键不影响既有读取（2 个消费者都读 items/total）✓;
  //   解析失败/非对象则原样返回, 不引入新失败面 ✓。本文件**没有** status 变量, 无同名冲突（77-S 踩过）✓。
  let body = data?.result?.data?.json || data?.result?.data || { items: [], total: 0 };
  if (body && typeof body === "object" && !Array.isArray(body)) body = { ...body, asOf: asOf() };
  return NextResponse.json(body);
}
