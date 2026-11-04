import { NextResponse } from "next/server";
import { openMind, q, asOf } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-20 R6（维度审计 B9-4）：/todo 的来源与负责人分布 + 超 7 天未动。
// 为什么加：待办页只有"4 个总数 + 一条积压趋势"，看不出**是谁的活、从哪来的、有没有烂在队列里**。
// 口径（写进 basis，前端原样展示）：
//   · 只看未完成（OPEN / DOING / BLOCKED）——已关闭的不该占版面；
//   · 来源 source 原样分组，取前 6 类，其余合并为"其他"；
//   · 负责人 ownerType：human / agent；
//   · 超 7 天未动 = 未完成 且 updatedAt < now-7d（updatedAt 是最后动作时间）；
//   · 全程只读；库不可达 -> ok:false，前端显示"暂无"而不是 0。
const OPEN = ["OPEN", "DOING", "BLOCKED"];
const BASIS = "仅未完成（OPEN/DOING/BLOCKED）；超 7 天未动=updatedAt 早于 7 天前";

export async function GET() {
  const db = openMind();
  try {
    const all = await q(db, "SELECT source, ownerType, updatedAt, status FROM Todo");
    const open = all.filter((r) => OPEN.includes(String(r.status)));
    const bySourceMap = new Map<string, number>();
    const byOwner: Record<string, number> = { human: 0, agent: 0, other: 0 };
    let stale7 = 0;
    const cut = Date.now() - 7 * 86400000;
    for (const r of open) {
      const s = String(r.source || "未知");
      bySourceMap.set(s, (bySourceMap.get(s) || 0) + 1);
      const o = String(r.ownerType || "other");
      byOwner[o] = (byOwner[o] || 0) + 1;
      if (Number(r.updatedAt) && Number(r.updatedAt) < cut) stale7++;
    }
    const sorted = Array.from(bySourceMap.entries()).sort((a, b) => b[1] - a[1]);
    const bySource = sorted.slice(0, 6).map(([name, count]) => ({ name, count }));
    const otherCount = sorted.slice(6).reduce((a, [, c]) => a + c, 0);
    if (otherCount) bySource.push({ name: "其他", count: otherCount });
    return NextResponse.json({
      ok: true,
      asOf: asOf(),
      basis: BASIS,
      openTotal: open.length,
      bySource,
      byOwner,
      stale7,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 200 });
  }
}