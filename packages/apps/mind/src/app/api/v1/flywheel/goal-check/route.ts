import { NextRequest, NextResponse } from "next/server";
import { runGoalCheck } from "@/server/pipeline/goal-gap";
import { requireFeature } from "@/lib/license";

export const dynamic = "force-dynamic";

// GET  : 只评估(不建任务)
// POST : 评估 + 自动创建 GOAL_GAP 任务 (crontab 每 6 小时第 30 分)
export async function GET() {
  try { return NextResponse.json(await runGoalCheck({ create: false })); }
  catch (e: any) { return NextResponse.json({ error: e?.message || String(e) }, { status: 500 }); }
}
export async function POST(_req: NextRequest) {
  const gate = requireFeature("goal.autopilot"); // 功能授权门禁(交付后按授权开关)
  if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status });
  try { return NextResponse.json(await runGoalCheck({ create: true })); }
  catch (e: any) { return NextResponse.json({ error: e?.message || String(e) }, { status: 500 }); }
}
