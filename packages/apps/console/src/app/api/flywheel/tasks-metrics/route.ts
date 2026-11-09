import { NextResponse } from "next/server";
import { openMind } from "@/lib/server/lions-db";

// 2026-11-06 · 数据卡 7 §6 缺的三个只读值：完成(7d) / 失败(7d) / P95(7d, 秒)
// 口径：docs/design/uiux-bento-2026-11/data-cards/card-7-flywheel-tasks.md 与 DATA-DICTIONARY 同名条目。
// 硬约束：取不到 -> null + reason（页面显示「不可得 + 原因」），不写 0。
export const dynamic = "force-dynamic";

export async function GET() {
  const asOf = new Date().toISOString();
  const empty = { done7d: null, failed7d: null, p95s: null, p95Sample: null, asOf, reason: null as string | null };
  let pool: any = null;
  try {
    pool = await openMind();
  } catch (e: any) {
    return NextResponse.json({ ...empty, reason: "打不开 lions_mind: " + (e?.message || e) });
  }
  try {
    const r = await pool.query(
      `select
         (select count(*)::int from "FlywheelJob"
           where status='DONE' and "completedAt" >= (now() at time zone 'UTC') - interval '7 days') as done7d,
         (select count(*)::int from "FlywheelJob"
           where status='FAILED' and "createdAt" >= (now() at time zone 'UTC') - interval '7 days') as failed7d,
         (select round(extract(epoch from percentile_cont(0.95) within group (order by ("completedAt" - "startedAt"))))::int
            from "FlywheelJob"
           where status='DONE' and "startedAt" is not null and "completedAt" is not null
             and "completedAt" >= (now() at time zone 'UTC') - interval '7 days') as p95s,
         (select count(*)::int from "FlywheelJob"
           where status='DONE' and "startedAt" is not null and "completedAt" is not null
             and "completedAt" >= (now() at time zone 'UTC') - interval '7 days') as p95_sample`,
    );
    const v = r.rows?.[0] || {};
    return NextResponse.json({
      done7d: v.done7d ?? null,
      failed7d: v.failed7d ?? null,
      p95s: v.p95s ?? null,
      p95Sample: v.p95_sample ?? null,
      asOf,
      reason: null,
    });
  } catch (e: any) {
    return NextResponse.json({ ...empty, reason: "查询失败: " + (e?.message || e) });
  }
}
