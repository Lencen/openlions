import { NextResponse } from "next/server";
import { macsReady, openMacs, q } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-21 MACS 消息库就绪探测（只读）。
// 2026-11-14（0.5.1）：增 queue 段，页面「积压」唯一口径 = 真积压（排除 null-target），
//   并单列 null-target INFO；asOf 由查完库后生成，供页面「数据时刻」使用。
const SQL_BACKLOG = `select count(*)::int as backlog from messages
where processing_state='queued' and delivery_status='pending'
  and target_session_id is not null
  and created_at < now() - interval '30 minutes'`;
const SQL_NULL_TARGET = `select count(*)::int as null_target_info from messages where target_session_id is null`;
const SQL_AUX = `select
  (select count(*)::int from dead_letter_queue where created_at > now()-interval '24 hours') as dlq_24h,
  (select count(*)::int from messages where delivery_status='expired' and created_at > now()-interval '24 hours') as expired_24h`;

export async function GET() {
  const r = await macsReady();
  const db = openMacs();
  let queue: { backlog: number; nullTargetInfo: number; dlq24h: number; expired24h: number } | null = null;
  let queueReason: string | null = null;
  if (db && r.ready) {
    try {
      const b = await q(db, SQL_BACKLOG);
      const n = await q(db, SQL_NULL_TARGET);
      const a = await q(db, SQL_AUX);
      queue = {
        backlog: Number(b[0]?.backlog ?? 0),
        nullTargetInfo: Number(n[0]?.null_target_info ?? 0),
        dlq24h: Number(a[0]?.dlq_24h ?? 0),
        expired24h: Number(a[0]?.expired_24h ?? 0),
      };
    } catch (e: any) {
      queueReason = String(e?.message || e);
    }
  } else {
    queueReason = r.reason || "MACS 库不可达";
  }
  return NextResponse.json({
    ok: true,
    db: "lions_macs",
    ready: r.ready,
    tables: r.tables ?? null,
    reason: r.reason ?? null,
    queue,
    queueReason,
    windowMin: 30,
    asOf: new Date().toISOString(),
  });
}
