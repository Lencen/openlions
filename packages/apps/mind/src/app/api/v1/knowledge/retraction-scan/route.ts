import { NextResponse } from "next/server";

/**
 * /api/v1/knowledge/retraction-scan — 会话"后续显式推翻"自动扫描
 *
 * 2026-10-26 SQLite 退役(P3): 原实现同时直连 mind/session 两个 dev.db，且依赖同步
 *   better-sqlite3 的 knowledge-retraction 接口。两个库都已退役，故入口显式 503。
 *   恢复路径：knowledge-retraction 改 PG（lions_mind + lions_session 两个只读连接）。
 */
export const dynamic = "force-dynamic";

function retired() {
  return NextResponse.json({
    ok: false,
    error: "SQLITE_RETIRED",
    detail: "retraction scan is not yet ported to PG; its mind/session dev.db sources are retired",
  }, { status: 503 });
}

export async function GET() { return retired(); }
export async function POST() { return retired(); }
