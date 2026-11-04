import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/sync-activity?limit=100&offset=0&agent=&action=&platform=&from=&to=
// 数据长期保留 (DB 无清理), 分页可回溯任意历史
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100"), 1), 500);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0"), 0);
    const agent = url.searchParams.get("agent") || "";
    const action = url.searchParams.get("action") || "";
    const platform = url.searchParams.get("platform") || "";
    const from = url.searchParams.get("from") || ""; // ISO
    const to = url.searchParams.get("to") || "";

    const where: any = {};
    if (agent) where.agentId = agent;
    if (action) where.action = action;
    if (platform) where.platform = platform;
    if (from || to) {
      const range: any = {};
      if (from) { const d = new Date(from); if (!isNaN(d.getTime())) range.gte = d; }
      if (to) { const d = new Date(to); if (!isNaN(d.getTime())) range.lte = d; }
      if (Object.keys(range).length) where.ts = range;
    }

    const [rows, total] = await Promise.all([
      prisma.syncActivityLog.findMany({
        where,
        orderBy: { ts: "desc" },
        skip: offset,
        take: limit,
        select: {
          id: true, ts: true, agentId: true, platform: true, sessionUid: true,
          sourceId: true, title: true, action: true, msgCount: true, addedCount: true, source: true,
        },
      }),
      prisma.syncActivityLog.count({ where }),
    ]);

    // 今日各 agent 统计
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayRows = await prisma.syncActivityLog.findMany({
      where: { ts: { gte: todayStart } },
      select: { agentId: true, action: true, addedCount: true, msgCount: true },
    });
    const byAgent: Record<string, { uploads: number; added: number; updates: number }> = {};
    for (const r of todayRows) {
      const a = r.agentId || "?";
      if (!byAgent[a]) byAgent[a] = { uploads: 0, added: 0, updates: 0 };
      byAgent[a].uploads++;
      byAgent[a].added += r.addedCount;
      if (r.action === "UPDATE") byAgent[a].updates++;
    }

    return NextResponse.json({ success: true, total, offset, limit, rows, byAgent, generatedAt: new Date().toISOString() });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
