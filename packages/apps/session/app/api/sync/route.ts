import { NextResponse } from "next/server";
import { syncSessions } from "@/lib/sync";
import { syncFromMind } from "@/lib/mind-sync";
import { startSyncScheduler, getSyncStatus } from "@/lib/scheduler";
import { loadScanSources } from "@/lib/scan-sources";
import { prisma } from "@/lib/prisma";
import { emitSessionSynced, emitSessionBatchStart, emitSessionBatchComplete } from "@/lib/event-bus";

// Start scheduler on first request
let schedulerStarted = false;
if (!schedulerStarted) {
  const interval = parseInt(process.env.SYNC_INTERVAL_MINUTES || "10");
  startSyncScheduler(interval);
  schedulerStarted = true;
}

export async function GET() {
  try {
    const wm = await prisma.syncWatermark.findMany({ orderBy: { source: "asc" } });
    return NextResponse.json({
      success: true,
      sources: loadScanSources(),
      scheduler: getSyncStatus(),
      watermarks: wm.map(w => ({
        source: w.source,
        lastTs: w.lastTs,
        lastRunAt: w.lastRunAt,
        lastCount: w.lastCount,
        lastError: w.lastError,
      })),
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const onlyMind = url.searchParams.get("mind") === "1";
  const onlyLocal = url.searchParams.get("local") === "1";
  const fullResync = url.searchParams.get("full") === "1";

  try {
    const t0 = Date.now();
    const out: Record<string, unknown> = { syncedAt: new Date().toISOString() };
    if (!onlyMind) {
      emitSessionBatchStart("local");
      const tLocal0 = Date.now();
      const localResult = await syncSessions();
      const localCount = (localResult as { sessions?: number })?.sessions ?? 0;
      emitSessionBatchComplete("local", localCount, Date.now() - tLocal0);
      emitSessionSynced("local", localCount, Date.now() - tLocal0);
      out.local = localResult;
    }
    if (!onlyLocal) {
      try {
        emitSessionBatchStart("mind");
        const tMind0 = Date.now();
        const mindResult = await syncFromMind({ fullResync });
        const mindCount = (mindResult as { count?: number })?.count ?? 0;
        emitSessionBatchComplete("mind", mindCount, Date.now() - tMind0);
        emitSessionSynced("mind", mindCount, Date.now() - tMind0);
        out.mind = mindResult;
      } catch (e) {
        out.mind = { error: String(e) };
      }
    }
    out.elapsedMs = Date.now() - t0;
    return NextResponse.json({ success: true, ...out });
  } catch (error) {
    console.error("Sync error:", error);
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
