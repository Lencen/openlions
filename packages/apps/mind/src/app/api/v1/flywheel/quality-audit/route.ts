import { NextResponse } from "next/server";
import { runQualityAudit } from "@/server/pipeline/quality-audit";

export const dynamic = "force-dynamic";

// GET /api/v1/flywheel/quality-audit — 产出质量不变量自检 (建议1; crontab 每日 00:20)
export async function GET() {
  try {
    const r = await runQualityAudit();
    return NextResponse.json(r, { status: r.violations === 0 ? 200 : 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
