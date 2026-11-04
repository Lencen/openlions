/**
 * Task Resolved Scanner (P1-1)
 * 2026-06-06 SHARED-BRAIN-V2
 *
 * 监听 Task 状态变为 COMPLETED, 写一条反思到 Lions-Mind Memory + FlywheelEvent
 * 标注 agentSource = TASK_RESOLVED_HERMES / TASK_RESOLVED_CLAUDE
 *
 * 触发链路:
 * 1. scheduler emit TASK_STATUS_CHANGED (oldStatus != COMPLETED, newStatus == COMPLETED)
 * 2. 本 scanner 订阅, 拉 task + execution 信息
 * 3. 调 Lions-Mind memory.create (POST http://localhost:3000/api/trpc/memory.create)
 * 4. 写本地 FlywheelEvent.stage = TASK_RESOLVED + sourceType 区分 hermes/claude
 */
import { eventBus, type BusEvent } from "../event-bus";

const MIND_API = process.env.MIND_API_URL || "http://localhost:3000";

type TaskResolvedAgent = "TASK_RESOLVED_HERMES" | "TASK_RESOLVED_CLAUDE";

interface TaskInfo {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  completedAt?: string | Date | null;
  createdAt?: string | Date | null;
  retryCount?: number;
  sourceSummaryId?: string | null;
  sourceProblemId?: string | null;
}

interface ExecutionInfo {
  id: string;
  taskId: string;
  status: string;
  output?: string;
  thoughtProcess?: string;
  problemsEncountered?: string;
  solutionsApplied?: string;
  duration?: number;
  qualityPassed?: boolean;
  startedAt?: string | Date;
  completedAt?: string | Date;
}

/**
 * 从任务标题/描述/来源 推断是 hermes 任务还是 claude 任务
 * 启发式: title 含 "hermes" / "Hermes" / "反思"/"记忆" -> HERMES
 *         title 含 "claude" / "Claude" / "代码"/"实现" -> CLAUDE
 *         其他默认 HERMES (ut agent 主导)
 */
function inferAgent(task: TaskInfo): TaskResolvedAgent {
  const t = `${task.title || ""} ${task.description || ""}`.toLowerCase();
  if (t.includes("claude") || t.includes("代码实现") || t.includes("开发")) return "TASK_RESOLVED_CLAUDE";
  return "TASK_RESOLVED_HERMES";
}

function extractContent(task: TaskInfo, exec: ExecutionInfo | null): string {
  // 写一段反思
  const lines: string[] = [];
  lines.push(`任务完成反思: ${task.title}`);

  if (task.description) {
    lines.push(`\n## 任务描述\n${task.description.slice(0, 500)}`);
  }

  if (exec) {
    if (exec.output) {
      lines.push(`\n## 执行输出 (摘要)\n${exec.output.slice(0, 500)}`);
    }
    if (exec.problemsEncountered) {
      lines.push(`\n## 遇到的问题\n${exec.problemsEncountered.slice(0, 300)}`);
    }
    if (exec.solutionsApplied) {
      lines.push(`\n## 解决方案\n${exec.solutionsApplied.slice(0, 300)}`);
    }
    if (exec.duration) {
      lines.push(`\n## 耗时\n${Math.round(exec.duration / 1000)}s`);
    }
  }

  if (task.priority) {
    lines.push(`\n## 优先级: ${task.priority}`);
  }
  if (task.retryCount && task.retryCount > 0) {
    lines.push(`\n## 重试次数: ${task.retryCount}`);
  }

  return lines.join("\n");
}

async function writeMemory(
  content: string,
  task: TaskInfo,
  agentSource: TaskResolvedAgent,
  tier: "HOT" | "WARM" | "COLD" = "WARM"
): Promise<{ id: string; deduplicated: boolean } | null> {
  try {
    const url = `${MIND_API}/api/trpc/memory.create`;
    const payload = {
      content,
      tier,
      type: "EXPERIENCE",
      domain: "task-resolution",
      tags: `task,resolved,${agentSource}`,
      importance: 0.6,
      agentSource,
    };
    const r = await fetch(url, {
      method: "POST",
      // 2026-10-19: memory.create 是 protectedProcedure, 不带 x-api-key 必 401
      //   ("missing x-api-key header") —— 历史日志 702 次 [TaskResolvedScanner] mind 返 401。
      //   key 来源与 portal/extract 同口径: LIONS_MIND_SERVICE_KEY (兼容 LIONS_MIND_API_KEY)。
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.LIONS_MIND_SERVICE_KEY || process.env.LIONS_MIND_API_KEY || "",
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      console.error(`[TaskResolvedScanner] mind 返 ${r.status}`);
      return null;
    }
    const j = await r.json();
    const m = j?.result?.data ?? j;
    return { id: m?.id, deduplicated: !!m?.deduplicated };
  } catch (e: any) {
    console.error(`[TaskResolvedScanner] memory.create 异常: ${e?.message ?? e}`);
    return null;
  }
}

async function writeFlywheelEvent(args: {
  stage: string;
  sourceType: string;
  sourceId: string;
  sourceTitle: string;
  targetStage: string;
  targetId: string;
}): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");
    await prisma.flywheelEvent.create({
      data: {
        stage: args.stage,
        sourceType: args.sourceType,
        sourceId: args.sourceId,
        sourceTitle: args.sourceTitle.slice(0, 80),
        targetStage: args.targetStage,
        targetType: "MEMORY",
        targetId: args.targetId,
      },
    });
  } catch (e: any) {
    console.error(`[TaskResolvedScanner] flywheel 写入失败: ${e?.message ?? e}`);
  }
}

let started = false;

/**
 * 启动 scanner — 在 services init 时调一次
 */
export function startTaskResolvedScanner(): void {
  if (started) return;
  started = true;

  console.log(`[TaskResolvedScanner] Started — 监听 TASK_STATUS_CHANGED -> COMPLETED`);

  // 启动时先一次性拉最近的 COMPLETED 任务, 处理历史 (last 24h)
  scanRecentCompletedTasks().catch((e) => {
    console.error(`[TaskResolvedScanner] 启动扫描失败: ${e?.message ?? e}`);
  });

  // 订阅实时事件
  eventBus.on("TASK_STATUS_CHANGED", async (event) => {
    const p = event.payload as { taskId: string; oldStatus: string; newStatus: string };
    if (p.newStatus === "COMPLETED") {
      await handleTaskCompleted(p.taskId, event.actor);
    }
  });
}

async function handleTaskCompleted(taskId: string, actor: string): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");

    // 防重复: 查最近 1h 是否已经写过这个 task 的 RESOLVED
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await prisma.flywheelEvent.findFirst({
      where: {
        stage: "TASK_RESOLVED",
        sourceId: taskId,
        createdAt: { gte: since },
      },
    });
    if (recent) {
      console.log(`[TaskResolvedScanner] task ${taskId} 1h 内已写过 RESOLVED, 跳过`);
      return;
    }

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      console.warn(`[TaskResolvedScanner] task ${taskId} 不存在`);
      return;
    }

    // 找最近一次 execution
    const exec = await prisma.taskExecution.findFirst({
      where: { taskId },
      orderBy: { completedAt: "desc" },
    });

    const agentSource = inferAgent(task as any);
    const content = extractContent(task as any, exec as any);

    const m = await writeMemory(content, task as any, agentSource, "WARM");
    if (!m) {
      console.warn(`[TaskResolvedScanner] task ${taskId} memory 写入失败`);
      return;
    }

    await writeFlywheelEvent({
      stage: "TASK_RESOLVED",
      sourceType: agentSource,
      sourceId: task.id,
      sourceTitle: task.title,
      targetStage: "MEMORIZE",
      targetId: m.id,
    });

    console.log(
      `[TaskResolvedScanner] ✓ task ${taskId} -> mind memory ${m.id} (${m.deduplicated ? "dedup" : "new"}, src=${agentSource})`
    );
  } catch (e: any) {
    console.error(`[TaskResolvedScanner] handleTaskCompleted 异常: ${e?.message ?? e}`);
  }
}

async function scanRecentCompletedTasks(): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const tasks = await prisma.task.findMany({
      where: {
        status: "COMPLETED",
        updatedAt: { gte: since },
      },
      take: 50,
      orderBy: { updatedAt: "desc" },
    });
    console.log(`[TaskResolvedScanner] 历史扫描: ${tasks.length} 个最近 24h 完成的任务`);
    for (const t of tasks) {
      await handleTaskCompleted(t.id, "scanner");
    }
  } catch (e: any) {
    console.error(`[TaskResolvedScanner] scanRecentCompletedTasks 失败: ${e?.message ?? e}`);
  }
}
