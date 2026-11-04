/**
 * GET /api/v1/flywheel/improving-tasks — 列出 V1.6 ImprovingTask
 * V1.6 §3.1 API
 *
 * Query params:
 *   ?status=PENDING|DONE|FAILED|ALL (默认 PENDING)
 *   ?improvementType=FIX_THEME|FIX_CONFLICT|MIGRATE_DATA|RE_RUN
 *   ?theme=xxx
 *   ?limit=20 (默认 50, max 200)
 */
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "PENDING";
    const improvementType = url.searchParams.get("improvementType");
    const theme = url.searchParams.get("theme");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);

    const where: Record<string, unknown> = {
      improvementType: { not: null }, // 只要 V1.6 ImprovingTask
    };
    if (status !== "ALL") where.status = status;
    if (improvementType) where.improvementType = improvementType;
    if (theme) where.theme = theme;

    const tasks = await prisma.task.findMany({
      where,
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        theme: true,
        improvementType: true,
        manualReview: true,
        sourceReflectionIds: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        completedBy: true,
        // 2026-09-15 用户反馈「改进任务列表里我看不出来这个任务是哪个 agent 做的」:
        //   过去只返回 completedBy(未完成的任务恒为 null, 完成的任务又常是 cron:v16:improving-tasks 这类系统串),
        //   于是列表上"谁在做/谁做完了"基本看不见。补上承接执行体 assignedAgent。
        assignedAgent: true,
      },
      // 2026-09-01 排序规范: 有更新时间按更新时间倒序, 否则创建时间倒序
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
    });

    const byType: Record<string, number> = {};
    for (const t of tasks) {
      byType[t.improvementType || "NULL"] = (byType[t.improvementType || "NULL"] || 0) + 1;
    }

    // 2026-09-09 看板: 全局状态/类型计数 (一次 GROUP BY, 29k 行毫秒级)
    let counts: { byStatus: Record<string, number>; byType: Record<string, number>; total: number } = {
      byStatus: {}, byType: {}, total: 0,
    };
    try {
      const statusRows: any[] = await prisma.$queryRawUnsafe(
        "SELECT status, COUNT(*) c FROM Task WHERE improvementType IS NOT NULL GROUP BY status"
      );
      const typeRows: any[] = await prisma.$queryRawUnsafe(
        "SELECT improvementType, COUNT(*) c FROM Task WHERE improvementType IS NOT NULL GROUP BY improvementType"
      );
      counts.byStatus = Object.fromEntries(statusRows.map((r: any) => [r.status, Number(r.c)]));
      counts.byType = Object.fromEntries(typeRows.map((r: any) => [r.improvementType || "NULL", Number(r.c)]));
      counts.total = Object.values(counts.byStatus).reduce((a: number, b: number) => a + b, 0);
    } catch (e: any) {
      console.warn("[improving-tasks GET] counts failed (非致命): " + (e?.message || "").slice(0, 80));
    }

    return Response.json({
      total: tasks.length,
      filter: { status, improvementType, theme, limit },
      byType,
      counts,
      tasks,
    });
  } catch (e: any) {
    console.error("[improving-tasks GET]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
