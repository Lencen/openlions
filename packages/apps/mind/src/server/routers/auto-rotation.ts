import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { yesterdayBeijingStr } from "../lib/timezone";
import {
  getStatus,
  startRotation,
  stopRotation,
  runNow,
  initDailySummaryScheduler,
  initSkillUpgradeScheduler,
  generateDailySummaryForDate,
  syncPendingToLionsTask,
} from "../auto-rotation";

export const autoRotationRouter = createRouter({
  getStatus: publicProcedure.query(async () => {
    return getStatus();
  }),

  start: publicProcedure
    .input(
      z.object({
        cronExpression: z.string().optional(),
        maxPerRun: z.number().min(1).max(20).optional(),
        projectFilter: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      await startRotation(input);
      return { success: true };
    }),

  stop: publicProcedure.mutation(async () => {
    await stopRotation();
    return { success: true };
  }),

  runNow: publicProcedure.mutation(async () => {
    runNow().catch(console.error);
    return { success: true, message: "Pipeline run triggered" };
  }),

  generateDailySummary: publicProcedure
    .input(z.object({ date: z.string().optional() }))
    .mutation(async ({ input }) => {
      const targetDate = input.date || yesterdayBeijingStr(); // 默认昨天北京时间
      const result = await generateDailySummaryForDate(targetDate);
      if (result) {
        await syncPendingToLionsTask(targetDate);
      }
      return { success: true, date: targetDate, generated: !!result };
    }),

  getDailySummaries: publicProcedure
    .input(z.object({ startDate: z.string().optional(), endDate: z.string().optional() }))
    .query(async ({ input }) => {
      return prisma.dailySummary.findMany({
        where: {
          ...(input.startDate ? { date: { gte: input.startDate } } : {}),
          ...(input.endDate ? { date: { lte: input.endDate } } : {}),
        },
        orderBy: { date: "desc" },
      });
    }),

  startDailySummaryScheduler: publicProcedure.mutation(async () => {
    await initDailySummaryScheduler();
    return { success: true };
  }),

  // 技能提升定时任务调度
  startSkillUpgradeScheduler: publicProcedure.mutation(async () => {
    const results = await initSkillUpgradeScheduler();
    return { success: true, upgradedCount: results.length, upgradedSkills: results.map(r => ({ id: r.id, name: r.name, from: r.from, to: r.to })) };
  }),

  getTimeline: publicProcedure
    .input(z.object({ days: z.number().default(30) }))
    .query(async ({ input }) => {
      const since = new Date();
      since.setDate(since.getDate() - input.days);

      const logs = await prisma.syncLog.findMany({
        where: {
          startedAt: { gte: since },
        },
        orderBy: { startedAt: "asc" },
      });

      return logs.map((l) => ({
        date: l.startedAt.toISOString(),
        recordsSynced: l.recordsSynced,
        status: l.status,
        duration: l.completedAt
          ? Math.round(
              (l.completedAt.getTime() - l.startedAt.getTime()) / 1000
            )
          : null,
        sourceType: l.sourceType,
      }));
    }),

  getDistribution: publicProcedure.query(async () => {
    const [memories, knowledge, reflections, practices] = await Promise.all([
      prisma.memory.count({
        where: { sourceType: "CLAUDE_CONVERSATION" },
      }),
      prisma.knowledge.count({
        where: { sourceType: "CLAUDE_CONVERSATION" },
      }),
      prisma.reflection.count(),
      prisma.practice.count(),
    ]);

    return { memories, knowledge, reflections, practices };
  }),

  // B14/B15 修复 (2026-06-18 13:30): updateConfig 端点
  //   不依赖 start, RUNNING 状态也能改 cron/maxPerRun/projectFilter
  //   改后立即生效 (engine.ts restart scheduled task)
  updateConfig: publicProcedure
    .input(
      z.object({
        cronExpression: z.string().min(1).optional(),
        maxPerRun: z.number().min(1).max(20).optional(),
        projectFilter: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // 复用 startRotation 逻辑: 它内部会停止旧 task, 更新 DB, 重启 task
      await startRotation(input);
      return { success: true, message: "配置已更新" };
    }),
});
