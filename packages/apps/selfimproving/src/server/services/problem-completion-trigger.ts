/**
 * Problem Completion Trigger Service
 * 
 * When a problem is solved, automatically trigger a reflection task
 * to capture the problem-solving process and integrate with Lions-Mind.
 */

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

export interface TriggerResult {
  success: boolean;
  triggerId?: string;
  reflectionTaskId?: string;
  error?: string;
}

/**
 * Create a ProblemCompletionTrigger and reflection task when a problem is solved.
 */
export async function createProblemCompletionTrigger(
  problemId: string,
  resolution: { rootCause: string; solution: string }
): Promise<TriggerResult> {
  try {
    // Get problem details
    const problem = await prisma.problem.findUnique({ where: { id: problemId } });

    if (!problem) {
      return { success: false, error: "Problem not found" };
    }

    // Generate reflection prompt
    const reflectionPrompt = generateReflectionPrompt(problem, resolution);

    // Create a reflection task first
    const reflectionTask = await prisma.task.create({
      data: {
        title: `[复盘] 问题: ${problem.description.slice(0, 50)}`,
        description: reflectionPrompt,
        background: `自动复盘任务：来自问题 ${problemId} 解决后的复盘`,
        requirements: "1. 分析问题根因\n2. 总结解决方案\n3. 提取经验教训\n4. 识别预防措施",
        materials: "",
        acceptanceCriteria: "1. 输出包含问题根因分析\n2. 输出包含解决方案说明\n3. 输出包含对类似问题的预防建议",
        qualityStandards: "复盘内容具体、有深度、可操作",
        priority: "P2",
        status: "PENDING",
      },
    });

    // Create the trigger record.
    //
    // IMPORTANT (finding f-004 regression guard): the reflection task above MUST
    // be created before this INSERT, and the trigger must reference its real id
    // (reflectionTask.id). The raw-SQL fallback is used when the Prisma Client
    // model accessor is undefined (mirrors processProblemTriggers); it must NOT
    // reference a not-yet-created / undefined reflectionTask.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const triggerModel = (prisma as any).problemCompletionTrigger;
    let triggerId: string;

    if (triggerModel) {
      const trigger = await prisma.problemCompletionTrigger.create({
        data: {
          problemId,
          triggerType: "AUTO",
          reflectionPrompt,
          status: "PENDING",
          reflectionTaskId: reflectionTask.id,
        },
      });
      triggerId = trigger.id;
    } else {
      triggerId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "ProblemCompletionTrigger"
          (id, "problemId", "triggerType", "reflectionPrompt", status, "createdAt", "reflectionTaskId")
        VALUES
          (${triggerId}, ${problemId}, 'AUTO', ${reflectionPrompt}, 'PENDING', ${new Date()}, ${reflectionTask.id})
      `;
    }

    console.log(`[ProblemCompletionTrigger] Created trigger ${triggerId} for problem ${problemId}`);

    return {
      success: true,
      triggerId,
      reflectionTaskId: reflectionTask.id,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(`[ProblemCompletionTrigger] Error: ${msg}`);
    return { success: false, error: msg };
  }
}

/**
 * Generate a reflection prompt from problem and resolution data.
 */
function generateReflectionPrompt(
  problem: { id: string; description: string; severity: string },
  resolution: { rootCause: string; solution: string }
): string {
  return `
## 问题解决复盘

### 问题信息
- 问题ID: ${problem.id}
- 问题描述: ${problem.description}
- 严重程度: ${problem.severity}

### 问题根因
${resolution.rootCause}

### 解决方案
${resolution.solution}

### 复盘要求
请总结：
1. 问题识别的关键信号是什么？
2. 根因分析的方法有哪些？
3. 解决方案的设计思路是什么？
4. 对类似问题有什么预防建议？
5. 这次经历有什么可以复用的模式？
`.trim();
}

/**
 * Process pending problem completion triggers.
 * This should be called periodically by the scheduler.
 * When a reflection task is completed, writes the problem-solving insight to Lions-Mind.
 */
export async function processProblemTriggers(): Promise<{ processed: number }> {
  // Use raw SQL when Prisma Client model accessor is undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = (prisma as any).problemCompletionTrigger;

  let pending: Array<{ id: string; problemId: string; reflectionTaskId: string | null; reflectionPrompt: string }> = [];

  if (model) {
    pending = await model.findMany({
      where: { status: "PENDING" },
      take: 10,
    });
  } else {
    const result = await prisma.$queryRaw<typeof pending>`
      SELECT id, "problemId", "reflectionTaskId", "reflectionPrompt" FROM "ProblemCompletionTrigger"
      WHERE status = 'PENDING' LIMIT 10
    `;
    pending = result;
  }

  for (const trigger of pending) {
    if (!trigger.reflectionTaskId) {
      // Use raw SQL fallback for update
      const model2 = (prisma as any).problemCompletionTrigger;
      if (!model2) {
        await prisma.$executeRaw`
          UPDATE "ProblemCompletionTrigger"
          SET status = 'PROCESSED', "processedAt" = ${new Date().toISOString()}
          WHERE id = ${trigger.id}
        `;
      } else {
        await prisma.problemCompletionTrigger.update({
          where: { id: trigger.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });
      }
      continue;
    }

    const reflectionTask = await prisma.task.findUnique({
      where: { id: trigger.reflectionTaskId },
    });

    if (reflectionTask?.status === "COMPLETED") {
      // Write problem resolution insight to Lions-Mind
      try {
        const LIONS_MIND_URL = process.env.LIONS_MIND_URL || "http://localhost:3000";

        const problem = await prisma.problem.findUnique({
          where: { id: trigger.problemId },
        });

        // Read reflection output from TaskExecution (NOT reflectionTask.output which doesn't exist)
        const execution = await prisma.taskExecution.findFirst({
          where: { taskId: trigger.reflectionTaskId, status: "COMPLETED" },
          orderBy: { completedAt: "desc" },
        });

        // Use unified knowledge.generate API to write both Memory + Knowledge
        await fetch(`${LIONS_MIND_URL}/api/trpc/knowledge.generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "PROBLEM_RESOLUTION",
            sourceId: trigger.id,
            title: `[问题复盘] ${problem?.description?.slice(0, 30) || trigger.problemId}`,
            description: execution?.output || trigger.reflectionPrompt || "",
            executionOutput: execution?.output || "",
            problemsEncountered: problem?.description || "",
            solutionsApplied: execution?.output || "",
            rootCause: trigger.reflectionPrompt,
            resolution: execution?.output || "",
            domain: "problem-solving",
            tags: ["problem", "reflection", "resolution"],
          }),
        });

        console.log(`[ProblemCompletionTrigger] Wrote insight to Lions-Mind via knowledge.generate: trigger ${trigger.id}`);
      } catch (error) {
        console.error(`[ProblemCompletionTrigger] Failed to write to Lions-Mind: ${error}`);
      }

      // Mark trigger as processed (raw SQL fallback)
      const model3 = (prisma as any).problemCompletionTrigger;
      if (!model3) {
        await prisma.$executeRaw`
          UPDATE "ProblemCompletionTrigger"
          SET status = 'PROCESSED', "processedAt" = ${new Date().toISOString()}
          WHERE id = ${trigger.id}
        `;
      } else {
        await prisma.problemCompletionTrigger.update({
          where: { id: trigger.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });
      }

      console.log(`[ProblemCompletionTrigger] Processed trigger ${trigger.id}`);
    }
  }

  return { processed: pending.length };
}