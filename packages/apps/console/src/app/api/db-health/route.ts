import { NextResponse } from "next/server";
import { IS_PG, MIND_DB, queryFailures, q, openMind } from "@/lib/server/lions-db";

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
    samples: queryFailures.slice(-5).map((f) => ({ at: new Date(f.at).toISOString(), sql: f.sql, error: f.error })),
    asOf: new Date().toISOString(),
  });
}
