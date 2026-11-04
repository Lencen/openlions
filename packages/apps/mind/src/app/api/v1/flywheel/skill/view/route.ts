import { NextRequest, NextResponse } from "next/server";
import { skillViewByName } from "@/server/pipeline/context-seed";

export const dynamic = "force-dynamic";

// ===== agent-x #2 Skills 按需加载 (方案 A) =====
// GET /api/v1/flywheel/skill/view?name=<技能名> — 按需取回技能全文(steps=content / trigger /
// verification / pitfalls 等)。加载层(platform 上下文注入)只给 {name,description} 轻量列表,
// agent 判定某技能可用时再以此端点按 name 精确取回全文, 不再 100+ 全文注入浪费 token。
// 与 /api/v1/skill/[id](按 id) 互补: 本端点面向"加载层只给名字"的消费方。
export async function GET(req: NextRequest) {
  try {
    const name = (req.nextUrl.searchParams.get("name") || "").trim();
    if (!name) return NextResponse.json({ ok: false, error: "missing name" }, { status: 400 });
    const skill = await skillViewByName(name);
    if (!skill) return NextResponse.json({ ok: false, error: "skill not found by name" }, { status: 404 });
    return NextResponse.json({ ok: true, skill });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
