import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";

// 技能列表 proxy: 透传 search/category/level/hasContent/sortBy/sortOrder/quick (后端已支持)
// 2026-09-29 (agent-d 休假): 改用 safeFetchJson (8s timeout + 失败返 502)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const input = url.searchParams.get('input') || '{"page":1,"pageSize":50}';
  const r = await safeFetchJson(`http://localhost:3000/api/trpc/skill.list?input=${encodeURIComponent(input)}`);
  if (r.ok === false) return NextResponse.json({ items: [], total: 0, _error: r.error }, { status: 502 });
  const data = r.data;
  const skills = data?.result?.data?.json || data?.result?.data || [];
  return NextResponse.json(skills);
}
