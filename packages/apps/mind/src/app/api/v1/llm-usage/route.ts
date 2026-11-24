import { prisma } from "@/lib/prisma";
import { NextResponse } from 'next/server';
import { rangeFromRequest } from '@/lib/range';
// LLM 用量看板 (2026-09-22): 让消耗可见。用户曾问"minimax token 消耗少=飞轮没转?" —— 飞轮 24h 932 次 / 4.5M tokens / 99% MiniMax-M3, 没停, 只是没看板。
export const dynamic = 'force-dynamic';

function fmt(epochMs: any) { const d = epochMs instanceof Date ? epochMs : new Date(Number(epochMs)); return d.toISOString().slice(0, 16).replace('T', ' '); }

export async function GET(req: Request) {
  const now = Date.now();
  const h24 = now - 24 * 3600 * 1000;
  const d7 = now - 7 * 86400 * 1000;

  async function bucket(since: number) {
    const rows: any[] = (await prisma.$queryRawUnsafe(
      'SELECT "id","sourceType","sourceTitle","targetStage","createdAt" FROM "FlywheelEvent" WHERE "stage"=\'CALL_LLM\' AND "createdAt" >= ? ORDER BY "createdAt" DESC',
      since
    )) as any[];
    let totalTok = 0;
    const byEntry = new Map();
    const byModel = new Map();
    const hourMap = new Map();
    for (const r of rows) {
      const ts = r.createdAt instanceof Date ? r.createdAt.getTime() : Number(r.createdAt);
      let tok = 0;
      const m = String(r.sourceTitle || '').match(/^tok(?:=|\u2248)(\d+)/);
      if (m) tok = parseInt(m[1], 10);
      totalTok += tok;
      const entry = r.sourceType || 'unknown';
      const e = byEntry.get(entry) || { calls: 0, tokens: 0 };
      e.calls++; e.tokens += tok; byEntry.set(entry, e);
      const mm = String(r.sourceTitle || '').match(/model=([^\s]+)/);
      const model = mm ? mm[1] : 'unknown';
      const m2 = byModel.get(model) || { calls: 0, tokens: 0 };
      m2.calls++; m2.tokens += tok; byModel.set(model, m2);
      const hh = fmt(ts).slice(0, 13);
      const h = hourMap.get(hh) || { calls: 0, tokens: 0 };
      h.calls++; h.tokens += tok; hourMap.set(hh, h);
    }
    const byHour = [];
    for (const [k, v] of [...hourMap.entries()].sort()) byHour.push({ h: k, calls: v.calls, tokens: v.tokens });
    return { totalCalls: rows.length, totalTokens: totalTok, since, byEntry: [...byEntry.entries()].sort((a, b) => b[1].calls - a[1].calls), byModel: [...byModel.entries()].sort((a, b) => b[1].calls - a[1].calls), byHour };
  }

  const last24 = await bucket(h24);
  const last7 = await bucket(d7);
  // 2026-10-13 round 76-BZ: **opt-in** 时间窗 —— 只有显式传 ?range= 才算, 不传则保持原行为(不影响其它调用方)。
  const rf = rangeFromRequest(req);
  const win = rf ? await bucket(rf.since) : null;
  const cRows: any[] = (await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::bigint AS c FROM "FlywheelEvent" WHERE "stage"=\'CALL_LLM\' AND "createdAt" >= ?',
    now - 2 * 3600 * 1000
  )) as any[];
  const last2h = Number(cRows?.[0]?.c ?? 0);
  const alive = last2h > 0;
  return NextResponse.json({ at: fmt(now), alive, last2hCalls: last2h, last24, last7, ...(rf && win ? { range: rf.key, rangeLabel: rf.label, window: win } : {}) });
}
