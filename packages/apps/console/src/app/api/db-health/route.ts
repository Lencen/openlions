import { NextResponse } from "next/server";
import { IS_PG, MIND_DB, queryFailures, queryFailureTotal, q, openMind } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-21 前端对账修复的配套观测面：把"查询失败"从静默变成可读。
// 背景：换 PG 后 `q()` 吞掉方言错误，页面把失败显示成 0（趋势全平、均值 0、会话 0）。
//   本端点让前端/排查能区分"真的没数据"和"查询坏了"。
export async function GET() {
  const db = openMind();
  const probe = db ? await q(db, "SELECT 1 AS ok") : [];
  return NextResponse.json({
    ok: probe.length === 1,
    driver: IS_PG ? "postgres" : "sqlite",
    pool: db ? "up" : "down",
    failures: queryFailures.length,
    // 2026-11-16（[team] 派单 / tq 溯源）：暴露单调失败总量。
    //   queryFailures 是 20 条环形缓冲（lions-db.ts shift），failures 恒 <=20 饱和，真实总数不可知；
    //   queryFailureTotal（lions-db.ts:114）不受 shift 影响，供判据做总量真门（cap=200）。
    //   failures / samples 字段语义不变（兼容既有判据，不破坏）。
    queryFailureTotal,
    samples: queryFailures.slice(-5).map((f) => ({ at: new Date(f.at).toISOString(), sql: f.sql, error: f.error })),
    asOf: new Date().toISOString(),
  });
}
