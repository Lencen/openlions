import { sessionApiKey } from "@/lib/secret";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// ===== 2026-09-03: 聚合只入队"真实主题组", 排除 cron/untitled/机器桶 (聚合闭环 STEP3) =====
function isAggregatableGroupKey(groupKey: string): boolean {
  if (!groupKey) return false;
  const k = groupKey.trim();
  if (k.startsWith("cron")) return false;
  if (k.includes(":untitled") || k.endsWith(":untitled")) return false;
  if (/^\d{8}_\d{6}_/.test(k)) return false;
  if (/^[0-9a-f-]{20,}/.test(k)) return false;
  if (/\.che$/.test(k)) return false;
  if (/^\d+$/.test(k)) return false;
  return true;
}

/**
 * GET /api/v1/global-organizer/cron
 * 查 PENDING groups(真实主题组) -> 创建 FlywheelJob
 */
export async function GET() {
  try {
    try {
      await prisma.$queryRawUnsafe(`PRAGMA wal_checkpoint(PASSIVE)`);
    } catch { /* best-effort */ }

    const res = await fetch(
      "http://localhost:3002/api/v1/session-groups?status=PENDING&limit=50",
      {
        headers: { "X-API-Key": sessionApiKey() },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      return NextResponse.json({ error: `session API ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    const groups: Array<{ groupKey: string }> = (data.items || [])
      .filter((g: { groupKey: string }) => isAggregatableGroupKey(g.groupKey))
      .slice(0, 20);

    // Enqueue each group to FlywheelJob
    const enqueueResults = await Promise.all(
      groups.map(async (g: { groupKey: string }) => {
        const idempotencyKey = `global-organize:${g.groupKey}`;
        // 已有 PENDING/QUEUED/RUNNING job 则跳过
        const existing = await prisma.flywheelJob.findUnique({
          where: { idempotencyKey },
          select: { id: true, status: true },
        });
        if (existing && ["PENDING", "QUEUED", "RUNNING"].includes(existing.status)) {
          return {
            groupKey: g.groupKey,
            jobId: existing.id,
            status: existing.status,
            dedupHit: true,
          };
        }
        const job = await prisma.flywheelJob.upsert({
          where: { idempotencyKey },
          update: {
            status: "PENDING",
            scheduledAt: new Date(),
            updatedAt: new Date(),
          },
          create: {
            jobType: "GLOBAL_ORGANIZE",
            status: "PENDING",
            priority: "P2",
            idempotencyKey,
            sessionUid: g.groupKey,
          },
        });
        return {
          groupKey: g.groupKey,
          jobId: job.id,
          status: job.status,
          dedupHit: false,
        };
      }),
    );

    // P0 修复 (2026-07-23): cron 只创建 job, 实际处理由 flywheel-cron.sh 调 /api/v1/flywheel/process 完成
    // 之前在 cron route 里调 startOrganizeTask 导致与 process endpoint 竞争 (两个 runGlobalOrganizer 同时跑)
    // WAL flush: 让 process endpoint 的 raw SQL 能看到 Prisma 写入的 PENDING job
    try { await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(PASSIVE)'); } catch {}
    return NextResponse.json({
      triggered: enqueueResults.length,
      tasks: enqueueResults,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}