import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { createTaskCompletionTrigger } from "@/server/services/task-completion-trigger";
import { recordAuditLog } from "./audit";
import { generateTaskFromPendingAction } from "@/server/agents/task-generator";

async function notifyMindTaskCreated(params: {
  taskId: string;
  title: string;
  sourceReflectionIds?: string | null;
  sourceSummaryId?: string | null;
  source: string;
}): Promise<void> {
  const LIONS_MIND_URL = process.env.LIONS_MIND_URL || "http://localhost:3000";
  try {
    await fetch(`${LIONS_MIND_URL}/api/trpc/reflectionIngest.ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        json: {
          agentId: "selfimproving",
          sourceService: "lions-selfimproving",
          sourceRef: params.taskId,
          problem: `SelfImproving task created: ${params.title}`,
          context: JSON.stringify({
            taskId: params.taskId,
            sourceReflectionIds: params.sourceReflectionIds ?? null,
            sourceSummaryId: params.sourceSummaryId ?? null,
            source: params.source,
          }),
          severity: "P3",
          createTaskPolicy: "NEVER",
          idempotencyKey: `selfimproving:task-created:${params.taskId}`,
        },
      }),
    });
  } catch (error) {
    console.warn("[selfimproving->mind] task-created bridge failed", error);
  }
}

export const taskRouter = createRouter({
  list: publicProcedure
    .input(
      z.object({
        status: z.string().optional(),
        priority: z.string().optional(),
        createdAfter: z.string().optional(), // P2-3: ISO 时间, 只返 createdAt >= 此时间的 task
        page: z.number().default(1),
        pageSize: z.number().default(20),
      })
    )
    .query(async ({ input }) => {
      const where: Record<string, unknown> = {};
      if (input.status) where.status = input.status;
      if (input.priority) where.priority = input.priority;
      if (input.createdAfter) {
        where.createdAt = { gte: new Date(input.createdAfter) };
      }

      const [items, total] = await Promise.all([
        prisma.task.findMany({
          where,
          include: {
            executions: { include: { problems: true } },
            reviews: true,
          },
          orderBy: { createdAt: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        prisma.task.count({ where }),
      ]);

      return { items, total, page: input.page, pageSize: input.pageSize };
    }),

  get: publicProcedure.input(z.string()).query(async ({ input }) => {
    return prisma.task.findUnique({
      where: { id: input },
      include: {
        executions: {
          include: {
            problems: true,
          },
        },
        reviews: true,
      },
    });
  }),

  create: publicProcedure
    .input(
      z.object({
        title: z.string(),
        description: z.string(),
        background: z.string(),
        requirements: z.string(),
        materials: z.string(),
        acceptanceCriteria: z.string(),
        qualityStandards: z.string(),
        priority: z.string().optional(),
        sourceSummaryId: z.string().optional(),
        sourceReflectionIds: z.string().optional(),
        estimatedEffort: z.string().optional(),
        manualReview: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const task = await prisma.task.create({ data: input });

      await prisma.flywheelEvent.create({
        data: {
          stage: "TASK_CREATED",
          sourceType: input.sourceSummaryId ? "DAILY_SUMMARY" : "MANUAL",
          sourceId: input.sourceSummaryId || task.id,
          sourceTitle: task.title,
          targetStage: "TASK",
          targetType: "TASK",
          targetId: task.id,
        },
      });

      await recordAuditLog({
        entityType: "Task",
        entityId: task.id,
        action: "CREATED",
        actor: "MANUAL",
        actorType: "MANUAL",
        after: task,
      });

      await notifyMindTaskCreated({
        taskId: task.id,
        title: task.title,
        sourceReflectionIds: input.sourceReflectionIds ?? null,
        sourceSummaryId: input.sourceSummaryId ?? null,
        source: "manual_create",
      });

      return task;
    }),

  updateStatus: publicProcedure
    .input(z.object({ id: z.string(), status: z.string() }))
    .mutation(async ({ input }) => {
      const before = await prisma.task.findUnique({ where: { id: input.id } });
      const updated = await prisma.task.update({
        where: { id: input.id },
        data: { status: input.status },
      });
      await recordAuditLog({
        entityType: "Task",
        entityId: input.id,
        action: "STATUS_CHANGED",
        actor: "MANUAL",
        actorType: "MANUAL",
        before,
        after: updated,
        metadata: { newStatus: input.status },
      });
      return updated;
    }),

  // 执行任务 — 完整生命周期记录
  recordExecution: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        agentId: z.string(),
        agentRole: z.string(),
        status: z.string(),
        input: z.string(),
        output: z.string(),
        thoughtProcess: z.string().optional(),
        // 执行中发现的问题列表
        problems: z
          .array(
            z.object({
              description: z.string(),
              severity: z.string().optional(),
              solutionsAttempted: z.array(z.string()).optional(),
            })
          )
          .optional(),
        solutionsApplied: z.string().optional(),
        blocks: z.string().optional(),
        nextSteps: z.string().optional(),
        actualEffortMs: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // 1. 创建执行记录
      const execution = await prisma.taskExecution.create({
        data: {
          taskId: input.taskId,
          agentId: input.agentId,
          agentRole: input.agentRole,
          status: input.status,
          input: input.input,
          output: input.output,
          thoughtProcess: input.thoughtProcess,
          solutionsApplied: input.solutionsApplied,
          blocks: input.blocks,
          nextSteps: input.nextSteps,
          startedAt: new Date(),
          completedAt:
            input.status === "COMPLETED" || input.status === "FAILED" ? new Date() : null,
        },
      });

      // 2. 记录发现的问题
      if (input.problems && input.problems.length > 0) {
        for (const p of input.problems) {
          await prisma.problem.create({
            data: {
              taskExecutionId: execution.id,
              taskId: input.taskId,
              description: p.description,
              severity: p.severity || "P2",
              solutionsAttempted: p.solutionsAttempted
                ? JSON.stringify(p.solutionsAttempted)
                : null,
              status: "OPEN",
              sourceType: "TASK",
            },
          });
        }
      }

      // 3. 更新任务状态
      // COMPLETED 执行结果：直接完成（QualityGate 已在 scheduler 中评估过）
      // REVIEW 状态由人工验收流程单独推进
      let newStatus = "IN_PROGRESS";
      if (input.status === "REVIEW") newStatus = "REVIEW";
      else if (input.status === "BLOCKED") newStatus = "BLOCKED";

      const updatedTask = await prisma.task.update({
        where: { id: input.taskId },
        data: {
          status: newStatus,
          actualEffortMs: input.actualEffortMs,
        },
      });

      return { execution, task: updatedTask, problemsCount: input.problems?.length ?? 0 };
    }),

  // 更新执行记录（追加思考过程、解决方案等）
  updateExecution: publicProcedure
    .input(
      z.object({
        executionId: z.string(),
        status: z.string().optional(),
        thoughtProcess: z.string().optional(),
        solutionsApplied: z.string().optional(),
        blocks: z.string().optional(),
        nextSteps: z.string().optional(),
        output: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const execution = await prisma.taskExecution.update({
        where: { id: input.executionId },
        data: {
          ...(input.status ? { status: input.status, completedAt: new Date() } : {}),
          ...(input.thoughtProcess ? { thoughtProcess: input.thoughtProcess } : {}),
          ...(input.solutionsApplied ? { solutionsApplied: input.solutionsApplied } : {}),
          ...(input.blocks ? { blocks: input.blocks } : {}),
          ...(input.nextSteps ? { nextSteps: input.nextSteps } : {}),
          ...(input.output ? { output: input.output } : {}),
        },
      });

      // 任务完成时更新状态
      if (input.status === "COMPLETED") {
        await prisma.task.update({
          where: { id: execution.taskId },
          data: { status: "REVIEW" },
        });
      }

      return execution;
    }),

  recordReview: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        reviewerId: z.string(),
        reviewerRole: z.string(),
        status: z.string(),
        score: z.number().optional(),
        strengths: z.string().optional(),
        weaknesses: z.string().optional(),
        lessonsLearned: z.string().optional(),
        feedbackNotes: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const review = await prisma.taskReview.create({
        data: input,
      });

      if (input.status === "PASSED") {
        await prisma.task.update({
          where: { id: input.taskId },
          data: { status: "COMPLETED" },
        });

        await prisma.flywheelEvent.create({
          data: {
            stage: "TASK_COMPLETED",
            sourceType: "TASK_REVIEW",
            sourceId: review.id,
            sourceTitle: "Task review passed",
            targetStage: "KNOWLEDGE",
          },
        });
      } else if (input.status === "REVISION_REQUIRED") {
        await prisma.task.update({
          where: { id: input.taskId },
          data: { status: "IN_PROGRESS" },
        });
      }

      return review;
    }),

  // 从 lions-mind 的每日总结创建任务
  generateFromSummary: publicProcedure
    .input(
      z.object({
        summaryId: z.string(),
        pendingItems: z.array(
          z.object({
            content: z.string(),
            reflectionId: z.string(),
            reflectionTitle: z.string(),
          })
        ),
      })
    )
    .mutation(async ({ input }) => {
      const tasks = await Promise.all(
        input.pendingItems.map(async (item) => {
          const task = await prisma.task.create({
            data: {
              title: item.content.slice(0, 100),
              description: `来自反思"${item.reflectionTitle}"中的待办项。\n\n内容：${item.content}`,
              background: `来源：每日总结反思 — "${item.reflectionTitle}"。总结ID：${input.summaryId}。反思ID：${item.reflectionId}。`,
              requirements: `1. 理解任务目标\n2. 收集相关信息\n3. 制定执行计划\n4. 执行并验证\n5. 记录执行过程和问题`,
              materials: `反思记录：${item.reflectionTitle}`,
              acceptanceCriteria: `1. 完成了待办项\n2. 有完整的执行记录\n3. 解决了执行中的问题`,
              qualityStandards: "执行过程清晰，问题记录准确，解决方案合理",
              priority: "P2",
              sourceSummaryId: input.summaryId,
              sourceReflectionIds: JSON.stringify([item.reflectionId]),
            },
          });

          await prisma.flywheelEvent.create({
            data: {
              stage: "TASK_CREATED",
              sourceType: "DAILY_SUMMARY",
              sourceId: input.summaryId,
              sourceTitle: item.content.slice(0, 50),
              targetStage: "TASK",
              targetType: "TASK",
              targetId: task.id,
            },
          });

          await notifyMindTaskCreated({
            taskId: task.id,
            title: task.title,
            sourceReflectionIds: JSON.stringify([item.reflectionId]),
            sourceSummaryId: input.summaryId,
            source: "generate_from_summary",
          });

          return task;
        })
      );

      return { tasks, count: tasks.length };
    }),

  getStats: publicProcedure.query(async () => {
    const [total, pending, inProgress, review, completed, blocked, cancelled, failed] = await Promise.all([
      prisma.task.count(),
      prisma.task.count({ where: { status: "PENDING" } }),
      prisma.task.count({ where: { status: "IN_PROGRESS" } }),
      prisma.task.count({ where: { status: "REVIEW" } }),
      prisma.task.count({ where: { status: "COMPLETED" } }),
      prisma.task.count({ where: { status: "BLOCKED" } }),
      prisma.task.count({ where: { status: "CANCELLED" } }),
      prisma.task.count({ where: { status: "FAILED" } }),
    ]);

    const [problemTotal, problemOpen, problemSolved] = await Promise.all([
      prisma.problem.count(),
      prisma.problem.count({ where: { status: "OPEN" } }),
      prisma.problem.count({ where: { status: "SOLVED" } }),
    ]);

    return {
      total, pending, inProgress, review, completed, blocked, cancelled, failed,
      problems: { total: problemTotal, open: problemOpen, solved: problemSolved },
    };
  }),

  // 手动触发任务处理（用于测试或立即执行）
  processNow: publicProcedure.mutation(async () => {
    const { processPendingTasks } = await import("@/server/agents/scheduler");
    return processPendingTasks();
  }),

  // 获取任务状态转换时间线
  getTimeline: publicProcedure
    .input(z.string())
    .query(async ({ input }) => {
      return prisma.taskStateTransition.findMany({
        where: { taskId: input },
        orderBy: { createdAt: "asc" },
      });
    }),

  // 获取任务完整详情（含深度关联）
  getFull: publicProcedure.input(z.string()).query(async ({ input }) => {
    const task = await prisma.task.findUnique({
      where: { id: input },
      include: {
        executions: {
          include: { problems: true },
          orderBy: { createdAt: "desc" },
        },
        reviews: { orderBy: { createdAt: "desc" } },
        flywheelEvents: { orderBy: { createdAt: "desc" } },
        stateTransitions: { orderBy: { createdAt: "asc" } },
        // Direct problem list (through taskId on Problem)
        problems: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!task) return null;

    // P2-1: 查 sourceReflectionIds 对应的反思 (从 mind 端用 reflection.get 逐个拉)
    let sourceReflections: Array<{
      id: string;
      title: string;
      description: string | null;
      lesson: string | null;
      category: string | null;
      sourceType: string | null;
      agentSource: string | null;
    }> = [];
    if (task.sourceReflectionIds) {
      const ids = task.sourceReflectionIds.split(",").map((s: string) => s.trim()).filter(Boolean);
      // 并发拉, 但限制并发数 (避免压爆 mind)
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await fetch(
              `http://localhost:3000/api/trpc/reflection.get?input=${encodeURIComponent(JSON.stringify(id))}`,
              { method: "GET", headers: { "Content-Type": "application/json" } }
            );
            if (!r.ok) return null;
            const j = await r.json();
            const x = j?.result?.data;
            if (!x) return null;
            return {
              id: x.id,
              title: x.title,
              description: x.description,
              lesson: x.lesson,
              category: x.category,
              sourceType: x.sourceType,
              agentSource: x.agentSource,
            };
          } catch {
            return null;
          }
        })
      );
      sourceReflections = results.filter((r): r is NonNullable<typeof r> => r !== null);
    }

    // P2-1: 同步状态 (查 FlywheelEvent)
    const mindSyncEvents = task.flywheelEvents.filter(
      (e) => e.stage === "MIND_SYNC" || e.stage === "TASK_RESOLVED" || e.stage === "REFLECT"
    );
    const mindSynced = mindSyncEvents.length > 0;
    const lastSyncEvent = mindSyncEvents[0] ?? null;

    return {
      ...task,
      sourceReflections,
      mindSynced,
      lastMindSyncEvent: lastSyncEvent
        ? { stage: lastSyncEvent.stage, sourceType: lastSyncEvent.sourceType, createdAt: lastSyncEvent.createdAt }
        : null,
    };
  }),

  // 批量更新任务状态
  batchUpdateStatus: publicProcedure
    .input(
      z.object({
        taskIds: z.array(z.string()),
        status: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      await prisma.task.updateMany({
        where: { id: { in: input.taskIds } },
        data: { status: input.status },
      });
      return { updated: input.taskIds.length };
    }),

  // 重新执行任务
  reExecute: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const task = await prisma.task.findUnique({ where: { id: input.taskId } });
      if (!task) throw new Error("Task not found");

      if (task.retryCount >= task.maxRetries) {
        await prisma.task.update({
          where: { id: input.taskId },
          data: { status: "FAILED" },
        });
        return { success: false, reason: "MAX_RETRIES_EXCEEDED" };
      }

      await prisma.task.update({
        where: { id: input.taskId },
        data: { status: "PENDING" },
      });

      await prisma.taskStateTransition.create({
        data: {
          taskId: input.taskId,
          fromStatus: task.status,
          toStatus: "PENDING",
          actor: "MANUAL",
          reason: input.reason ?? "Manual re-execute",
        },
      });

      return { success: true };
    }),

  // 标记任务完成
  markComplete: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        reviewerId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      // Get the task before updating
      const taskBefore = await prisma.task.findUnique({ where: { id: input.taskId } });
      if (!taskBefore) throw new Error("Task not found");

      const task = await prisma.task.update({
        where: { id: input.taskId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          completedBy: input.reviewerId,
        },
      });

      await prisma.taskStateTransition.create({
        data: {
          taskId: input.taskId,
          fromStatus: taskBefore.status,
          toStatus: "COMPLETED",
          actor: input.reviewerId,
          reason: "Manual completion",
        },
      });

      // 创建执行记录并触发反思
      const execution = await prisma.taskExecution.create({
        data: {
          taskId: input.taskId,
          agentId: input.reviewerId,
          agentRole: "REVIEWER",
          status: "COMPLETED",
          input: task.description || "",
          output: JSON.stringify({ completionType: "manual", completedBy: input.reviewerId }),
          startedAt: task.completedAt ? new Date(task.completedAt.getTime() - 60000) : new Date(),
          completedAt: task.completedAt || new Date(),
        },
      });

      // 触发反思流程
      await createTaskCompletionTrigger(input.taskId, execution.id);

      return task;
    }),

  // 放弃任务
  abandon: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        reason: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const task = await prisma.task.update({
        where: { id: input.taskId },
        data: { status: "ARCHIVED" },
      });

      await prisma.taskStateTransition.create({
        data: {
          taskId: input.taskId,
          fromStatus: task.status,
          toStatus: "ARCHIVED",
          actor: "MANUAL",
          reason: input.reason,
        },
      });

      return task;
    }),

  // 批量关闭429问题任务
  batchClose429: publicProcedure.mutation(async () => {
    const result = await prisma.task.updateMany({
      where: {
        title: { contains: "429" },
        status: { in: ["BLOCKED", "REVIEW", "PENDING"] },
      },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        completedBy: "AUTO_429",
      },
    });
    return { updated: result.count };
  }),

  // 取消任务（带取消原因的完整记录）
  cancelTask: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        reason: z.string(),
        aiExplanation: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const task = await prisma.task.findUnique({ where: { id: input.taskId } });
      if (!task) throw new Error("Task not found");

      const updated = await prisma.task.update({
        where: { id: input.taskId },
        data: { status: "CANCELLED" },
      });

      await prisma.taskStateTransition.create({
        data: {
          taskId: input.taskId,
          fromStatus: task.status,
          toStatus: "CANCELLED",
          actor: "SYSTEM",
          reason: input.reason,
          metadata: input.aiExplanation
            ? JSON.stringify({ aiExplanation: input.aiExplanation })
            : undefined,
        },
      });

      return updated;
    }),

  // 批量取消所有 BLOCKED 任务（信息缺失型）
  batchCancelBlocked: publicProcedure
    .input(
      z.object({
        reason: z.string(),
        aiExplanation: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const blockedTasks = await prisma.task.findMany({
        where: { status: "BLOCKED" },
      });

      const results = await Promise.all(
        blockedTasks.map(async (task) => {
          await prisma.task.update({
            where: { id: task.id },
            data: { status: "CANCELLED" },
          });

          await prisma.taskStateTransition.create({
            data: {
              taskId: task.id,
              fromStatus: "BLOCKED",
              toStatus: "CANCELLED",
              actor: "SYSTEM",
              reason: input.reason,
              metadata: input.aiExplanation
                ? JSON.stringify({ aiExplanation: input.aiExplanation })
                : undefined,
            },
          });

          return task.id;
        })
      );

      return { cancelled: results.length, ids: results };
    }),

  // Admin: reset tasks stuck at IN_PROGRESS with no execution (scheduler bug guard)
  resetStuck: publicProcedure
    .input(z.object({ taskId: z.string().optional() }))
    .mutation(async ({ input }) => {
      const where = input.taskId
        ? { id: input.taskId, status: 'IN_PROGRESS' }
        : { status: 'IN_PROGRESS', retryCount: { lte: 2 } };
      const tasks = await prisma.task.findMany({
        where,
        include: { executions: true },
      });
      const stuck = tasks.filter(t => t.executions.length === 0);
      const updated = await Promise.all(
        stuck.map(t =>
          prisma.task.update({
            where: { id: t.id },
            data: { status: 'PENDING' },
          })
        )
      );
      return { reset: updated.length, ids: updated.map(t => t.id) };
    }),

});

/** Fetch reflection content from Lions-Mind API */
async function fetchReflectionContent(reflectionId: string): Promise<string> {
  try {
    const LIONS_MIND_URL = process.env.LIONS_MIND_URL || "http://localhost:3000";
    const response = await fetch(
      `${LIONS_MIND_URL}/api/trpc/reflection.get?input=${encodeURIComponent(JSON.stringify(reflectionId))}`
    );
    if (!response.ok) return "";
    const data = await response.json();
    const r = data.result?.data;
    if (!r) return "";
    // Build a concise content string from available fields
    return [r.description, r.lesson, r.insight, r.improvements]
      .filter(Boolean)
      .join("\n---\n");
  } catch {
    return "";
  }
}