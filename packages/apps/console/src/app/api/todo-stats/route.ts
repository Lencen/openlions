import { NextResponse } from "next/server";
import { openMind, q } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

/**
 * /api/todo-stats — /todo 看板 KPI（D6-D12，2026-11-13）
 * 数据卡 card-todo.md 字典口径：
 *   · OPEN 数 = count where status='OPEN'（实测 112）
 *   · DOING 数 = count where status='DOING'（48）
 *   · 最老 OPEN 小时数 = round(max((now-createtime)/3600000))（1409）
 *   · OPEN 无 owner 数 = count where status='OPEN' and "ownerId" is null（83）
 * 列表接口（/api/todos）因上游脏时间可能 500；KPI 直读只读库，保证「数据在」可见。
 * 不返回硬编码；库不可用 -> 503 fail-closed。
 */
export async function GET() {
  const db = openMind();
  if (!db) return NextResponse.json({ ok: false, reason: "mind 只读库不可用" }, { status: 503 });
  try {
    const counts = (await q(db, 'SELECT status, count(*)::int AS n FROM "Todo" GROUP BY status')) || [];
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of counts) { const n = Number(r.n) || 0; byStatus[String(r.status || "").toUpperCase()] = n; total += n; }
    const oldest = await q(db, 'SELECT round(max((extract(epoch from now())*1000 - "createdAt")/3600000)) AS hours FROM "Todo" WHERE status = $1', "OPEN");
    const hours = oldest?.[0]?.hours != null ? Number(oldest[0].hours) : null;
    const noOwner = await q(db, 'SELECT count(*)::int AS n FROM "Todo" WHERE status = $1 AND "ownerId" IS NULL', "OPEN");
    const openNoOwner = noOwner?.[0]?.n != null ? Number(noOwner[0].n) : null;
    return NextResponse.json({
      ok: true, total, byStatus,
      open: byStatus.OPEN ?? 0, doing: byStatus.DOING ?? 0,
      oldestOpenHours: Number.isFinite(hours as number) ? hours : null,
      openNoOwner,
      asOf: new Date().toISOString(),
      source: 'mind "Todo".count/group by status；字典 :50-53',
      notes: ["逾期/今日完成为截断值（仅当前返回行），字典无全表口径 -> 不显示", "BLOCKED 状态不存在（库 0 行、字典无）-> 不设视图"],
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, reason: "Todo 统计失败：" + String(e?.message || e) }, { status: 500 });
  }
}
