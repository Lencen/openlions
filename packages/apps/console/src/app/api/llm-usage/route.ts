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
  // 2026-11-13：last24 tokens=0 而 calls>0 = 未计量（缺 token 字段），BFF 显式标注，页面不得写 0。
  try {
    const d: any = r.data;
    const w = d?.last24 || d?.windows?.last24;
    const calls = typeof w?.calls === "number" ? w.calls : (typeof w?.totalCalls === "number" ? w.totalCalls : null);
    if (w && calls !== null && calls > 0 && (!w.totalTokens || w.totalTokens === 0)) {
      w.unmeasured = true;
      w.unmeasuredReason = "近 24h 调用缺 token 字段（未计量），不是 0 消耗";
    }
    return NextResponse.json(d);
  } catch {
    return NextResponse.json(r.data);
  }
}