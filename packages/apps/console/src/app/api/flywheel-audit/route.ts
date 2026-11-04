import { NextRequest, NextResponse } from "next/server";
import { q, one, openMind } from "@/lib/server/lions-db";

// 飞轮执行数据记录 API (2026-09-01 重构) — 业务审计
// 时间线: FlywheelEvent (scan/extract/write/reflect 各阶段产出) + 错误 (FlywheelErrorLog)
// 用途: 业务审计 — 什么时间扫描/提炼/反思, 结果如何
// 2026-10-21 Phase 2: 改走 PG 连接池（lions-db）
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const stage = sp.get("stage") || "";
  const status = sp.get("status") || ""; // ok/error
  const limit = Math.min(parseInt(sp.get("limit") || "50"), 200);
  const offset = Math.max(parseInt(sp.get("offset") || "0"), 0);

  const mind = openMind();
  try {
    const now = Date.now();

    // 1. 时间线: 最近 FlywheelEvent (按时间倒序)
    let sql = "SELECT stage, sourceType, sourceTitle, createdAt FROM FlywheelEvent WHERE 1=1";
    const params: any[] = [];
    if (stage) { sql += " AND stage = $1"; params.push(stage); }
    sql += " ORDER BY createdAt DESC LIMIT $2 OFFSET $3";
    params.push(limit, offset);
    const events = await q(mind, sql, ...params);

    // 2. 错误记录 (最近)
    const errors = await q(mind, 
      "SELECT errorType, stage, sessionId, message, occurredAt FROM FlywheelErrorLog ORDER BY occurredAt DESC LIMIT $1",
      status === "error" ? limit : 20
    );

    // 3. 执行统计 (今天)
    const today = new Date(); today.setHours(0,0,0,0);
    const todayMs = today.getTime();
    const byStage = await q(mind, 
      "SELECT stage, COUNT(*) as c FROM FlywheelEvent WHERE createdAt > $1 GROUP BY stage ORDER BY c DESC",
      todayMs
    );
    const errorCount = await one(mind, 
      "SELECT COUNT(*) as c FROM FlywheelErrorLog WHERE occurredAt > $1",
      todayMs
    );

    return NextResponse.json({
      events,
      errors,
      byStage,
      todayEvents: byStage.reduce((s: number, r: any) => s + r.c, 0),
      todayErrors: errorCount?.c ?? 0,
      limit,
      offset,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
