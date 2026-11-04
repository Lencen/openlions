import { NextResponse } from "next/server";
import { openMind, q, asOf } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-20 R7（维度审计 B9-3）：改进任务的"卡住"信号。
// 为什么加：改进页只有 验收通过/未通过/待判定 三个数，看不出**有多少活堆着没动**。
//   实测 Task 表 PENDING 2,048 / BLOCKED 15 / IN_PROGRESS 9，其中 **389 个超过 7 天没有任何动作**。
// 口径（写进 basis，前端原样展示）：
//   · 未完成 = PENDING / IN_PROGRESS / BLOCKED（DEPRECATED/DONE/FAILED/DROPPED 都算已了结）；
//   · 超 7 天未动 = updatedAt 早于 7 天前；
//   · 最久 = 这些卡住任务里最早的 updatedAt 距今多少天；
//   · 全程只读；库不可达 -> ok:false，前端显示"暂无"而不是 0。
const OPEN = ["PENDING", "IN_PROGRESS", "BLOCKED"];
const BASIS = "未完成=PENDING/IN_PROGRESS/BLOCKED；超 7 天未动=updatedAt 早于 7 天前";

export async function GET() {
  const db = openMind();
  try {
    const rows = await q(db, "SELECT status, updatedAt FROM Task");
    const cut = Date.now() - 7 * 86400000;
    const byStatus: Record<string, number> = {};
    let openTotal = 0, stuck7 = 0, oldest = 0;
    for (const r of rows) {
      const s = String(r.status || "");
      if (!OPEN.includes(s)) continue;
      openTotal++;
      byStatus[s] = (byStatus[s] || 0) + 1;
      const u = Number(r.updatedAt) || 0;
      if (u && u < cut) {
        stuck7++;
        if (u < oldest || oldest === 0) oldest = u;
      }
    }
    const oldestDays = oldest ? Math.floor((Date.now() - oldest) / 86400000) : 0;
    return NextResponse.json({ ok: true, asOf: asOf(), basis: BASIS, openTotal, byStatus, stuck7, oldestDays });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 200 });
  }
}
