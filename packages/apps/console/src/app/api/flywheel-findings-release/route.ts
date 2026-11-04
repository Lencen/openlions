import { NextRequest, NextResponse } from "next/server";
import { safeStatus } from "@/lib/server/proxy-fetch";

const MIND = process.env.LIONS_MIND_URL || "http://127.0.0.1:3000";

// POST /api/flywheel-findings-release — 代理到 mind 的复核放行接口 (建议2)
// Body: { theme: string, findingId?: string }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const res = await fetch(MIND + "/api/v1/flywheel/findings/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({ error: "invalid json from mind" }));
    // 2026-09-10 人类干预埋点: 管理台"放行复核项"是人工动作 -> 记 HUMAN_INTERVENTION(用于真实自主率)
    if (res.ok && (data?.released ?? 0) > 0) {
      try {
        await fetch(MIND + "/api/v1/flywheel/interventions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "finding_release", actor: "admin", refId: String(body?.findingId || body?.theme || ""), note: "放行 " + data.released + " 条待复核发现" }),
          cache: "no-store",
        });
      } catch { /* 埋点失败不影响主流程 */ }
    }
    return NextResponse.json(data, { status: safeStatus(res.status) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
