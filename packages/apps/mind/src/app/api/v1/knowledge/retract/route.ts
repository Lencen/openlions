import { NextResponse } from "next/server";

/**
 * /api/v1/knowledge/retract — 人工撤回入口
 *
 * 2026-10-26 SQLite 退役(P3): 本路由依赖的 knowledge-retraction 仍是**同步 better-sqlite3**
 *   接口（prepare/get/run/事务），尚未改写成 PG。按"fail-loud 而不是静默读旧库"的原则，
 *   入口显式返回 503，直到 PG 版实现落地。
 *
 * 恢复路径：把 knowledge-retraction 的 DB 接口改成 PG（runtime-repo / prisma raw），
 *   再删除本守卫。证据/交接见 verification/HANDOFF-SQLITE-RETIREMENT-2026-10-26.md。
 */
export const dynamic = "force-dynamic";

function retired() {
  return NextResponse.json({
    ok: false,
    error: "SQLITE_RETIRED",
    detail: "knowledge retraction is not yet ported to PG; it used to read prisma/dev.db, which is retired",
  }, { status: 503 });
}

export async function GET() { return retired(); }
export async function POST() { return retired(); }
