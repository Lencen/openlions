import { NextResponse } from 'next/server';
import { safeFetchJson } from '@/lib/server/proxy-fetch';

export const dynamic = 'force-dynamic';

// 2026-09-29 (agent-d 休假): 安全 fetch (8s timeout + 失败返 502)
// 2026-10-13 round 76-BZ: 顶栏 range 接入(③) —— mind 侧已支持 opt-in 时间窗, 这里把它转发过去。
export async function GET(req: Request) {
  const range = new URL(req.url).searchParams.get('range');
  const url = 'http://localhost:3000/api/v1/llm-usage' + (range ? '?range=' + encodeURIComponent(range) : '');
  const r = await safeFetchJson(url);
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  return NextResponse.json(r.data);
}
