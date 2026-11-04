import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rangeFromRequest, resolveRange } from "@/lib/range";

export const dynamic = "force-dynamic";

// POST /api/v1/flywheel/interventions — 人类干预埋点 (2026-09-10)
// Body: { kind: string, actor?: string, refId?: string, note?: string }
// 落 FlywheelEvent(stage=HUMAN_INTERVENTION): 用于计算"真实自主率"(north star), 不新建表。
// kind 建议取值: human_message | task_reassign | finding_release | manual_trigger | agent_approval | manual_execute | other
export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => ({}));
    const kind = String(b?.kind || "other").slice(0, 40);
    const actor = b?.actor ? String(b.actor).slice(0, 80) : "human";
    const refId = b?.refId ? String(b.refId).slice(0, 120) : null;
    const note = b?.note ? String(b.note).slice(0, 400) : null;
    await prisma.flywheelEvent.create({
      data: {
        stage: "HUMAN_INTERVENTION",
        sourceType: kind,
        sourceId: refId ?? "",
        sourceTitle: (actor + (note ? " | " + note : "")).slice(0, 500),
        targetStage: "OK",
      },
    });
    return NextResponse.json({ ok: true, kind, refId });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

// GET — 人类干预计数(按类型), 供体检/看板。**默认近 24h**; 传 ?range= 则按顶栏时间范围(2026-10-13 round 76-DD)。
export async function GET(req: NextRequest) {
  try {
    // opt-in: 不传 range 时保持原行为(近 24h), 以免影响其它调用方。
    const rf = rangeFromRequest(req) ?? resolveRange("24h");
    const since = rf.key === "all" ? new Date(0) : new Date(rf.since);
    const rows = await prisma.$queryRawUnsafe<any[]>(("SELECT sourceType k, COUNT(*) c FROM FlywheelEvent WHERE stage='HUMAN_INTERVENTION' AND createdAt >= ? GROUP BY sourceType ORDER BY c DESC"), since);
    const total = (rows || []).reduce((a, r) => a + Number(r.c), 0);
    // 2026-09-10 修复: Prisma+SQLite 的 COUNT(*) 返回 BigInt -> JSON 序列化 500; 统一转 Number
    const byKind = (rows || []).map((r: any) => ({ k: r.k, c: Number(r.c) }));
    return NextResponse.json({ ok: true, windowHours: 24, range: rf.key, rangeLabel: rf.label, total, byKind });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
