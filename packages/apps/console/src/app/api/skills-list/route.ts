import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
// 技能列表 proxy: 透传 search/category/level/hasContent/sortBy/sortOrder/quick (后端已支持)
// 2026-09-28 修(系统性 bug): 此前 fetch 后无 res.ok 检查 + 无 try/catch, 上游一旦返非 JSON
//   (404/500 HTML 页) proxy 自己 500。改用 safeFetchJson 标准化结果, 上游失败返空集 + 502 而非崩。
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const input = encodeURIComponent(JSON.stringify({
    page: Number(sp.get("page") || 1),
    pageSize: Number(sp.get("pageSize") || 10),
    search: sp.get("search") || undefined,
    category: sp.get("category") || undefined,
    level: sp.get("level") || undefined,
    hasContent: sp.get("hasContent") === "true" ? true : sp.get("hasContent") === "false" ? false : undefined,
    sortBy: (sp.get("sortBy") as any) || "updatedAt",
    sortOrder: (sp.get("sortOrder") as any) || "desc",
    // 2026-09-14 UI-7: 常用快捷筛选 (高质量/近7天/被引用过/待复核)
    quick: sp.get("quick") || undefined,
    // 2026-10-13 round 76-CJ: 顶栏全局时间范围(③) -> tRPC skills.list 的 range
    range: sp.get("range") || undefined,
  }));
  const r = await safeFetchJson(`http://localhost:3000/api/trpc/skills.list?input=${input}`);
  if (r.ok === false) {
    // 上游失败: 返空集 + 502 + 错误细节, 前端可显示"暂无数据"而非整页崩
    // 用显式字面比较 r.ok === false 强制 TS discriminated union 收窄
    return NextResponse.json({ items: [], total: 0, _error: r.error }, { status: 502 });
  }
  const data = r.data;
  return NextResponse.json(data?.result?.data?.json || data?.result?.data || { items: [], total: 0 });
}
