import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";

export const problemRouter = createRouter({
  list: publicProcedure
    .input(
      z.object({
        taskId: z.string().optional(),
        status: z.string().optional(),
        severity: z.string().optional(),
        // P3 修复: 默认隐藏已 MERGED 的 problem (业务规则放 SDK, 不靠 db hard delete)
        includeMerged: z.boolean().default(false),
        page: z.number().default(1),
        pageSize: z.number().default(50),
      })
    )
    .query(async ({ input }) => {
      // 2026-11-02: 改用 Prisma ORM，避免 raw SQL 未引用 "Problem"/camelCase 列在 PG 折叠成小写。
      const where: any = {};
      if (input.taskId) where.taskId = input.taskId;
      if (input.status) where.status = input.status;
      if (input.severity) where.severity = input.severity;
      if (!input.includeMerged) {
        where.NOT = { impactDescription: { contains: "[MERGED into" } };
      }
      const offset = (input.page - 1) * input.pageSize;
      const [itemsRaw, total] = await Promise.all([
        prisma.problem.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: input.pageSize,
        }),
        prisma.problem.count({ where }),
      ]);

      // 解析成 client 期望的 items 格式 (含嵌套 taskExecution.task include)
      const items = (itemsRaw as any[]).map((p) => ({
        ...p,
        taskExecution: { task: null }, // raw 不 join, 前端可能用 taskExecution.task; 给个空 obj
      }));
      return { items, total, page: input.page, pageSize: input.pageSize };
    }),

  get: publicProcedure.input(z.string()).query(async ({ input }) => {
    return prisma.problem.findUnique({
      where: { id: input },
      include: { taskExecution: { include: { task: true } } },
    });
  }),

  // 创建问题记录 — 通常由 recordExecution 内部调用
  create: publicProcedure
    .input(
      z.object({
        taskExecutionId: z.string(),
        taskId: z.string(),
        description: z.string(),
        severity: z.string().optional(),
        solutionsAttempted: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const problem = await prisma.problem.create({
        data: {
          taskExecutionId: input.taskExecutionId,
          taskId: input.taskId,
          description: input.description,
          severity: input.severity || "P2",
          solutionsAttempted: input.solutionsAttempted
            ? JSON.stringify(input.solutionsAttempted)
            : null,
          sourceType: "TASK",
        },
      });

      await prisma.flywheelEvent.create({
        data: {
          stage: "PROBLEM_FOUND",
          sourceType: "TASK_EXECUTION",
          sourceId: input.taskExecutionId,
          sourceTitle: input.description.slice(0, 50),
          targetStage: "PROBLEM",
          targetType: "PROBLEM",
          targetId: problem.id,
        },
      });

      return problem;
    }),

  // 更新问题状态
  updateStatus: publicProcedure
    .input(z.object({ id: z.string(), status: z.string(), rootCause: z.string().optional() }))
    .mutation(async ({ input }) => {
      const update: Record<string, unknown> = { status: input.status };
      if (input.status === "SOLVED") update.resolvedAt = new Date();
      if (input.rootCause) update.rootCause = input.rootCause;

      return prisma.problem.update({
        where: { id: input.id },
        data: update,
      });
    }),

  // 批量更新问题状态（用于清理积压数据）
  bulkUpdateStatus: publicProcedure
    .input(z.object({
      ids: z.array(z.string()),
      status: z.string(),
    }))
    .mutation(async ({ input }) => {
      const result = await prisma.problem.updateMany({
        where: { id: { in: input.ids } },
        data: {
          status: input.status,
          ...(input.status === "SOLVED" ? { resolvedAt: new Date() } : {}),
        },
      });
      return { updated: result.count };
    }),

  // 解决问题时，自动从问题生成改进任务（给 lions-mind 反思用）
  resolveAndCreateTask: publicProcedure
    .input(
      z.object({
        problemId: z.string(),
        rootCause: z.string(),
        solution: z.string(),
        lessons: z.string(),
        transferable: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // 1. 更新问题状态
      const problem = await prisma.problem.update({
        where: { id: input.problemId },
        data: {
          status: "SOLVED",
          rootCause: input.rootCause,
          resolvedAt: new Date(),
        },
      });

      // 2. 创建改进任务
      const improvementTask = await prisma.task.create({
        data: {
          title: `改进: ${problem.description.slice(0, 70)}`,
          description: `问题：${problem.description}\n根因：${input.rootCause}\n解决方案：${input.solution}\n经验：${input.lessons}`,
          background: `该任务来自问题解决后的改进项。问题ID: ${problem.id}`,
          requirements: `1. 分析根因：${input.rootCause}\n2. 将经验应用到类似场景\n3. 建立预防机制`,
          materials: `问题ID: ${problem.id}`,
          acceptanceCriteria: `1. 预防机制已建立\n2. 执行过程有记录`,
          qualityStandards: `改进行动具体可执行，预防机制有效`,
          priority: problem.severity === "P1" ? "P1" : "P2",
          sourceProblemId: problem.id,
          status: "PENDING",
        },
      });

      await prisma.flywheelEvent.create({
        data: {
          stage: "IMPROVEMENT_TASK",
          sourceType: "PROBLEM",
          sourceId: problem.id,
          sourceTitle: improvementTask.title,
          targetStage: "TASK",
          targetType: "TASK",
          targetId: improvementTask.id,
        },
      });

      return { problem, improvementTask };
    }),

  getStats: publicProcedure.query(async () => {
    const [total, open, solving, solved, abandoned] = await Promise.all([
      prisma.problem.count(),
      prisma.problem.count({ where: { status: "OPEN" } }),
      prisma.problem.count({ where: { status: "SOLVING" } }),
      prisma.problem.count({ where: { status: "SOLVED" } }),
      prisma.problem.count({ where: { status: "ABANDONED" } }),
    ]);
    return { total, open, solving, solved, abandoned };
  }),

  // 获取问题详情（含完整关联）
  getDetail: publicProcedure.input(z.string()).query(async ({ input }) => {
    const problem = await prisma.problem.findUnique({
      where: { id: input },
      include: {
        taskExecution: { include: { task: true } },
      },
    });
    if (!problem) return null;

    // P2-1: 同步状态 (查 FlywheelEvent)
    const syncEvents = await prisma.flywheelEvent.findMany({
      where: { sourceId: problem.id, stage: { in: ["PROBLEM_RESOLVED", "REFLECT", "MIND_SYNC"] } },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    const mindSynced = syncEvents.length > 0;
    const lastSyncEvent = syncEvents[0] ?? null;

    return {
      ...problem,
      mindSynced,
      lastMindSyncEvent: lastSyncEvent
        ? { stage: lastSyncEvent.stage, sourceType: lastSyncEvent.sourceType, createdAt: lastSyncEvent.createdAt }
        : null,
    };
  }),

  // 尝试自动解析问题
  attemptAutoResolve: publicProcedure
    .input(z.object({ problemId: z.string() }))
    .mutation(async ({ input }) => {
      const problem = await prisma.problem.findUnique({
        where: { id: input.problemId },
        include: { taskExecution: { include: { task: true } } },
      });
      if (!problem) throw new Error("Problem not found");

      // Mark as SOLVING
      await prisma.problem.update({
        where: { id: input.problemId },
        data: {
          status: "SOLVING",
          autoResolveAttempts: problem.autoResolveAttempts + 1,
          lastAttemptAt: new Date(),
        },
      });

      const { resolveProblem } = await import("@/server/agents/problem-resolver");
      const result = await resolveProblem({
        problem,
        taskExecution: problem.taskExecution,
        task: problem.taskExecution?.task ?? null,
      });

      if (result.resolved) {
        await prisma.problem.update({
          where: { id: input.problemId },
          data: {
            status: "SOLVED",
            rootCause: result.rootCause ?? undefined,
            resolvedAt: new Date(),
            resolutionAgentId: "AUTO_RESOLVER",
            resolutionNotes: result.notes ?? undefined,
          },
        });
        return { resolved: true, result };
      } else if (result.shouldCreateTask) {
        const resolutionTask = await prisma.task.create({
          data: {
            title: `解决: ${problem.description.slice(0, 60)}`,
            description: `问题: ${problem.description}\n\n根因分析: ${result.rootCause ?? "待分析"}\n\n建议解决方案: ${result.suggestedSolution ?? "待定"}`,
            background: `自动解析问题 ${problem.id}`,
            requirements: `1. 分析问题根因\n2. 实施解决方案\n3. 验证并确认`,
            materials: `问题ID: ${problem.id}`,
            acceptanceCriteria: `问题已解决，相关任务可以继续执行`,
            qualityStandards: `解决方案具体可执行`,
            priority: problem.severity === "P1" ? "P1" : "P2",
            sourceProblemId: problem.id,
            status: "PENDING",
          },
        });

        await prisma.problem.update({
          where: { id: input.problemId },
          data: { resolutionTaskId: resolutionTask.id },
        });

        return { resolved: false, shouldCreateTask: true, resolutionTask, result };
      }

      return { resolved: false, shouldCreateTask: false, result };
    }),

  // 从问题创建任务
  createTaskFromProblem: publicProcedure
    .input(z.object({ problemId: z.string() }))
    .mutation(async ({ input }) => {
      const problem = await prisma.problem.findUnique({ where: { id: input.problemId } });
      if (!problem) throw new Error("Problem not found");

      return prisma.task.create({
        data: {
          title: `处理问题: ${problem.description.slice(0, 60)}`,
          description: `问题: ${problem.description}\n严重程度: ${problem.severity}\n尝试过的方案: ${problem.solutionsAttempted ?? "无"}`,
          background: `问题驱动任务 — 问题ID: ${problem.id}`,
          requirements: `1. 分析问题\n2. 确定解决方案\n3. 实施并验证`,
          materials: `相关任务ID: ${problem.taskId}`,
          acceptanceCriteria: `问题已解决或已确定无法解决`,
          qualityStandards: `分析深入，方案合理`,
          priority: problem.severity === "P1" ? "P1" : "P2",
          sourceProblemId: problem.id,
          status: "PENDING",
        },
      });
    }),
});