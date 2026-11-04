import cron from "node-cron";
import { prisma } from "@/lib/prisma";
import { executeTask } from "./task-executor";
import { evaluateQualityGate } from "./quality-gate";
import { processOpenProblems } from "./problem-resolver";
import { createTaskCompletionTrigger, processPendingTriggers } from "@/server/services/task-completion-trigger";
import { startTaskResolvedScanner } from "@/server/services/task-resolved-scanner";
import { startProblemResolvedScanner } from "@/server/services/problem-resolved-scanner";
import { createProblemCompletionTrigger } from "@/server/services/problem-completion-trigger";
import { reviewTask } from "./task-reviewer";
import { createReviewRecord } from "@/server/services/review-record";
import { eventBus, emitTaskCreated, emitTaskStarted, emitTaskCompleted, emitTaskFailed, emitTaskStatusChanged, emitExecutionRecorded, emitReviewCreated, emitProblemCreated, emitProblemSolved, emitSchedulerTick, emitSchedulerTaskBatchComplete, emitSchedulerProblemBatchComplete, emitSystemError, emitTaskProcessStart, emitTaskProcessComplete, emitProblemProcessStart, emitProblemProcessComplete, emitProblemResolved } from "../event-bus";
import { getTaskBatchSize, defaultTaskBatch, getTaskSmartMode } from "./runtime-config";

let schedulerTask: cron.ScheduledTask | null = null;
let problemSchedulerTask: cron.ScheduledTask | null = null;
let stuckTaskResetTask: cron.ScheduledTask | null = null;

export async function processPendingTasks(): Promise<{ processed: number; errors: string[] }> {
  // 动态批量大小：根据队列深度调整（高负载时增加处理量）
  const pendingCount = await prisma.task.count({ where: { status: "PENDING" } });
  // 公式(智能模式或无 override 时使用)
  const formulaBatch = pendingCount > 1000 ? 100 : pendingCount > 500 ? 80 : pendingCount > 200 ? 50 : pendingCount > 50 ? 20 : 10;
  // 用户运行时配置
  const smartMode = getTaskSmartMode();
  const overrideBatch = getTaskBatchSize();
  // 决策:
  //   - 智能模式 ON: 用公式
  //   - 智能模式 OFF: 用用户 override(可能等于 defaultTaskBatch 表示未设)
  const BATCH_SIZE = smartMode
    ? formulaBatch
    : (overrideBatch !== defaultTaskBatch ? overrideBatch : defaultTaskBatch);

  // P3 修复: raw query 替代 prisma.task.findMany, 绕过 prisma 5.22 SQLite binary parser "invalid characters" 错
  // 之前 .findMany({ where: { status: "PENDING" } }) 扫全表触发 binary parse 错
  // 改: $queryRawUnsafe 返 task 必要字段, 不用 prisma client binary parser
  const rawRows = await prisma.$queryRaw`
    SELECT t.id, t.priority, t.title, t.description, t.background, t.requirements,
           t.materials, t."acceptanceCriteria", t."qualityStandards",
           t."sourceReflectionIds", t."createdAt", t."retryCount", t."manualReview"
    FROM "Task" t
    WHERE t.status = 'PENDING'
    ORDER BY t.priority ASC, t."createdAt" ASC
    LIMIT ${BATCH_SIZE}
  ` as Array<{
    id: string; priority: string; title: string; description: string;
    background: string; requirements: string; materials: string;
    acceptanceCriteria: string; qualityStandards: string;
    sourceReflectionIds: string | null; createdAt: number; retryCount: number; manualReview: boolean;
  }>;

  // 转成 task-like 对象 (后续用 task.* 字段)
  const pendingTasks = rawRows.map((r) => ({
    id: r.id,
    priority: r.priority,
    title: r.title,
    description: r.description,
    background: r.background,
    requirements: r.requirements,
    materials: r.materials,
    acceptanceCriteria: r.acceptanceCriteria,
    qualityStandards: r.qualityStandards,
    sourceReflectionIds: r.sourceReflectionIds,
    createdAt: new Date(r.createdAt),
    retryCount: r.retryCount,
    manualReview: r.manualReview,
  } as any));

  if (pendingTasks.length === 0) return { processed: 0, errors: [] };

  // Process tasks in parallel for efficiency
  const results = await Promise.all(
    pendingTasks.map(async (task) => {
      let executionId: string | null = null;
      const currentRetry = (task as Record<string, unknown>).retryCount as number ?? 0;

      try {
        // Step 1: Update task status to IN_PROGRESS
        await prisma.task.update({
          where: { id: task.id },
          data: {
            status: "IN_PROGRESS",
            retryCount: currentRetry + 1,
          },
        });

        // Step 2: Create execution record BEFORE calling executeTask
        const execution = await prisma.taskExecution.create({
          data: {
            taskId: task.id,
            agentId: "claude-minimax",
            agentRole: "TaskExecutor",
            status: "IN_PROGRESS",
            input: task.requirements || "",
            output: "",
            startedAt: new Date(),
            retryCount: currentRetry + 1,
          },
        });
        executionId = execution.id;

        // Emit: EXECUTION_RECORDED + TASK_STARTED
        emitExecutionRecorded(task.id, execution.id, "IN_PROGRESS", "scheduler");
        emitTaskStarted(task.id, execution.id, "scheduler");

        // Step 3: Execute the task
        const result = await executeTask({
          taskId: task.id,
          title: task.title,
          description: task.description,
          background: task.background || "",
          requirements: task.requirements || "",
          materials: task.materials || "",
          acceptanceCriteria: task.acceptanceCriteria || "",
          qualityStandards: task.qualityStandards || "",
          priority: task.priority || "P2",
        });

        // Skip quality gate for reflection tasks to prevent infinite nesting
        const isReflectionTask = task.title.startsWith("[反思]");
        const qualityResult = isReflectionTask
          ? { passed: true, reasons: [], retryRecommended: false, substanceScore: 80, outputSubstance: "MEDIUM" as const, hasFilePaths: false, isGenericTemplate: false, dynamicThreshold: 40 }
          : evaluateQualityGate({
              output: result.output,
              thoughtProcess: result.thoughtProcess,
              status: result.status,
            });

        // Step 4: Update execution record with results
        await prisma.taskExecution.update({
          where: { id: execution.id },
          data: {
            status: result.status,
            output: result.output,
            thoughtProcess: result.thoughtProcess,
            problemsEncountered: result.problemsEncountered || undefined,
            solutionsApplied: result.solutionsApplied || undefined,
            blocks: result.blocks || undefined,
            nextSteps: result.nextSteps || undefined,
            completedAt: new Date(),
            qualityPassed: qualityResult.passed,
          },
        });

        // Step 5: TaskReviewer Agent evaluates the execution
        const reviewerResult = await reviewTask({
          taskId: task.id,
          title: task.title,
          requirements: task.requirements || "",
          acceptanceCriteria: task.acceptanceCriteria || "",
          qualityStandards: task.qualityStandards || "",
          execution: result,
        });
        console.log(`[TaskScheduler] Review: ${reviewerResult.status} (score=${reviewerResult.score}) — ${reviewerResult.feedbackNotes}`);

        if (result.problemsEncountered) {
          // Fetch reflection content if sourceReflectionId exists
          let sourceReflectionContent = "";
          if (task.sourceReflectionIds) {
            try {
              const refId = task.sourceReflectionIds.split(",")[0].trim();
              const resp = await fetch(
                `http://localhost:3000/api/trpc/reflection.get?input=${encodeURIComponent(JSON.stringify(refId))}`
              );
              if (resp.ok) {
                const data = await resp.json();
                const r = data.result?.data;
                if (r) {
                  sourceReflectionContent = [r.description, r.lesson, r.insight, r.improvements]
                    .filter(Boolean)
                    .join("\n---\n");
                }
              }
            } catch { /* ignore */ }
          }

          // P3 修复: 24h dedup — 同 task + 相同 description 不重复建 problem
          // 解决: 18 个 "API error: 429 Too Many Requests" 重复 problem 堆积
          // 业务规则放 SDK 层 (不靠 db hard unique 约束)
          const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const recentDup = await prisma.problem.findFirst({
            where: {
              taskId: task.id,
              description: result.problemsEncountered,
              createdAt: { gte: oneDayAgo },
            },
            select: { id: true, status: true, createdAt: true },
          });
          if (recentDup) {
            // 已存在同 task + 同 description + 24h 内 problem, 跳过创建
            // (不报错, 不挂起 task, 继续)
            console.log(`[TaskScheduler] Problem dedup 跳过: task=${task.id} dup=${recentDup.id} status=${recentDup.status} (24h 内已记录)`);
            // dedup 命中不创建 problem, 继续 task 流程 (不挂起)
          } else {

          const problem = await prisma.problem.create({
            data: {
              taskId: task.id,
              taskExecutionId: execution.id,
              description: result.problemsEncountered,
              severity: task.priority || "P2",
              status: "OPEN",
              sourceType: "TASK",  // Problems created from task execution
              taskTitle: task.title,
              taskDescription: task.description,
              taskRequirements: task.requirements,
              taskBackground: task.background,
              taskAcceptanceCriteria: task.acceptanceCriteria,
              taskQualityStandards: task.qualityStandards,
              taskMaterials: task.materials,
              sourceReflectionId: task.sourceReflectionIds?.split(",")[0]?.trim() || null,
              sourceReflectionContent,
            },
          });
          emitProblemCreated(problem.id, task.id, result.problemsEncountered, task.priority || "P2", "scheduler");

          // Track problem creation in flywheel
          await prisma.flywheelEvent.create({
            data: {
              stage: "PROBLEM_CREATED",
              sourceType: "PROBLEM_CREATION",
              sourceId: problem.id,
              sourceTitle: problem.description.slice(0, 50),
              targetStage: "PROBLEM",
              targetType: "PROBLEM",
              targetId: problem.id,
            },
          });
          } // 闭合 else (dedup 没命中才建 problem)
        }

        // Step 5b: Handle task completion based on manualReview flag
        const needsManualReview = task.manualReview === true;
        const reviewerFailed = reviewerResult.status === "FAILED";

        if (result.status === "BLOCKED") {
          await prisma.task.update({
            where: { id: task.id },
            data: { status: "BLOCKED" },
          });
          console.log(`[TaskScheduler] Task ${task.id} (${task.title.slice(0, 40)}) -> BLOCKED`);
          emitTaskStatusChanged(task.id, "IN_PROGRESS", "BLOCKED", "scheduler");
          return { success: true, taskId: task.id };

        } else if (result.status === "FAILED") {
          const maxRetries = (task as Record<string, unknown>).maxRetries as number ?? 3;
          if (currentRetry + 1 >= maxRetries) {
            await prisma.task.update({
              where: { id: task.id },
              data: { status: "FAILED" },
            });
            console.log(`[TaskScheduler] Task ${task.id} (${task.title.slice(0, 40)}) -> FAILED (max retries)`);
            emitTaskFailed(task.id, "max retries exceeded", currentRetry + 1, "scheduler");
          } else {
            await prisma.task.update({
              where: { id: task.id },
              data: { status: "PENDING" },
            });
            console.log(`[TaskScheduler] Task ${task.id} (${task.title.slice(0, 40)}) -> PENDING (retry ${currentRetry + 1}/${maxRetries})`);
            eventBus.emit("TASK_RETRY", { taskId: task.id, retryCount: currentRetry + 1, reason: "execution failed" }, "scheduler");
          }
          return { success: true, taskId: task.id };

        } else if (needsManualReview) {
          // Task requires human approval — move to REVIEW status
          await prisma.task.update({
            where: { id: task.id },
            data: {
              status: "REVIEW",
              completedAt: null,  // not completed yet
              completedBy: null,
            },
          });
          console.log(`[TaskScheduler] Task ${task.id} (${task.title.slice(0, 40)}) -> REVIEW (manual review required)`);

          // Create review record
          const reviewRecordId = await createReviewRecord({
            taskId: task.id,
            taskExecutionId: execution.id,
            reviewType: reviewerFailed ? "REVIEWER_REVISION" : "REVIEWER_PASS",
            reviewResult: reviewerResult.status,
            qualityScore: reviewerResult.score,
          });
          if (reviewRecordId) {
            emitReviewCreated(task.id, reviewRecordId, reviewerFailed ? "REVIEWER_REVISION" : "REVIEWER_PASS", "scheduler");
          }

          // If reviewer failed, create improvement task but keep original in REVIEW
          if (reviewerFailed) {
            await prisma.task.create({
              data: {
                title: `[改进] ${task.title}`,
                description: `Review 发现问题：${reviewerResult.weaknesses}\n反馈：${reviewerResult.feedbackNotes}`,
                background: `Task ${task.id} 执行后 Reviewer Agent 评分 ${reviewerResult.score}/10，未达标。需改进后重新提交审查。`,
                requirements: `改进方向：${reviewerResult.lessonsLearned}\n需解决：${reviewerResult.weaknesses}`,
                materials: task.materials ?? "",
                acceptanceCriteria: task.acceptanceCriteria ?? "",
                qualityStandards: task.qualityStandards ?? "",
                priority: "P2",
                status: "PENDING",
                sourceTaskId: task.id,
              },
            });
            eventBus.emit("TASK_CREATED", { taskId: task.id, title: `[改进] ${task.title}`, source: "reviewer" }, "scheduler");
          }

          return { success: true, taskId: task.id };

        } else if (qualityResult.passed) {
          await prisma.task.update({
            where: { id: task.id },
            data: {
              status: "COMPLETED",
              completedAt: new Date(),
              completedBy: "AUTO",
            },
          });
          console.log(`[TaskScheduler] Task ${task.id} (${task.title.slice(0, 40)}) -> COMPLETED (auto-pass)`);

          // Emit: TASK_COMPLETED
          emitTaskCompleted(task.id, task.title, execution.id, "scheduler");

          // Track task completion in flywheel
          await prisma.flywheelEvent.create({
            data: {
              stage: "OUTCOME",
              sourceType: "TASK_COMPLETION",
              sourceId: task.id,
              sourceTitle: `任务完成: ${task.title.slice(0, 50)}`,
              targetStage: "OUTCOME",
              targetType: "TASK",
              targetId: task.id,
            },
          });

          // Create review record using TaskReviewer Agent result
          const reviewRecordId = await createReviewRecord({
            taskId: task.id,
            taskExecutionId: execution.id,
            reviewType: "REVIEWER",
            reviewResult: reviewerResult.status,
            qualityScore: reviewerResult.score,
          });
          if (reviewRecordId) {
            emitReviewCreated(task.id, reviewRecordId, "REVIEWER", "scheduler");
          }

          // If review failed, trigger revision task instead of completing
          if (reviewerResult.status === "FAILED") {
            // Create improvement task
            await prisma.task.create({
              data: {
                title: `[改进] ${task.title}`,
                description: `Review 发现问题：${reviewerResult.weaknesses}\n反馈：${reviewerResult.feedbackNotes}`,
                background: `Task ${task.id} 执行后 Reviewer Agent 评分 ${reviewerResult.score}/10，未达标。`,
                requirements: `改进方向：${reviewerResult.lessonsLearned}\n需解决：${reviewerResult.weaknesses}`,
                materials: task.materials ?? "",
                acceptanceCriteria: task.acceptanceCriteria ?? "",
                qualityStandards: task.qualityStandards ?? "",
                priority: "P2",
                status: "PENDING",
                sourceTaskId: task.id,
              },
            });
            eventBus.emit("TASK_CREATED", { taskId: task.id, title: `[改进] ${task.title}`, source: "reviewer" }, "scheduler");
          }

          // Trigger task completion reflection
          await createTaskCompletionTrigger(task.id, execution.id);

          return { success: true, taskId: task.id };

        } else {
          const maxRetries = (task as Record<string, unknown>).maxRetries as number ?? 3;
          if (currentRetry + 1 >= maxRetries) {
            await prisma.task.update({
              where: { id: task.id },
              data: { status: "FAILED" },
            });
            console.log(`[TaskScheduler] Task ${task.id} (${task.title.slice(0, 40)}) -> FAILED (quality, max retries)`);
            emitTaskFailed(task.id, `quality failed: ${qualityResult.reasons.join("; ")}`, currentRetry + 1, "scheduler");
          } else {
            await prisma.task.update({
              where: { id: task.id },
              data: { status: "PENDING" },
            });
            console.log(`[TaskScheduler] Task ${task.id} (${task.title.slice(0, 40)}) -> PENDING (quality failed: ${qualityResult.reasons.join("; ")})`);
            eventBus.emit("TASK_RETRY", { taskId: task.id, retryCount: currentRetry + 1, reason: `quality failed: ${qualityResult.reasons.join("; ")}` }, "scheduler");
          }
          return { success: true, taskId: task.id };
        }

      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        console.error(`[TaskScheduler] Task ${task.id} failed:`, msg);

        // Update execution record even on exception
        if (executionId) {
          await prisma.taskExecution.update({
            where: { id: executionId },
            data: {
              status: "FAILED",
              output: "",
              problemsEncountered: msg,
              completedAt: new Date(),
            },
          }).catch(() => {});
        }

        emitTaskFailed(task.id, `exception: ${msg}`, currentRetry + 1, "scheduler");
        emitSystemError("scheduler", msg, { taskId: task.id });

        const maxRetries = (task as Record<string, unknown>).maxRetries as number ?? 3;
        if (currentRetry + 1 >= maxRetries) {
          await prisma.task.update({
            where: { id: task.id },
            data: { status: "FAILED" },
          });
          console.log(`[TaskScheduler] Task ${task.id} -> FAILED (exception, max retries)`);
        } else {
          await prisma.task.update({
            where: { id: task.id },
            data: { status: "PENDING" },
          });
          console.log(`[TaskScheduler] Task ${task.id} -> PENDING (retry on exception: ${msg.slice(0, 80)})`);
        }
        return { success: false, taskId: task.id, error: msg };
      }
    })
  );

  const errors = results.filter((r) => !r.success).map((r) => r.error ?? "");
  return { processed: results.length, errors };
}

/**
 * Reset tasks that are stuck at IN_PROGRESS without a completed execution.
 * P3 修复: 用 raw query 绕过 prisma client 5.22 SQLite binary parser "invalid characters" 错
 * 改 select {id} 走 raw, 只返 id 字符串, 不 parse 大字段
 */
export async function resetStuckTasks(): Promise<number> {
  // P3 修复: 升级 - 不仅查"无 in-flight execution" 还查"execution started > 10min 前" (worker 卡死)
  // 真根因: task-executor fetch 无 AbortController timeout, LLM API 慢/429 → worker 永远不返回
  //   → TaskExecution.completedAt 永远 NULL → 之前 resetStuckTasks 找 "NOT EXISTS NULL execution" 永远命中不到
  //   → IN_PROGRESS task 永远不解卡 → engine "卡住" 假象
  // 修: 加第二个分支 - execution started > 10min 前的 in-flight execution → 强制标 FAILED + DEPRECATED
  const tenMinAgoMs = Date.now() - 10 * 60 * 1000;

  // 分支 1: 老的 "无 in-flight execution" 处理 (保留)
  const orphanRows = await prisma.$queryRaw`
    SELECT t.id
    FROM "Task" t
    WHERE t.status = 'IN_PROGRESS'
      AND t."retryCount" <= 2
      AND NOT EXISTS (
        SELECT 1 FROM "TaskExecution" te
        WHERE te."taskId" = t.id AND te."completedAt" IS NULL
      )
  ` as Array<{ id: string }>;

  // 分支 2: P3 修复 - in-flight execution > 10min 视为卡死, 强制标 FAILED + 任务 DEPRECATED
  const stuckRows = await prisma.$queryRaw`
    SELECT DISTINCT t.id as "taskId", te.id as "execId"
    FROM "Task" t
    JOIN "TaskExecution" te ON te."taskId" = t.id
    WHERE t.status = 'IN_PROGRESS'
      AND te."completedAt" IS NULL
      AND te."startedAt" < ${new Date(tenMinAgoMs)}
  ` as Array<{ taskId: string; execId: string }>;

  let resetCount = 0;
  // 处理 orphan (无 in-flight)
  for (const row of orphanRows) {
    try {
      await prisma.task.update({
        where: { id: row.id },
        data: { status: "PENDING" },
      });
      console.log(`[TaskScheduler] Reset orphan stuck task: ${row.id}`);
      resetCount++;
    } catch (updateErr) {
      console.warn(`[TaskScheduler] Reset orphan task ${row.id} 失败: ${(updateErr as Error).message?.slice(0, 100)}`);
    }
  }

  // 处理卡死的 in-flight execution
  for (const row of stuckRows) {
    try {
      // 1. 强制完成 execution (标 completedAt, status=FAILED)
      await prisma.$executeRaw`
        UPDATE "TaskExecution" SET "completedAt" = ${new Date()}, status = 'FAILED',
          blocks = COALESCE(blocks, '') || ' [force-unlock 10min+]'
        WHERE id = ${row.execId}
      `;
      // 2. 任务标 DEPRECATED (因为 worker 真卡了, 重试也会卡)
      await prisma.$executeRaw`
        UPDATE "Task" SET status = 'DEPRECATED', "updatedAt" = ${new Date()}
        WHERE id = ${row.taskId} AND status = 'IN_PROGRESS'
      `;
      console.log(`[TaskScheduler] Force-unlock stuck task ${row.taskId} (execution ${row.execId} 卡死 10min+)`);
      resetCount++;
    } catch (unlockErr) {
      console.warn(`[TaskScheduler] Force-unlock task ${row.taskId} 失败: ${(unlockErr as Error).message?.slice(0, 100)}`);
    }
  }

  return resetCount;
}

/**
 * Start the task processing scheduler.
 * Runs every 5 minutes.
 */
export function startTaskScheduler() {
  if (schedulerTask) schedulerTask.stop();

  // P1-1: 启动 Task Resolved Scanner (监听 TASK_STATUS_CHANGED -> COMPLETED, 写 mind memory)
  startTaskResolvedScanner();
  // P1-2: 启动 Problem Resolved Scanner (监听 PROBLEM_SOLVED, 写 mind memory)
  startProblemResolvedScanner();

  schedulerTask = cron.schedule("*/2 * * * *", async () => {
    try {
      emitSchedulerTick("TASK", 0);
      emitTaskProcessStart(5);
      const result = await processPendingTasks();
      const { processed, errors } = result;
      emitTaskProcessComplete({ processed, completed: processed - errors.length, failed: errors.length, errors });
      if (result.processed > 0) {
        console.log(`[TaskScheduler] Processed ${result.processed} tasks${result.errors.length > 0 ? `, errors: ${result.errors.join("; ")}` : ""}`);
      }
      let triggerResult: { processed: number } = { processed: 0 };
      try {
        triggerResult = await processPendingTriggers();
        if (triggerResult.processed > 0) {
          console.log(`[TaskScheduler] Processed ${triggerResult.processed} completion triggers`);
        }
      } catch (triggerErr) {
        // 不让脏数据拖垮整个 scheduler / dashboard
        console.warn(`[TaskScheduler] Triggers skipped (data error): ${(triggerErr as Error).message?.slice(0, 200)}`);
      }

      //       //       // Step 6 V3: Generator Agent — 拉反思 → 聚类 → 决策 → 创建/附加 task
      try {
        const { processReflectionsV3 } = await import(
          "@/server/services/pending-action-bridge"
        );
        const result = await processReflectionsV3();
        if (result.clusters > 0) {
          console.log(
            `[TaskScheduler] V3 Generator: ${result.created} created, ${result.attached} attached, ${result.skipped} skipped (${result.clusters} clusters)`
          );
          for (const d of result.details.slice(0, 10)) {
            console.log(`  - ${d}`);
          }
        }
      } catch (err) {
        console.warn(`[TaskScheduler] V3 Generator error: ${err}`);
      }
    } catch (error) {
      console.error("[TaskScheduler] Error:", error);
    }
  });

  schedulerTask.start();
  console.log("[TaskScheduler] Started — runs every 2 minutes");

  if (stuckTaskResetTask) stuckTaskResetTask.stop();
  // P3 修复: 周期 5min -> 1min, 防止 V3 Generator 2min cycle 跑到老 cluster 24h 内 ACTIVE
  // 之前 5min 周期: V3 cycle 2min 多次 (10:00/10:02/10:04) 撞老 cluster (10:05 才 expire) → 全标 DEPRECATED
  // 现在 1min 周期: V3 cycle 2min 撞到 1min 前才 expire 的 cluster, 几乎不会撞
  stuckTaskResetTask = cron.schedule("*/1 * * * *", async () => {
    try {
      const count = await resetStuckTasks();
      if (count > 0) {
        console.log(`[TaskScheduler] Reset ${count} stuck tasks`);
      }
      // P3 修复: 同时清理过期 TaskCluster, 避免老 cluster 永远 ACTIVE 导致 ATTACH-RACE 误命中
      // 让新反思能正确创建新 task (而不是 attach 到老 task)
      try {
        const clusterCount = await expireOldTaskClusters();
        if (clusterCount > 0) {
          console.log(`[TaskScheduler] Expired ${clusterCount} old task clusters`);
        }
      } catch (clusterErr) {
        console.error("[TaskScheduler] TaskCluster expire error:", clusterErr);
      }
    } catch (error) {
      console.error("[TaskScheduler] Stuck task reset error:", error);
    }
  });
  stuckTaskResetTask.start();
  console.log("[TaskScheduler] Stuck task guard started — runs every 1 minute (P3 修复: 5min -> 1min 防 V3 race)");
}

/**
 * P3 修复: 把 24h+ 前的 TaskCluster 标记为 EXPIRED
 * 解决: 老 cluster 永远 ACTIVE → ATTACH-RACE 永远命中 → 新反思永远 attach 到老 task → 不建新 task
 *
 * 规则: clusterKey 相同 24h+ 前的 cluster, 且关联 task 已终态 (COMPLETED/CANCELLED/DEPRECATED/FAILED) → EXPIRED
 *       保留 ACTIVE 给 24h 内的 cluster (供 attach)
 */
export async function expireOldTaskClusters(): Promise<number> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // P3 修复: raw query 替代 prisma.taskCluster.findMany + include
  // 原因: TaskCluster schema 没 task 关系 (sibling 没声明), prisma include 报 Unknown field
  // 改: 用 SQL JOIN 一次查 cluster + task status
  const rows = await prisma.$queryRaw`
    SELECT tc.id
    FROM "TaskCluster" tc
    LEFT JOIN "Task" t ON t.id = tc."taskId"
    WHERE tc.status = 'ACTIVE'
      AND tc."createdAt" < ${oneDayAgo}
      AND (t.status IS NULL OR t.status IN ('COMPLETED', 'CANCELLED', 'DEPRECATED', 'FAILED', 'BLOCKED'))
  ` as Array<{ id: string }>;

  if (rows.length === 0) return 0;

  // 批量更新 EXPIRED（走 ORM，避免 PG/SQLite 占位符差异）
  await prisma.taskCluster.updateMany({
    where: { id: { in: rows.map(r => r.id) } },
    data: { status: "EXPIRED" },
  });

  return rows.length;
}

/**
 * Start the problem auto-resolution scheduler.
 * Runs every 10 minutes.
 */
export function startProblemScheduler() {
  if (problemSchedulerTask) problemSchedulerTask.stop();

  problemSchedulerTask = cron.schedule("*/2 * * * *", async () => {
    try {
      emitSchedulerTick("PROBLEM", 0);
      emitProblemProcessStart(10);
      const result = await processOpenProblems();
      emitProblemProcessComplete(result);
      if (result.processed > 0) {
        console.log(`[ProblemResolver] Processed ${result.processed} problems, resolved ${result.resolved}${result.errors.length > 0 ? `, errors: ${result.errors.join("; ")}` : ""}`);
      }
      const { processProblemTriggers } = await import("@/server/services/problem-completion-trigger");
      const triggerResult = await processProblemTriggers();
      if (triggerResult.processed > 0) {
        console.log(`[ProblemResolver] Processed ${triggerResult.processed} problem completion triggers`);
      }
    } catch (error) {
      console.error("[ProblemResolver] Error:", error);
    }
  });

  problemSchedulerTask.start();
  console.log("[ProblemResolver] Started — runs every 2 minutes");
}