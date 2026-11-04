import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import {
  getTaskBatchSize, getProblemBatchSize,
  setTaskBatch, setProblemBatch,
  defaultTaskBatch, defaultProblemBatch,
  getTaskSmartMode, getProblemSmartMode,
  getRuntimeConfig,
} from "../agents/runtime-config";

// ============ 原因标准化映射 ============
// 将长文本原因映射到短类别标签
const normalizeReason = (raw: string | null): { category: string; shortLabel: string } => {
  if (!raw) return { category: "UNKNOWN", shortLabel: "未知" };
  const text = raw.toLowerCase();

  // API限流
  if (text.includes("429") || text.includes("too many requests") || text.includes("rate limit"))
    return { category: "RATE_LIMIT", shortLabel: "API限流" };

  // 认证问题
  if (text.includes("auth") || text.includes("token") || text.includes("anthropic") || text.includes("api key"))
    return { category: "AUTH_ERROR", shortLabel: "认证缺失" };

  // 质量不通过
  if (text.includes("quality") || text.includes("generic template") || text.includes("generic"))
    return { category: "QUALITY_FAILED", shortLabel: "质量不通过" };

  // 超时
  if (text.includes("timeout") || text.includes("timed out") || text.includes("request timeout"))
    return { category: "TIMEOUT", shortLabel: "超时" };

  // 连接错误
  if (text.includes("connect") || text.includes("connection") || text.includes("econnrefused") || text.includes("enetunreach"))
    return { category: "CONN_ERROR", shortLabel: "连接错误" };

  // 信息缺失
  if (text.includes("missing") || text.includes("缺少") || text.includes("缺失") || text.includes("not set") || text.includes("undefined"))
    return { category: "MISSING_INFO", shortLabel: "信息缺失" };

  // 阻塞/依赖
  if (text.includes("blocked") || text.includes("block") || text.includes("unblock") || text.includes("阻塞") || text.includes("等待"))
    return { category: "BLOCKED", shortLabel: "依赖阻塞" };

  // 代码错误
  if (text.includes("syntax") || text.includes("error") || text.includes("cannot find module") || text.includes("import error"))
    return { category: "CODE_ERROR", shortLabel: "代码错误" };

  return { category: "UNKNOWN", shortLabel: "其他" };
};

export const dashboardRouter = createRouter({
  overview: publicProcedure.query(async () => {
    const [taskStats, taskExecStats, problemStats, recentExecutions, queueDepth, flywheelStages] =
      await Promise.all([
        prisma.task.groupBy({
          by: ["status"],
          _count: true,
        }),
        prisma.taskExecution.groupBy({
          by: ["status"],
          _count: true,
        }),
        prisma.problem.groupBy({
          by: ["status"],
          _count: true,
        }),
        prisma.taskExecution.groupBy({
          by: ["status"],
          where: {
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
          _count: true,
        }),
        prisma.task.groupBy({
          by: ["priority"],
          where: { status: "PENDING" },
          _count: true,
        }),
        prisma.flywheelEvent.groupBy({
          by: ["stage"],
          _count: true,
        }),
      ]);

    const [overdueTasksRaw, highRetryTasks, failedTasksWithReason, stuckCount] =
      await Promise.all([
        // 超时任务: 预估时间 < 实际时间，且未完成的任务
        prisma.task.findMany({
          where: {
            status: { not: "COMPLETED" },
            actualEffortMs: { not: null },
            estimatedEffort: { not: null },
          },
          select: {
            id: true,
            title: true,
            status: true,
            actualEffortMs: true,
            estimatedEffort: true,
            createdAt: true,
          },
          take: 20,
          orderBy: { createdAt: "desc" },
        }),
        prisma.task.findMany({
          where: {
            retryCount: { gte: 1 },
            status: { not: "COMPLETED" },
          },
          select: {
            id: true,
            title: true,
            status: true,
            retryCount: true,
            maxRetries: true,
            createdAt: true,
          },
          take: 10,
          orderBy: { createdAt: "desc" },
        }),
        // 失败任务及其失败原因 (先获取FAILED任务，再获取其最后一次执行的信息)
        (async () => {
          const failedTasks = await prisma.task.findMany({
            where: { status: "FAILED" },
            select: { id: true, title: true, status: true, retryCount: true, createdAt: true },
            take: 10,
            orderBy: { createdAt: "desc" },
          });
          if (failedTasks.length === 0) return [];
          // 获取这些任务的最新执行记录中的 blocks
          const taskIds = failedTasks.map(t => t.id);
          const lastExecutions = await prisma.taskExecution.findMany({
            where: { taskId: { in: taskIds } },
            select: { taskId: true, blocks: true },
            orderBy: { createdAt: "desc" },
          });
          const execMap: Record<string, string | null> = {};
          for (const e of lastExecutions) {
            if (!execMap[e.taskId]) execMap[e.taskId] = e.blocks;
          }
          return failedTasks.map(t => ({ id: t.id, title: t.title, status: t.status, retryCount: t.retryCount, createdAt: t.createdAt, blocks: execMap[t.id] ?? null }));
        })(),
        // 卡死的 TaskExecution(>30min IN_PROGRESS)— 用于顶部 KPI "卡住"卡片
        prisma.taskExecution.count({
          where: {
            status: "IN_PROGRESS",
            startedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
          },
        }),
      ]);

    // 超时任务: 实际时间 > 预估时间
    const overdueTasks = overdueTasksRaw.filter(t => {
      if (!t.actualEffortMs) return false;
      const est = Number(t.estimatedEffort);
      return Number.isFinite(est) && t.actualEffortMs > est;
    }).slice(0, 10);

    const currentlyProcessing = await prisma.task.count({
      where: { status: "IN_PROGRESS" },
    });

    const recentLogs = await prisma.taskExecution.findMany({
      orderBy: { createdAt: "desc" },
      take: 15,
      select: {
        id: true,
        status: true,
        qualityPassed: true,
        createdAt: true,
        task: { select: { id: true, title: true } },
      },
    });

    return {
      taskStats,         // Task 表(任务级,无 IN_PROGRESS)
      taskExecStats,     // TaskExecution 表(执行级,含 IN_PROGRESS)
      problemStats,
      recentExecutions,
      queueDepth,
      flywheelStages,
      overdueTasks,
      highRetryTasks,
      failedTasksWithReason,
      currentlyProcessing,
      recentLogs,
      stuckCount,         // >30min IN_PROGRESS 的 TaskExecution 数(顶部 KPI "卡住"用)
    };
  }),

  getThroughput: publicProcedure
    .input(
      z.object({
        days: z.number().default(7),
      })
    )
    .query(async ({ input }) => {
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
      const executions = await prisma.taskExecution.findMany({
        where: {
          status: "COMPLETED",
          completedAt: { gte: since },
        },
        select: {
          completedAt: true,
          startedAt: true,
        },
      });

      const byDay: Record<string, { completed: number; avgDurationMs: number }> = {};
      for (const e of executions) {
        if (!e.completedAt) continue;
        const day = e.completedAt.toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { completed: 0, avgDurationMs: 0 };
        byDay[day].completed++;
        if (e.startedAt && e.completedAt) {
          byDay[day].avgDurationMs += e.completedAt.getTime() - e.startedAt.getTime();
        }
      }

      for (const day of Object.keys(byDay)) {
        if (byDay[day].completed > 0) {
          byDay[day].avgDurationMs = Math.round(byDay[day].avgDurationMs / byDay[day].completed);
        }
      }

      return byDay;
    }),

  getHourlyTrend: publicProcedure.query(async () => {
    const UTC8_OFFSET = 8 * 60 * 60 * 1000;
    // 正确计算北京时间今天00:00的UTC时间
    const now = new Date();
    const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
    const todayStart = new Date(utcMidnight);

    const executions = await prisma.taskExecution.findMany({
      where: { createdAt: { gte: todayStart } },
      select: { status: true, createdAt: true, completedAt: true },
    });

    const problems = await prisma.problem.findMany({
      where: { createdAt: { gte: todayStart } },
      select: { status: true, createdAt: true },
    });

    const hourlyData = Array.from({ length: 24 }, (_, hour) => ({ hour, tasks: 0, problems: 0 }));

    for (const e of executions) {
      const time = e.completedAt || e.createdAt;
      const beijingTime = new Date(time.getTime() + UTC8_OFFSET);
      const hour = beijingTime.getUTCHours(); // 使用getUTCHours()获取UTC小时（北京时间）
      if (e.status === "COMPLETED" || e.status === "FAILED") {
        hourlyData[hour].tasks++;
      }
    }

    for (const p of problems) {
      const beijingTime = new Date(p.createdAt.getTime() + UTC8_OFFSET);
      const hour = beijingTime.getUTCHours();
      hourlyData[hour].problems++;
    }

    return hourlyData;
  }),

  getRetryAnalysis: publicProcedure.query(async () => {
    // 获取今日重试统计
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const UTC8_OFFSET = 8 * 60 * 60 * 1000;
    const beijingToday = new Date(todayStart.getTime() + UTC8_OFFSET);

    const [retryTasks, todayRetryTasks, recentExecutions] = await Promise.all([
      prisma.task.findMany({
        where: { retryCount: { gte: 1 } },
        select: { id: true, title: true, status: true, retryCount: true },
        take: 100,
        orderBy: { createdAt: "desc" },
      }),
      // 今日重试的任务（通过 recentExecutions 中 status=FAILED 的任务来推断）
      prisma.taskExecution.findMany({
        where: {
          createdAt: { gte: beijingToday },
          status: "FAILED",
        },
        select: { id: true, blocks: true, createdAt: true },
        take: 100,
      }),
      // 获取最近的重试原因（从 blocks 字段提取）
      prisma.taskExecution.findMany({
        where: {
          status: { in: ["FAILED", "BLOCKED"] },
          blocks: { not: null },
        },
        select: { blocks: true },
        take: 50,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const totalTasks = await prisma.task.count();
    const retryRate = totalTasks > 0 ? (retryTasks.length / totalTasks) * 100 : 0;

    // 统计重试原因分布
    const retryReasonCount: Record<string, number> = {};
    for (const e of recentExecutions) {
      if (e.blocks) {
        // 提取失败原因关键词
        const reason = e.blocks.slice(0, 50);
        retryReasonCount[reason] = (retryReasonCount[reason] || 0) + 1;
      }
    }
    // 取前5个最常见的失败原因
    const topRetryReasons = Object.entries(retryReasonCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));

    return {
      retryTasks,
      totalRetries: retryTasks.reduce((sum, t) => sum + t.retryCount, 0),
      retryRate: Math.round(retryRate * 10) / 10,
      todayRetries: todayRetryTasks.length,
      topRetryReasons,
    };
  }),

  getFailedReasonDistribution: publicProcedure.query(async () => {
    try {
      const failedTasks = await prisma.task.findMany({
        where: { status: "FAILED" },
        select: { id: true },
      });
      if (failedTasks.length === 0) return [];

      const reasonCount: Record<string, number> = {};
      const batchSize = 500;

      for (let i = 0; i < failedTasks.length; i += batchSize) {
        const batchTasks = failedTasks.slice(i, i + batchSize);
        const batchIds = batchTasks.map(t => t.id);

        const lastExecutions = await prisma.taskExecution.findMany({
          where: { taskId: { in: batchIds } },
          select: { taskId: true, problemsEncountered: true, blocks: true },
          orderBy: { createdAt: "desc" },
        });

        const execMap: Record<string, string | null> = {};
        for (const e of lastExecutions) {
          if (!execMap[e.taskId]) {
            execMap[e.taskId] = e.problemsEncountered || e.blocks;
          }
        }

        for (const t of batchTasks) {
          const reason = execMap[t.id];
          const { category, shortLabel } = normalizeReason(reason);
          const key = category === "UNKNOWN" ? "其他" : shortLabel;
          reasonCount[key] = (reasonCount[key] || 0) + 1;
        }
      }

      return Object.entries(reasonCount)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count }));
    } catch (e) {
      console.error("[getFailedReasonDistribution] error:", e);
      return [];
    }
  }),

  getRetryReasonDistribution: publicProcedure.query(async () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const UTC8_OFFSET = 8 * 60 * 60 * 1000;
    const beijingToday = new Date(todayStart.getTime() + UTC8_OFFSET);

    // 获取今日失败的执行记录（不限数量）
    const recentExecutions = await prisma.taskExecution.findMany({
      where: {
        createdAt: { gte: beijingToday },
        status: { in: ["FAILED"] },
      },
      select: { problemsEncountered: true, blocks: true },
      orderBy: { createdAt: "desc" },
    });

    // 统计原因
    const reasonCount: Record<string, number> = {};
    for (const e of recentExecutions) {
      const reason = e.problemsEncountered || e.blocks;
      if (reason) {
        const { shortLabel } = normalizeReason(reason);
        reasonCount[shortLabel] = (reasonCount[shortLabel] || 0) + 1;
      } else {
        reasonCount["其他"] = (reasonCount["其他"] || 0) + 1;
      }
    }

    const todayFailed = recentExecutions.length;

    const distribution = Object.entries(reasonCount)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count }));

    console.log(`[getRetryReasonDistribution] todayFailed=${todayFailed}, categories=${distribution.length}`);
    return {
      todayRetries: todayFailed,
      distribution,
    };
  }),

  getBlockedReasonDistribution: publicProcedure.query(async () => {
    try {
      // 获取所有阻塞任务的ID
      const blockedTasks = await prisma.task.findMany({
        where: { status: "BLOCKED" },
        select: { id: true },
      });

      if (blockedTasks.length === 0) return [];

      const taskIds = blockedTasks.map(t => t.id);

      // 分批查询（每批500）来避免SQL限制
      const blocksCount: Record<string, number> = {};
      const batchSize = 500;

      for (let i = 0; i < taskIds.length; i += batchSize) {
        const batchIds = taskIds.slice(i, i + batchSize);
        const executions = await prisma.taskExecution.findMany({
          where: { taskId: { in: batchIds } },
          select: { taskId: true, problemsEncountered: true, blocks: true },
          orderBy: { createdAt: "desc" },
        });

        // 只保留每个任务的最新记录
        const latestForTask: Record<string, string | null> = {};
        for (const e of executions) {
          if (!latestForTask[e.taskId]) {
            // 优先使用problemsEncountered
            latestForTask[e.taskId] = e.problemsEncountered || e.blocks;
          }
        }

        // 统计
        for (const taskId of batchIds) {
          const blocks = latestForTask[taskId];
          if (blocks) {
            const { shortLabel } = normalizeReason(blocks);
            blocksCount[shortLabel] = (blocksCount[shortLabel] || 0) + 1;
          }
        }
      }

      // 没有blocks的就是其他
      const totalBlocked = blockedTasks.length;
      const withBlocksTotal = Object.values(blocksCount).reduce((a, b) => a + b, 0);
      const withoutBlocks = totalBlocked - withBlocksTotal;

      if (withoutBlocks > 0) {
        blocksCount["其他"] = withoutBlocks;
      }

      const result = Object.entries(blocksCount)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count }));

      console.log(`[getBlockedReasonDistribution] total=${totalBlocked}, withBlocks=${withBlocksTotal}, withoutBlocks=${withoutBlocks}`);
      return result;
    } catch (e) {
      console.error("getBlockedReasonDistribution error:", e);
      return [];
    }
  }),

  getCancelledReasonDistribution: publicProcedure.query(async () => {
    const cancelledTasks = await prisma.task.findMany({
      where: { status: "CANCELLED" },
      select: { id: true },
      take: 500,  // P3 修复: 限制查询量, 避免 prisma 5.22 SQLite 大 in 列表 panic
    });
    if (cancelledTasks.length === 0) return [];
    const taskIds = cancelledTasks.map(t => t.id);
    // P3 修复: 不 select blocks (TEXT 可能很长), 改为 orderBy + 客户端聚合
    const lastExecutions = await prisma.taskExecution.findMany({
      where: { taskId: { in: taskIds } },
      select: { taskId: true, blocks: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 1000,  // 限制
    });
    const execMap: Record<string, string | null> = {};
    for (const e of lastExecutions) {
      if (!execMap[e.taskId]) execMap[e.taskId] = e.blocks;
    }
    const reasonCount: Record<string, number> = {};
    for (const t of cancelledTasks) {
      const { shortLabel } = normalizeReason(execMap[t.id]);
      reasonCount[shortLabel] = (reasonCount[shortLabel] || 0) + 1;
    }
    return Object.entries(reasonCount)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count }));
  }),

  getAbandonedReasonDistribution: publicProcedure.query(async () => {
    const abandoned = await prisma.problem.findMany({
      where: { status: "ABANDONED" },
      select: { rootCause: true, description: true },
    });
    const reasonCount: Record<string, number> = {};
    for (const p of abandoned) {
      const raw = p.rootCause || p.description || null;
      const { shortLabel } = normalizeReason(raw);
      reasonCount[shortLabel] = (reasonCount[shortLabel] || 0) + 1;
    }
    return Object.entries(reasonCount)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count }));
  }),

  getThroughputPer10Min: publicProcedure.query(async () => {
    // P3 修复: try/catch 兜底, 避免 prisma 5.22 SQLite 大数据量 panic 让整个 dashboard 500
    try {
    const UTC8_OFFSET = 8 * 60 * 60 * 1000;
    const now = Date.now();
    const beijingNow = new Date(now + UTC8_OFFSET);
    // Beijing midnight in UTC: subtract 8 hours from UTC midnight of the same Beijing date
    const beijingMidnightUTC = new Date(Date.UTC(beijingNow.getUTCFullYear(), beijingNow.getUTCMonth(), beijingNow.getUTCDate(), 0, 0, 0, 0) - UTC8_OFFSET);

    // 计算当前时间属于第几个10分钟窗口（0-143）
    const msIntoDay = beijingNow.getTime() - beijingMidnightUTC.getTime();
    const currentWindowIdx = Math.floor(msIntoDay / (10 * 60 * 1000));

    // 取最近24小时的数据（覆盖跨天情况）
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
    // P3 修复: 限制 take 避免 prisma 5.22 SQLite 大数据量 panic
    const [executions, problems, flywheelEvents] = await Promise.all([
      prisma.taskExecution.findMany({
        where: { completedAt: { gte: oneDayAgo }, status: "COMPLETED" },
        select: { completedAt: true },
        take: 5000,
      }),
      prisma.problem.findMany({
        where: { updatedAt: { gte: oneDayAgo }, status: { in: ["SOLVED", "ABANDONED"] } },
        select: { updatedAt: true },
        take: 5000,
      }),
      prisma.flywheelEvent.findMany({
        where: { createdAt: { gte: oneDayAgo } },
        select: { createdAt: true },
        take: 5000,
      }),
    ]);

    // 生成最近12个10分钟窗口（从当前窗口往前）
    const windows: Array<{ window: string; tasks: number; problems: number; flywheel: number }> = [];
    for (let offset = 11; offset >= 0; offset--) {
      const windowIdx = currentWindowIdx - offset;
      // 跨天处理：如果 windowIdx < 0，说明是前一天
      const adjustedIdx = windowIdx < 0 ? windowIdx + 144 : windowIdx;
      const windowStart = new Date(beijingMidnightUTC.getTime() + adjustedIdx * 10 * 60 * 1000);
      const windowEnd = new Date(windowStart.getTime() + 10 * 60 * 1000);
      const windowStr = `${String(windowStart.getUTCHours()).padStart(2, "0")}:${String(Math.floor(windowStart.getUTCMinutes() / 10) * 10).padStart(2, "0")}`;

      const taskCount = executions.filter(e => {
        if (!e.completedAt) return false;
        const t = new Date(e.completedAt.getTime() + UTC8_OFFSET);
        return t >= windowStart && t < windowEnd;
      }).length;

      const problemCount = problems.filter(p => {
        const t = new Date(p.updatedAt.getTime() + UTC8_OFFSET);
        return t >= windowStart && t < windowEnd;
      }).length;

      const flywheelCount = flywheelEvents.filter(f => {
        const t = new Date(f.createdAt.getTime() + UTC8_OFFSET);
        return t >= windowStart && t < windowEnd;
      }).length;

      windows.push({ window: windowStr, tasks: taskCount, problems: problemCount, flywheel: flywheelCount });
    }

    return windows;
    } catch (e: any) {
      // P3 兜底: 返空数组 + 警告, 不让 dashboard 整个崩
      console.warn("[getThroughputPer10Min] failed (prisma SQLite panic), returning empty:", e?.message?.slice(0, 100));
      return [];
    }
  }),

  // ============ 并行资源面板(任务端) ============
  // 当前正在消耗资源的 agent 任务数
  taskResources: publicProcedure.query(async () => {
    const [runningTaskExecutions, pendingTasks, stuckCount] = await Promise.all([
      prisma.taskExecution.findMany({
        where: { status: "IN_PROGRESS" },
        select: {
          id: true,
          taskId: true,
          agentId: true,
          agentRole: true,
          startedAt: true,
          task: { select: { title: true, priority: true } },
        },
        orderBy: { startedAt: "desc" },
        take: 50,
      }),
      prisma.task.count({ where: { status: "PENDING" } }),
      prisma.taskExecution.count({
        where: {
          status: "IN_PROGRESS",
          startedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
        },
      }),
    ]);

    // 智能模式: 按队列公式;固定模式: 用户 override(或 default)
    const taskSmart = getTaskSmartMode();
    const formulaBatch = pendingTasks > 1000 ? 100
      : pendingTasks > 500 ? 80
      : pendingTasks > 200 ? 50
      : pendingTasks > 50 ? 20
      : 10;
    const batchSize = taskSmart
      ? formulaBatch
      : (getTaskBatchSize() !== defaultTaskBatch ? getTaskBatchSize() : defaultTaskBatch);

    return {
      engineType: "task" as const,
      runningCount: runningTaskExecutions.length,
      stuckCount,
      batchSize,  // 实际生效的 batch
      pendingCount: pendingTasks,
      utilizationPct: batchSize > 0 ? Math.round((runningTaskExecutions.length / batchSize) * 100) : 0,
      // 运行时配置(智能模式 + override)
      smartMode: getTaskSmartMode(),
      batchOverride: getTaskBatchSize() !== defaultTaskBatch ? getTaskBatchSize() : null,
      batchDefault: defaultTaskBatch,
      runningTasks: runningTaskExecutions.map((e) => ({
        executionId: e.id,
        taskId: e.taskId,
        title: e.task?.title ?? "(无标题)",
        priority: e.task?.priority ?? null,
        agentId: e.agentId,
        agentRole: e.agentRole,
        startedAt: e.startedAt,
        runningMs: e.startedAt ? Date.now() - e.startedAt.getTime() : 0,
      })),
      serverTime: new Date().toISOString(),
    };
  }),

  // ============ 并行资源面板(问题端) ============
  // 当前正在消耗资源处理的问题
  problemResources: publicProcedure.query(async () => {
    const [solvingProblems, openProblems, stuckCount] = await Promise.all([
      prisma.problem.findMany({
        where: { status: "SOLVING" },
        select: {
          id: true,
          severity: true,
          lastAttemptAt: true,
          description: true,
        },
        orderBy: { lastAttemptAt: "desc" },
        take: 50,
      }),
      prisma.problem.count({ where: { status: "OPEN" } }),
      prisma.problem.count({
        where: {
          status: "SOLVING",
          lastAttemptAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
        },
      }),
    ]);

    // Problem resolver take: 默认 50(problem-resolver.ts),可通过 dashboard 调整
    const problemBatchSize = getProblemBatchSize();
    const utilizationPct = problemBatchSize > 0
      ? Math.round((solvingProblems.length / problemBatchSize) * 100) : 0;

    return {
      engineType: "problem" as const,
      runningCount: solvingProblems.length,
      stuckCount,
      batchSize: problemBatchSize,
      pendingCount: openProblems,
      utilizationPct,
      smartMode: getProblemSmartMode(),
      batchOverride: getProblemBatchSize() !== defaultProblemBatch ? getProblemBatchSize() : null,
      batchDefault: defaultProblemBatch,
      solvingProblems: solvingProblems.map((p) => ({
        problemId: p.id,
        severity: p.severity,
        description: (p.description ?? "").slice(0, 120),
        lastAttemptAt: p.lastAttemptAt,
        runningMs: p.lastAttemptAt ? Date.now() - p.lastAttemptAt.getTime() : 0,
      })),
      serverTime: new Date().toISOString(),
    };
  }),

  // ============ 调整最大并发数 + 智能模式开关 ============
  // 智能模式 ON: scheduler 按队列公式自动调整(忽略 batchSize)
  // 智能模式 OFF: scheduler 严格用 batchSize(不调整),刷新页面/重启服务后保持
  // batchSize=null 表示"恢复默认"——任务端:智能公式基础 10 / 问题端:固定 50
  setBatch: publicProcedure
    .input(z.object({
      engine: z.enum(["task", "problem"]),
      value: z.number().int().min(1).max(200).nullable(),
      smartMode: z.boolean().optional(),  // 切换智能模式
    }))
    .mutation(async ({ input }) => {
      const smartMode = input.smartMode ?? true;
      if (input.engine === "task") {
        setTaskBatch(input.value, smartMode);
        const cfg = getRuntimeConfig();
        const msg = smartMode
          ? `已开启智能模式(任务端按队列公式动态调整)`
          : `已设置任务端 batchSize = ${input.value}${input.value === null ? "(默认基础 10)" : ""},关闭智能模式,固定生效`;
        return { engine: "task", config: cfg, message: msg };
      } else {
        setProblemBatch(input.value, smartMode);
        const cfg = getRuntimeConfig();
        const msg = smartMode
          ? `已开启智能模式(问题端默认 50)`
          : `已设置问题端 batchSize = ${input.value}${input.value === null ? "(默认 50)" : ""},关闭智能模式,固定生效`;
        return { engine: "problem", config: cfg, message: msg };
      }
    }),

  // ============ 清理卡死的 TaskExecution ============
  // 415 卡死都是 6/04 批量取消时没级联关 Execution 留下的孤儿
  // 手动触发: dashboard / health 页面"清理卡死"按钮
  // 自动: scheduler.resetStuckTasks 每 5 分钟跑(已修)
  // 策略: TaskExecution.IN_PROGRESS + startedAt < thresholdMin 分钟
  //       -> 标记为 FAILED(reason="STUCK_MANUAL_CLEANUP")
  //       -> 关联的 Task 状态若是 PENDING 也重置为 PENDING(让 scheduler 重跑)
  //       -> 写 FlywheelEvent 留痕(BULK_CLEANUP_STUCK)
  cleanupStuck: publicProcedure
    .input(z.object({
      thresholdMin: z.number().int().min(5).max(1440).optional(),  // 默认 30 分钟
      dryRun: z.boolean().optional(),  // 默认 false(真清)
    }).optional())
    .mutation(async ({ input }) => {
      const thresholdMin = input?.thresholdMin ?? 30;
      const dryRun = input?.dryRun ?? false;
      const cutoff = new Date(Date.now() - thresholdMin * 60 * 1000);

      // 找所有卡死 TE
      const stuckTEs = await prisma.taskExecution.findMany({
        where: {
          status: "IN_PROGRESS",
          startedAt: { lt: cutoff },
        },
        select: {
          id: true, taskId: true, agentId: true, agentRole: true,
          startedAt: true,
          task: { select: { id: true, title: true, status: true } },
        },
        orderBy: { startedAt: "asc" },
      });

      if (dryRun) {
        return {
          dryRun: true,
          count: stuckTEs.length,
          thresholdMin,
          sample: stuckTEs.slice(0, 10).map(te => ({
            teId: te.id, taskId: te.taskId, taskStatus: te.task.status,
            title: te.task.title.slice(0, 60),
            stuckMin: te.startedAt ? Math.round((Date.now() - te.startedAt.getTime()) / 60000) : 0,
          })),
        };
      }

      if (stuckTEs.length === 0) {
        return { cleaned: 0, thresholdMin, message: "无卡死任务" };
      }

      // 1) TE 全部标记为 FAILED
      const teIds = stuckTEs.map(te => te.id);
      const teUpdate = await prisma.taskExecution.updateMany({
        where: { id: { in: teIds } },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          // 失败原因存到 result 字段(JSON)
          // result 是 Json 字段,Prisma 5 用 Prisma.JsonObject
        },
      });

      // 2) 关联的 Task 状态修复:
      //    - Task.PENDING 且 retryCount < maxRetries -> 保持 PENDING(让 scheduler 重试)
      //    - Task.CANCELLED -> 不动(Task 已取消,清理 TE 即可)
      //    - Task.FAILED -> 不动
      //    - Task.COMPLETED -> 不动
      //    - Task.BLOCKED -> 不动
      //    (实际 415 个里 369 是 CANCELLED,主要是清理 TE 即可)
      const taskIds = [...new Set(stuckTEs.map(te => te.taskId))];
      // 不动 Task 状态(避免误改 369 个已 CANCELLED 的 Task)
      // 之前 resetStuckTasks 想把 Task 重置为 PENDING 是错误的,会覆盖批量取消的结果

      // 3) FlywheelEvent 留痕
      await prisma.flywheelEvent.create({
        data: {
          stage: "BULK_CLEANUP_STUCK",
          sourceType: "MANUAL",
          sourceId: `cleanup-${Date.now()}`,
          sourceTitle: `清理 ${stuckTEs.length} 个卡死 TaskExecution(threshold=${thresholdMin}min)`,
          targetStage: "TASK",
          createdAt: new Date(),
        },
      });

      return {
        cleaned: teUpdate.count,
        thresholdMin,
        taskIdsAffected: taskIds.length,
        message: `已清理 ${teUpdate.count} 个卡死 TaskExecution(${stuckTEs.length} 找到),关联 ${taskIds.length} 个 Task(状态未改)`,
      };
    }),

  // ============ 卡死任务统计预览(给清理按钮显示"会清多少") ============
  stuckPreview: publicProcedure
    .input(z.object({
      thresholdMin: z.number().int().min(5).max(1440).optional(),
    }).optional())
    .query(async ({ input }) => {
      const thresholdMin = input?.thresholdMin ?? 30;
      const cutoff = new Date(Date.now() - thresholdMin * 60 * 1000);
      const count = await prisma.taskExecution.count({
        where: { status: "IN_PROGRESS", startedAt: { lt: cutoff } },
      });
      // 按关联 Task 状态分组
      const groups = await prisma.taskExecution.groupBy({
        by: ["taskId"],
        where: { status: "IN_PROGRESS", startedAt: { lt: cutoff } },
        _count: true,
      });
      // 简化版:按 startedAt 桶看年龄分布
      const all = await prisma.taskExecution.findMany({
        where: { status: "IN_PROGRESS", startedAt: { lt: cutoff } },
        select: { startedAt: true },
      });
      const buckets = { "< 1h": 0, "1-6h": 0, "6-24h": 0, "> 24h": 0 };
      const now = Date.now();
      for (const te of all) {
        const ageMin = te.startedAt ? (now - te.startedAt.getTime()) / 60000 : 0;
        if (ageMin < 60) buckets["< 1h"]++;
        else if (ageMin < 360) buckets["1-6h"]++;
        else if (ageMin < 1440) buckets["6-24h"]++;
        else buckets["> 24h"]++;
      }
      return { count, thresholdMin, ageBuckets: buckets, distinctTaskIds: groups.length };
    }),
});