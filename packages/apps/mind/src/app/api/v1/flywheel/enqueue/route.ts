import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/flywheel/enqueue
 * B4 (2026-07-12): 把飞轮任务入队 FlywheelJob (jobType=GLOBAL_ORGANIZE)
 *
 * 入参: { groupKey: string, priority?: P0|P1|P2|P3 }
 * 出参: { jobId, status, dedupHit }
 *
 * 防重复: idempotencyKey = "global-organize:{groupKey}"
 * 如果该 groupKey 已有 PENDING/QUEUED/RUNNING job, 返回 dedupHit=true 不新建
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const groupKey = body.groupKey;
    const priority = body.priority || "P2";

    if (!groupKey || typeof groupKey !== "string") {
      return NextResponse.json(
        { error: "groupKey required" },
        { status: 400 },
      );
    }

    const idempotencyKey = `global-organize:${groupKey}`;

    // 1. 防重复: 查已有 PENDING/QUEUED/RUNNING
    const existing = await prisma.flywheelJob.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true, attempts: true },
    });

    if (existing && ["PENDING", "QUEUED", "RUNNING"].includes(existing.status)) {
      return NextResponse.json({
        jobId: existing.id,
        status: existing.status,
        dedupHit: true,
        timestamp: new Date().toISOString(),
      });
    }

    // 2. 新建 (upsert 保证幂等)
    const job = await prisma.flywheelJob.upsert({
      where: { idempotencyKey },
      update: {
        status: "PENDING",
        priority,
        scheduledAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        jobType: "GLOBAL_ORGANIZE",
        status: "PENDING",
        priority,
        idempotencyKey,
        sessionUid: groupKey, // 借 sessionUid 存 groupKey (跨表复用)
      },
    });

    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      dedupHit: false,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}