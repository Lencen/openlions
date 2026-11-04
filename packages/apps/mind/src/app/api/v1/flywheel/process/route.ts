import { NextResponse } from "next/server";
import { execFileSync } from "node:child_process";
import { prisma } from "@/lib/prisma";
import { runGlobalOrganizer, updateExtractStatus } from "@/server/pipeline/global-organizer";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/flywheel/process
 * B4 (2026-07-12): FlywheelJob worker — 消费 PENDING job
 *
 * P1-3 修复 (2026-07-14, lions-selfimproving-task):
 *  - Bug 1: SELECT WHERE attempts < maxAttempts — 当 attempts 已经达到 maxAttempts 永远 false,
 *    任务永远卡 PENDING。修正为 attempts <= maxAttempts (允许最后一次 attempt 跑完)
 *  - Bug 2: SQLite WAL + prisma 5.22 dev mode 多 connection 时, prisma.flywheelJob.update 看似成功
 *    但实际不写到主 db, 后续 process 拉不到。兜底用 execFileSync('sqlite3') 直写, 绕开 prisma client
 *  - Bug 3: process 入口强制 PRAGMA wal_checkpoint(PASSIVE) 让 prisma client SELECT 同步看到最新状态
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const batchSize = body.batchSize ?? 3;
    const devDbPath = process.env.DEV_DB_PATH ||
      "./prisma/dev.db";

    // 0. 先强制 WAL checkpoint — 让所有 connection 看到最新 PENDING 状态
    try { await prisma.$queryRawUnsafe(`PRAGMA wal_checkpoint(PASSIVE)`); } catch {}

    // 1. 拉 PENDING job
    const jobs = await prisma.$queryRawUnsafe<Array<{
      id: string; jobType: string; sessionUid: string | null;
      attempts: number; maxAttempts: number; idempotencyKey: string;
    }>>(
      `SELECT id, jobType, sessionUid, attempts, maxAttempts, idempotencyKey
       FROM FlywheelJob
       WHERE status = 'PENDING'
         AND attempts <= maxAttempts
       ORDER BY
         CASE priority
           WHEN 'P0' THEN 0
           WHEN 'P1' THEN 1
           WHEN 'P2' THEN 2
           WHEN 'P3' THEN 3
           ELSE 4
         END ASC,
         scheduledAt ASC
       LIMIT ?`,
      batchSize,
    );

    const results: Array<{ jobId: string; status: string; duration?: number; error?: string }> = [];
    let succeeded = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        // 2. 标记 RUNNING (prisma 写不一定生效, 但 priority 是 sqlite3 CLI 兜底)
        await prisma.$executeRawUnsafe(
          `UPDATE FlywheelJob SET status='RUNNING', attempts=?, startedAt=?, updatedAt=? WHERE id=?`,
          job.attempts + 1, new Date(), new Date(), job.id,
        );
        try {
          execFileSync("sqlite3", [devDbPath,
            `UPDATE FlywheelJob SET status='RUNNING', attempts=${job.attempts + 1}, startedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updatedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='${job.id.replace(/'/g, "''")}';`,
          ], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
        } catch (e) { /* prisma write suffices, but log */ }

        if (job.jobType === "GLOBAL_ORGANIZE") {
          if (!job.sessionUid) throw new Error("sessionUid (groupKey) required");
          // 更新 SessionGroup 状态为 PROCESSING
          updateExtractStatus(job.sessionUid, "PROCESSING").catch(() => {});
          const result = await runGlobalOrganizer(job.sessionUid);
          const nowIso = new Date().toISOString();

          // 3. 标记 DONE - prisma 写 + sqlite3 CLI 兜底
          try {
            await prisma.$executeRawUnsafe(
              `UPDATE FlywheelJob SET status='DONE', completedAt=?, updatedAt=? WHERE id=?`,
              new Date(), new Date(), job.id,
            );
          } catch {}
          try {
            execFileSync("sqlite3", [devDbPath,
              `UPDATE FlywheelJob SET status='DONE', completedAt='${nowIso}', updatedAt='${nowIso}' WHERE id='${job.id.replace(/'/g, "''")}';`,
            ], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
            console.log(`[flywheel-worker] sqlite3 fallback OK ${job.id} -> DONE`);
          } catch (sqliteErr) {
            console.error(`[flywheel-worker] sqlite fallback FAIL for ${job.id}:`, sqliteErr);
          }
          // 更新 SessionGroup 状态为 DONE
          updateExtractStatus(job.sessionUid, "DONE").catch(() => {});
          await prisma.$queryRawUnsafe(`PRAGMA wal_checkpoint(PASSIVE)`).catch(() => {});

          succeeded++;
          results.push({ jobId: job.id, status: "DONE", duration: result.duration });
        } else {
          throw new Error(`unknown jobType: ${job.jobType}`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const attempts = job.attempts + 1;
        const exhausted = attempts >= job.maxAttempts;
        const failStatus = exhausted ? "FAILED" : "PENDING";
        const failCompletedAt = exhausted ? new Date().toISOString() : null;

        // 更新 SessionGroup 状态为 FAILED (仅当重试耗尽)
        if (exhausted && job.sessionUid) {
          updateExtractStatus(job.sessionUid, "FAILED", errMsg.substring(0, 500)).catch(() => {});
        }

        try {
          await prisma.$executeRawUnsafe(
            `UPDATE FlywheelJob SET status=?, error=?, completedAt=?, updatedAt=? WHERE id=?`,
            failStatus, errMsg.substring(0, 1000), failCompletedAt, new Date(), job.id,
          );
        } catch {}
        try {
          const compSql = failCompletedAt ? `'${failCompletedAt}'` : "NULL";
          execFileSync("sqlite3", [devDbPath,
            `UPDATE FlywheelJob SET status='${failStatus}', error='${errMsg.substring(0, 1000).replace(/'/g, "''")}', completedAt=${compSql}, updatedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='${job.id.replace(/'/g, "''")}';`,
          ], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
        } catch (sqliteErr) {
          console.error(`[flywheel-worker] sqlite fallback FAIL for ${job.id}:`, sqliteErr);
        }

        failed++;
        results.push({ jobId: job.id, status: exhausted ? "FAILED" : "PENDING_RETRY", error: errMsg.substring(0, 200) });
        console.error(`[flywheel-worker] job ${job.id} FAILED: ${errMsg}`);
      }
    }

    return NextResponse.json({
      processed: jobs.length, succeeded, failed, results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
