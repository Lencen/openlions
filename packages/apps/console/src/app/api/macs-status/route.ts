import { NextResponse } from "next/server";
import { macsReady } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-21 MACS 消息库就绪探测（只读）。
// 用途：/messages 在 Wave 1.5 完成前只能跑示例数据；本端点让页面**诚实**地告诉用户
//   "现在看的是示例"还是"已接真实库"，而不是把空表当"0 条消息"。
export async function GET() {
  const r = await macsReady();
  return NextResponse.json({
    ok: true,
    db: "lions_macs",
    ready: r.ready,
    tables: r.tables ?? null,
    reason: r.reason ?? null,
    asOf: new Date().toISOString(),
  });
}
