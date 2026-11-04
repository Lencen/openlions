import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/flywheel/agent-loop — agent 自动循环健康度 (2026-09-10)
 * 用途: 一眼判断"macs/平台通知有没有 agent 回应"(用户关切) —— 而不是靠猜或轮询列表接口。
 * 输出: 待认领/进行中/近24h完成 与 按 agent 分布、最近一次认领与提交时刻、环比昨日。
 */
export async function GET() {
  try {
    const d1 = new Date(Date.now() - 24 * 3600 * 1000);
    const d2 = new Date(Date.now() - 48 * 3600 * 1000);
    const [pending, inProgress, done24h, donePrev24h, byAgent, lastExec, lastClaim] = await Promise.all([
      prisma.task.count({ where: { status: "PENDING" } }),
      prisma.task.count({ where: { status: { in: ["IN_PROGRESS"] } } }),
      prisma.taskExecution.count({ where: { createdAt: { gte: d1 } } }),
      prisma.taskExecution.count({ where: { createdAt: { gte: d2, lt: d1 } } }),
      prisma.taskExecution.groupBy({ by: ["agentId"], where: { createdAt: { gte: d1 } }, _count: { _all: true } }),
      prisma.taskExecution.findFirst({ orderBy: { createdAt: "desc" }, select: { agentId: true, createdAt: true } }),
      prisma.taskStateTransition.findFirst({ where: { toStatus: "IN_PROGRESS" }, orderBy: { createdAt: "desc" }, select: { actor: true, createdAt: true } }),
    ]);
    const idleMin = lastExec ? Math.round((Date.now() - new Date(lastExec.createdAt).getTime()) / 60000) : null;
    return NextResponse.json({
      ok: true,
      pendingClaimable: pending,
      inProgress,
      done24h,
      donePrev24h,
      trend: done24h - donePrev24h,
      byAgent: (byAgent as any[]).map((r) => ({ agent: r.agentId, done: r._count._all })),
      lastSubmitAt: lastExec?.createdAt ?? null,
      lastSubmitBy: lastExec?.agentId ?? null,
      lastClaimAt: lastClaim?.createdAt ?? null,
      lastClaimBy: lastClaim?.actor ?? null,
      idleMinutes: idleMin,
      alive: lastExec ? idleMin! < 30 : false,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
