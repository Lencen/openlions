import { NextResponse } from "next/server";
import { readConfigAudits } from "@/lib/server/model-config-status";

export const dynamic = "force-dynamic";

/**
 * GET /api/model-config/audit —— 审计回显（基线 §1「审计回显 s12：最近 N 条 config.update」）。
 *
 * 硬约束：**只回变更键名，不回值**（读取层已只取 metadata.diffKeys；
 * before/after 列根本不进 SELECT）。读不到 -> ok:false + 原因，页面 n/a，不写 0 冒充。
 */
export async function GET() {
  try {
    const r = await readConfigAudits(10);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.reason || "审计不可得", items: null }, { status: 503 });
    return NextResponse.json({ ok: true, items: r.items, asOf: r.asOf, count: (r.items || []).length });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "审计读取失败", detail: String((e as Error)?.message || e).slice(0, 160), items: null },
      { status: 500 }
    );
  }
}
