import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";

// 知识列表 proxy: 透传 search/category/sortBy/sortOrder/quick (后端已支持)
// 2026-09-29 (agent-d 休假): 改用 safeFetchJson (8s timeout + 失败返 502)
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const input = encodeURIComponent(JSON.stringify({
    page: Number(sp.get("page") || 1),
    pageSize: Number(sp.get("pageSize") || 10),
    search: sp.get("search") || undefined,
    category: sp.get("category") || undefined,
    sortBy: (sp.get("sortBy") as any) || "updatedAt",
    sortOrder: (sp.get("sortOrder") as any) || "desc",
    // 2026-09-14 UI-7: 常用快捷筛选 (高质量/近7天/被引用过/待复核)
    quick: sp.get("quick") || undefined,
    // 2026-10-13 round 76-CK: 顶栏全局时间范围(③) -> tRPC list 的 range
    range: sp.get("range") || undefined,
    // 2026-10-26：后端把「退役/被取代」默认过滤掉了（audit 场景需显式打开）。
    //   只透传布尔，避免 undefined 被序列化成字符串 "undefined"。
    includeSuperseded: sp.get("includeSuperseded") === "true" ? true : undefined,
  }));
  const r = await safeFetchJson(`http://localhost:3000/api/trpc/knowledge.list?input=${input}`);
  if (r.ok === false) return NextResponse.json({ items: [], total: 0, _error: r.error }, { status: 502 });
  const data = r.data;
  return NextResponse.json(data?.result?.data?.json || data?.result?.data || { items: [], total: 0 });
}
