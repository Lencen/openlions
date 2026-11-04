import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";

export const dynamic = "force-dynamic";

// 2026-09-24 [可见性缺口] todo_bdce470195d94307abff: console 代理「按来源的改进结果」视图
//   GET /api/improvement-results?source=agent-x-feedback&limit=100
// 上游: mind /api/v1/flywheel/improvement-results。上游不可达时返回 ok:false(不抛 500)。
const MIND = "http://localhost:3000/api/v1/flywheel/improvement-results";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await safeFetchJson(MIND + (url.search || ""));
    const data = r.ok ? r.data : null;
    if (!data) return NextResponse.json({ ok: false, error: "mind 返回空响应 (" + r.status + ")" }, { status: 502 });
    return NextResponse.json(data, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "mind 服务 (3000) 不可达: " + String(e?.message || e).slice(0, 120) });
  } finally {
    clearTimeout(timer);
  }
}
