import { NextRequest, NextResponse } from "next/server";
import { runReviewCycle } from "@/server/pipeline/review-cycle";
import { requireFeature } from "@/lib/license";

export const dynamic = "force-dynamic";

// GET  : 预览(不创建) — 但注意 runReviewCycle 的 git/DB 查询有成本, 仅用于查看轮值与证据包摘要
// POST : 创建本轮 PLATFORM_REVIEW 审查任务(轮值指派 agent, crontab 每天 09:00)
export async function GET() {
  // 2026-10-27 S2 授权门: platform.review（平台评审属 Pro）。
  //   预览也拦 —— 预览会跑轮值与证据包摘要（有 git/DB 成本），同样暴露能力。
  {
    const gate = requireFeature("platform.review");
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });
  }
  try { return NextResponse.json(await runReviewCycle({ create: false })); }
  catch (e: any) { return NextResponse.json({ error: e?.message || String(e) }, { status: 500 }); }
}
export async function POST(req: NextRequest) {
  // 2026-10-27 S2 授权门: **在创建审查任务之前**拒绝（平台数据线点名要求的负样本）。
  //   放在最前面：此时还没读 body、没算轮值、没写 Task，拒绝即零副作用。
  {
    const gate = requireFeature("platform.review");
    if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });
  }
  try {
    const b = await req.json().catch(() => ({}));
    return NextResponse.json(await runReviewCycle({ create: true, forceAgent: b?.agent ? String(b.agent) : undefined }));
  } catch (e: any) { return NextResponse.json({ error: e?.message || String(e) }, { status: 500 }); }
}
