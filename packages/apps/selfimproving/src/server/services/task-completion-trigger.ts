/**
 * Task Completion Trigger Service
 * 
 * When a task is completed, automatically trigger a reflection task
 * to capture learnings and integrate with Lions-Mind.
 */

import { prisma } from "@/lib/prisma";

export interface TriggerResult {
  success: boolean;
  triggerId?: string;
  reflectionTaskId?: string;
  error?: string;
}

/**
 * Create a TaskCompletionTrigger and reflection task when a task is completed.
 */
export async function createTaskCompletionTrigger(
  taskId: string,
  executionId: string
): Promise<TriggerResult> {
  try {
    // Get task and execution details
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    const execution = await prisma.taskExecution.findUnique({ where: { id: executionId } });

    if (!task || !execution) {
      return { success: false, error: "Task or execution not found" };
    }

    // Generate reflection prompt from task and execution data
    const reflectionPrompt = generateReflectionPrompt(task, execution);

    // Create a reflection task first
    const reflectionTask = await prisma.task.create({
      data: {
        title: `[反思] ${task.title.slice(0, 60)}`,
        description: reflectionPrompt,
        background: `自动反思任务：来自 ${task.id} 的完成后的反思`,
        requirements: "1. 分析任务执行过程\n2. 总结关键经验\n3. 提取可复用的模式\n4. 识别改进机会",
        materials: "",
        acceptanceCriteria: "1. 输出包含执行过程分析\n2. 输出包含经验总结\n3. 输出包含对未来类似任务的建议",
        qualityStandards: "反思内容具体、有深度、可操作",
        priority: "P2",
        status: "PENDING",
      },
    });

    // Create the trigger record
    const trigger = await prisma.taskCompletionTrigger.create({
      data: {
        taskId,
        triggerType: "AUTO",
        reflectionPrompt,
        status: "PENDING",
        reflectionTaskId: reflectionTask.id,
      },
    });

    // Track REFLECTION task creation in flywheel
    await prisma.flywheelEvent.create({
      data: {
        stage: "REFLECTION_TASK",
        sourceType: "TASK_COMPLETION",
        sourceId: task.id,
        sourceTitle: `反思: ${task.title.slice(0, 50)}`,
        targetStage: "REFLECTION",
        targetType: "TASK",
        targetId: reflectionTask.id,
      },
    });

    console.log(`[TaskCompletionTrigger] Created trigger ${trigger.id} for task ${taskId}`);

    return {
      success: true,
      triggerId: trigger.id,
      reflectionTaskId: reflectionTask.id,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[TaskCompletionTrigger] Error: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Generate a reflection prompt from task and execution data.
 */
function generateReflectionPrompt(
  task: { id: string; title: string; description: string; requirements: string },
  execution: {
    output: string;
    thoughtProcess: string | null;
    problemsEncountered?: string | null;
    solutionsApplied?: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  }
): string {
  const duration = execution.completedAt && execution.startedAt ? execution.completedAt.getTime() - execution.startedAt.getTime() : 0;
  const durationMin = Math.round(duration / 60000);

  return `
## 任务完成反思

### 任务信息
- 任务ID: ${task.id}
- 任务标题: ${task.title}

### 执行摘要
- 执行时长: ${durationMin} 分钟
- 产出长度: ${execution.output?.length || 0} 字符

### 执行过程
${execution.thoughtProcess || "（无记录）"}

### 产出概要
${execution.output?.slice(0, 500) || "（无产出）"}
${execution.output?.length > 500 ? "\n... (truncated)" : ""}

### 遇到的问题
${execution.problemsEncountered || "无"}

### 解决方案
${execution.solutionsApplied || "无"}

### 反思要求
请总结：
1. 成功的关键因素是什么？
2. 哪里可以改进？
3. 对类似任务有什么建议？
4. 有哪些模式可以复用？
`.trim();
}

/**
 * Process pending task completion triggers.
 * This should be called periodically by the scheduler.
 */
export async function processPendingTriggers(): Promise<{ processed: number }> {
  const model = (prisma as any).taskCompletionTrigger;

  let pending: Array<{ id: string; status: string; reflectionTaskId: string | null; taskId?: string | null }> = [];

  if (model) {
    pending = await model.findMany({
      where: { status: "PENDING" },
      take: 10,
    }) as Array<{ id: string; status: string; reflectionTaskId: string | null; taskId?: string | null }>;
  } else {
    // Fallback: raw SQL when Prisma model accessor is undefined
    const result = await prisma.$queryRaw<Array<{ id: string; status: string; reflectionTaskId: string | null; taskId: string | null }>>`
      SELECT id, status, reflectionTaskId, taskId FROM "TaskCompletionTrigger"
      WHERE status = 'PENDING' LIMIT 10
    `;
    pending = result;
  }

  for (const trigger of pending) {
    // Check if reflection task is completed
    if (trigger.reflectionTaskId) {
      const reflectionTask = await prisma.task.findUnique({
        where: { id: trigger.reflectionTaskId },
      });

if (reflectionTask?.status === "COMPLETED") {
        // Get reflection content from execution
        const execution = await prisma.taskExecution.findFirst({
          where: {
            taskId: trigger.reflectionTaskId,
            status: "COMPLETED",
          },
          orderBy: { completedAt: "desc" },
        });

        if (execution?.output) {
          // Resolve the source reflection(s) in Lions-Mind so pending-action-bridge can create tasks
          if (trigger.taskId) {
            try {
              const sourceTask = await prisma.task.findUnique({ where: { id: trigger.taskId } });
              if (sourceTask?.sourceReflectionIds) {
                const reflectionIds = sourceTask.sourceReflectionIds.split(",").map((id: string) => id.trim()).filter(Boolean);
                for (const refId of reflectionIds) {
                  try {
                    const controller2 = new AbortController();
                    const timeout2 = setTimeout(() => controller2.abort(), 8000);
                    const resolveResp = await fetch("http://localhost:3000/api/trpc/reflection.resolve", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: refId, insight: (execution.output || "").slice(0, 500) }),
                      signal: controller2.signal,
                    });
                    clearTimeout(timeout2);
                    if (resolveResp.ok) {
                      console.log(`[TaskCompletionTrigger] Resolved reflection ${refId} in Lions-Mind`);
                    }
                  } catch { /* ignore individual resolve failures */ }
                }
              }
            } catch { /* ignore reflection resolve errors */ }
          }
          // Integrate with Lions-Mind via unified knowledge.generate API
          try {
            const domain = extractDomain(reflectionTask.title);
            const tags = extractTags(reflectionTask.description + " " + (execution.output || ""));

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);

            const response = await fetch("http://localhost:3000/api/trpc/knowledge.generate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "TASK_COMPLETION",
                sourceId: trigger.id,
                title: reflectionTask.title,
                description: execution.output || "",
                executionOutput: execution.output || "",
                problemsEncountered: execution.problemsEncountered || "",
                solutionsApplied: execution.solutionsApplied || "",
                domain: domain,
                tags: tags.split(",").filter(t => t.trim()),
                buildGraph: true,
              }),
              signal: controller.signal,
            });
            clearTimeout(timeout);

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            console.log(`[TaskCompletionTrigger] Integrated reflection into Lions-Mind: ${trigger.id}`);

            // Track KNOWLEDGE integration in flywheel
            await prisma.flywheelEvent.create({
              data: {
                stage: "KNOWLEDGE_INTEGRATED",
                sourceType: "KNOWLEDGE_GENERATE",
                sourceId: trigger.id,
                sourceTitle: `知识: ${reflectionTask.title.slice(0, 50)}`,
                targetStage: "KNOWLEDGE",
                targetType: "KNOWLEDGE",
                targetId: trigger.id,
              },
            });
          } catch (e) {
            console.error(`[TaskCompletionTrigger] Lions-Mind integration failed: ${e}`);
          }

          // Mark trigger as processed (raw SQL fallback)
          const model2 = (prisma as any).taskCompletionTrigger;
          if (!model2) {
            await prisma.$executeRaw`
              UPDATE "TaskCompletionTrigger"
              SET status = 'PROCESSED', "processedAt" = ${new Date().toISOString()}
              WHERE id = ${trigger.id}
            `;
          } else {
            await prisma.taskCompletionTrigger.update({
              where: { id: trigger.id },
              data: {
                status: "PROCESSED",
                processedAt: new Date(),
              },
            });
          }

          console.log(`[TaskCompletionTrigger] Processed trigger ${trigger.id}`);
        }
      }
    }
  }

  return { processed: pending.length };
}

/** Extract domain from title (simple heuristics) */
function extractDomain(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("prisma") || lower.includes("database")) return "prisma";
  if (lower.includes("scheduler") || lower.includes("task")) return "lions-selfimproving-task";
  if (lower.includes("mind") || lower.includes("memory")) return "lions-mind";
  if (lower.includes("api") || lower.includes("endpoint")) return "api";
  if (lower.includes("cron") || lower.includes("scheduler")) return "scheduler";
  return "general";
}

/** Extract tags from text */
function extractTags(text: string): string {
  const keywords = ["prisma", "scheduler", "task", "api", "database", "bug", "fix", "performance", "reflection", "integration", "cron", "tier", "decay"];
  return keywords.filter(k => text.toLowerCase().includes(k)).join(",") || "general";
}