/**
 * V1.6 improving-tasks-cron — 批量执行 PENDING ImprovingTask
 * 设计: docs/lions-flywheel-v16-implementation-design.md §3.1
 *
 * 触发频率建议: 每小时第 15 分钟 (cron: "15 * * * *", 在反思 cron 之后)
 *
 * 反思 cron ("5 * * * *") → reflectWorker() → saveReflectionResult → generateImprovingTasks 钩子 (Step 2c)
 * 改进 cron ("15 * * * *") → 批量执行 PENDING ImprovingTask (本文件)
 *
 * V1.6 §6.7 不死循环:
 * - execute 后 Task.status = DONE/FAILED, 不自动重试
 * - MIGRATE_DATA 默认 manualReview=true, 走 SKIPPED 等人审
 * - 失败兜底: TaskStateTransition 审计 + FAILED 不重试 (需手动)
 */

import { prisma } from "@/lib/prisma";
import { executeImprovingTask } from "./execute-improving-task";
import { sweepPremiseSatisfiedFindings, type PremiseSweepResult } from "./finding-premise-close";
// 2026-09-23 agent-x #5: cronjob 执行期上下文注入 —— 主 agent 核心 memory 冻结快照
import { captureAgentMemorySnapshot, type AgentMemorySnapshot } from "./agent-memory-snapshot";

/**
 * 2026-09-11 第 34 轮: 本执行器**真正实现了**哪些 improvementType。
 *
 * 为什么列白名单而不是继续用黑名单: 2026-09-10 用黑名单排除"交给 agent 认领"的类型, 当天有 6 条任务被清空;
 *   2026-09-11 17:15:04 同一 bug 复发 —— 黑名单漏了 VERIFICATION, 5 条独立复核任务被抢走后判
 *   "未知 improvementType: VERIFICATION" FAILED。枚举式修补每加一个新类型都要记得补黑名单, 必然复发。
 *   白名单则相反: 未列出的类型(含将来任何 agent 认领类)默认不会被碰。
 * 取值依据: execute-improving-task.ts 的分发分支(MERGE_CONFLICT/RE_EXTRACT/CREATE_MEMORY/CREATE_PRACTICE/
 *   CREATE_KNOWLEDGE/FIX_DATA/MARK_REVIEW/MIGRATE_DATA/APPLY_IMPROVEMENT/FIX_THEME/FIX_CONFLICT/RE_RUN/
 *   THEME_IMPROVE/BRIDGE)。新增分支时必须同步在此登记。
 */
const EXECUTOR_SUPPORTED_TYPES = [
  "MERGE_CONFLICT", "RE_EXTRACT", "CREATE_MEMORY", "CREATE_PRACTICE", "CREATE_KNOWLEDGE",
  "FIX_DATA", "MARK_REVIEW", "MIGRATE_DATA", "APPLY_IMPROVEMENT",
  "FIX_THEME", "FIX_CONFLICT", "RE_RUN", "THEME_IMPROVE", "BRIDGE",
];

export interface ImprovingTasksCronResult {
  scanned: number;
  executed: number;
  failed: number;
  skipped: number;
  byType: Record<string, number>;
  details: Array<{
    taskId: string;
    type: string;
    status: string;
    summary: string;
    affectedRows?: number;
    error?: string;
  }>;
  /** 2026-09-14 FW-GROW: 每轮顺带关闭"前提已不成立/已满足"的搁浅 finding(有界) */
  premiseSweep?: PremiseSweepResult;
}

/**
 * 扫 PENDING ImprovingTask + 批量执行
 * limit 默认 10 (避免单次执行太多, 留时间给下次 cron)
 */
export async function runImprovingTasksCron(opts: {
  limit?: number;
  actor?: string;
  dryRun?: boolean;
  type?: string;         // 2026-09-09: 指定只处理某 improvementType (如 THEME_IMPROVE), 避免被 BRIDGE 积压饿死
  signal?: AbortSignal;  // P0-3: route 层 withCronTimeout 注入, 提前 break 循环
} = {}): Promise<ImprovingTasksCronResult> {
  const limit = opts.limit || 50; // P2-1: 从 10 调大到 50, 加速 BRIDGE 积压消化
  const actor = opts.actor || "cron:v16:improving-tasks";
  const signal = opts.signal;

  // 1. 找 PENDING ImprovingTask (improvementType IS NOT NULL; 指定 type 时只取该类型)
  //    按 priority 排序: P1 优先 (V1.6 §3.2 优先级: FIX_CONFLICT=P1)
  const tasks = await prisma.task.findMany({
    where: {
      status: "PENDING",
      // 2026-09-11 第 34 轮修(实测缺陷, 复发): 2026-09-10 这里用**黑名单**排除"交给 agent 认领"的类型,
      //   当天实测 6 条任务被清空; 2026-09-11 17:15:04 同一 bug **复发** —— 黑名单漏了 VERIFICATION,
      //   于是 5 条独立复核任务被本 cron 抢走(PENDING->PROCESSING)后立即以"未知 improvementType: VERIFICATION"
      //   判 FAILED(还拉低 MACS-COLLAB 1.0->0.989)。根因是**枚举式修补**: 每出现一个新类型就要记得补黑名单。
      //   改为**白名单** —— 只挑执行器真正实现了的类型(见 execute-improving-task.ts 的分发分支),
      //   未列出的(含将来任何 agent 认领类)一律不碰, 结构上杜绝复发。
      improvementType: opts.type ? opts.type as any : { in: EXECUTOR_SUPPORTED_TYPES },
    },
    select: { id: true, improvementType: true, priority: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: limit,
  });

  // 2026-09-14 FW-GROW: 前提已不成立/已满足的搁浅 finding 必须有确定的退出通道 ——
  //   否则它们永远停在 NEW(任务生成器只在反思更新后才重开主题), 持续稀释 findings_landed_rate。
  //   有界(默认 300 条/轮), 只做确定性判据 + 证据硬拦, 证据不合格转人审, 不放水。
  const runPremiseSweep = async (): Promise<PremiseSweepResult> => {
    try {
      return await sweepPremiseSatisfiedFindings({ limit: 300, signal });
    } catch (e: any) {
      console.warn("[improving-tasks-cron] premise sweep 失败(非致命): " + String(e?.message || "").slice(0, 120));
      return { examined: 0, satisfied: 0, closed: 0, toNeedsReview: 0, reflectionsTouched: 0, byAction: {}, samples: [] };
    }
  };

  if (tasks.length === 0) {
    return {
      scanned: 0,
      executed: 0,
      failed: 0,
      skipped: 0,
      byType: {},
      details: [],
      premiseSweep: await runPremiseSweep(),
    };
  }

  // 2. (agent-x #5) 冻结快照捕获段: 每轮 cron 启动时捕获一次主 agent 核心 memory,
  //    本轮所有 task 执行共享同一快照(创建时一次快照多次执行一致)。
  //    捕获失败不阻断执行(非致命, 该轮不带上下文, 下一轮再试)。
  let agentMemorySnapshot: AgentMemorySnapshot | null = null;
  try {
    agentMemorySnapshot = await captureAgentMemorySnapshot();
    console.log(`[improving-tasks-cron] agent-x#5 已捕获主 agent 核心 memory 快照: schemaVersion=${agentMemorySnapshot.schemaVersion} agentId=${agentMemorySnapshot.agentId} entries=${agentMemorySnapshot.count}`);
  } catch (e: any) {
    console.warn(`[improving-tasks-cron] 捕获主 agent 核心 memory 快照失败(非致命, 本轮不注入): ${String(e?.message || e).slice(0, 120)}`);
  }

  // 3. 逐个执行 (不用 Promise.allSettled, 避免并发写 TaskStateTransition 冲突)
  //    V1.6 §6.7 顺序执行更安全, 单 cron 跑 10 条也不会超时
  const details: ImprovingTasksCronResult["details"] = [];
  let executed = 0, failed = 0, skipped = 0;
  const byType: Record<string, number> = {};

  for (const t of tasks) {
    // P0-3: route 层 abort 触发后, 跳过剩余 task
    if (signal?.aborted) {
      console.warn(`[improving-tasks-cron] signal aborted at taskId=${t.id}, break`);
      skipped++;
      details.push({
        taskId: t.id,
        type: t.improvementType || "UNKNOWN",
        status: "SKIPPED",
        summary: "route 层 abort, 跳过等下次重试",
        affectedRows: 0,
        error: "ABORTED_BY_ROUTE",
      });
      continue;
    }
    try {
      // P0-1 修复: 单 task 30 秒超时, 防止 RE_EXTRACT 的 LLM 合成阻塞 cron
      const taskTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("TASK_TIMEOUT_30S")), 30000)
      );
      const r = await Promise.race([
        executeImprovingTask({
          taskId: t.id,
          actor,
          dryRun: opts.dryRun,
          // agent-x #5 执行期注入段: 携带本轮冻结快照, 由执行器写入 TaskExecution.metadata.agentMemorySnapshot
          agentMemorySnapshot: agentMemorySnapshot ?? undefined,
        }),
        taskTimeout,
      ]) as any;
      if (r.status === "DONE") executed++;
      else if (r.status === "FAILED") failed++;
      else if (r.status === "SKIPPED") skipped++;

      byType[r.type] = (byType[r.type] || 0) + 1;
      details.push({
        taskId: r.taskId,
        type: r.type,
        status: r.status,
        summary: r.summary,
        affectedRows: r.affectedRows,
        error: r.error,
      });
    } catch (err: unknown) {
      // 单条失败不影响其他
      const message = err instanceof Error ? err.message : String(err);
      if (message === "TASK_TIMEOUT_30S") {
        // P0-1: 超时标记 SKIPPED 而非 FAILED, 下次 cron 可重试
        skipped++;
        details.push({
          taskId: t.id,
          type: t.improvementType || "UNKNOWN",
          status: "SKIPPED",
          summary: "单 task 超时(30s), 跳过等下次重试",
          error: "TASK_TIMEOUT_30S",
        });
      } else {
        failed++;
        details.push({
          taskId: t.id,
          type: t.improvementType || "UNKNOWN",
          status: "FAILED",
          summary: `cron 调用抛异常: ${message}`,
          error: message,
        });
      }
    }
  }

  return {
    scanned: tasks.length,
    executed,
    failed,
    skipped,
    byType,
    details,
    premiseSweep: await runPremiseSweep(),
  };
}
