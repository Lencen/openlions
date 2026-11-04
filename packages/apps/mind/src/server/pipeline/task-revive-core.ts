import { CLAIMABLE_IMPROVEMENT_TYPES, isClaimableImprovementType } from "./agent-capability";

/**
 * task-revive-core.ts — "任务复活"的**纯函数核心**(无 prisma 依赖, 可单测)。
 *
 * 2026-09-17 平台侧规范化(待办 todo_d563d97665df49428c45): 原先把"复活"的归一化与后置校验写在
 *   scripts/lib/task-revive.cjs 里, 每个脚本各自调用。问题不在"某个脚本写错一行", 而在
 *   **复活没有单一入口/没有服务端闸门**: 漏清 manualReview 就产出 15 条对所有人不可领的复活件,
 *   认领接口静默返回 task:null, 表现为"没有产能"却无人发现。
 *   现在归一化与闸门断言上移到平台 API(POST /api/v1/flywheel/tasks/revive), 本文件是其可单测核心;
 *   脚本只调用端点, 不再直写数据库。
 *
 * 语义提醒(踩过的雷):
 *   • Task.manualReview 是 NOT NULL 布尔 -> 必须置 **false(0)**, 不能置 null(IntegrityError)。
 *   • 复活 **不等于** 伪造证据, 也不改历史结论; 只动状态机字段。
 *   • 白名单是单一来源(claimable-task-types.json), 本文件不另写一份。
 */

/** 复活一条 Task 时必须归一化的字段(默认值); assignedAgent 由 keepOwner 决定。 */
export const REVIVE_NORMALIZE_TASK = Object.freeze({
  status: "PENDING",
  retryCount: 0,
  manualReview: false, // NOT NULL; 0 = 不再需要人工复核
  expectedOwner: null, // 归属断言必须清, 否则只有特定 agent 能领
  leaseExpiresAt: null, // 清租约, 否则仍被"在租"状态挡住
});

/** 终态不复活(要重做就新建并说明关联)。 */
export const TERMINAL_TASK_STATUSES = Object.freeze(["DONE", "DEPRECATED", "DROPPED"]);

export interface ReviveTaskRow {
  id: string;
  status: string;
  title?: string | null;
  manualReview?: boolean | number | null;
  assignedAgent?: string | null;
  expectedOwner?: string | null;
  leaseExpiresAt?: Date | number | string | null;
  retryCount?: number | null;
  sourceReflectionIds?: string | null;
  improvementType?: string | null;
  version?: number | null;
}

export interface ReviveOptions {
  /** 保留原 assignedAgent(默认 false: 清空回公开队列) */
  keepOwner?: boolean;
}

export interface NormalizedReviveTarget {
  status: "PENDING";
  retryCount: 0;
  manualReview: false;
  assignedAgent: string | null;
  expectedOwner: null;
  leaseExpiresAt: null;
}

/** 计算复活的归一化目标值(纯函数, 不落库)。 */
export function normalizeReviveTarget(row: ReviveTaskRow, opts: ReviveOptions = {}): NormalizedReviveTarget {
  return {
    status: "PENDING",
    retryCount: 0,
    manualReview: false,
    assignedAgent: opts.keepOwner ? (row.assignedAgent ?? null) : null,
    expectedOwner: null,
    leaseExpiresAt: null,
  };
}

/** 一条 PENDING 任务是否**对所有 agent**都不可认领(认领闸门的排除项)。 */
export function isTerminal(status: string | null | undefined): boolean {
  return TERMINAL_TASK_STATUSES.includes(String(status || ""));
}

/** 反思衍生任务(sourceReflectionIds 非空且不是 '[]')。 */
export function hasReflectionSource(sourceReflectionIds: string | null | undefined): boolean {
  const raw = String(sourceReflectionIds || "").trim();
  return raw !== "" && raw !== "[]";
}

/**
 * 闸门断言: 给出复活后的**目标字段**, 返回"仍然不可认领"的缺失明细(空数组 = 通过)。
 * 与认领 SQL(tasks/claim)同口径, 差别只是"不依赖具体认领者"。
 *
 * @param isActiveAgent 归属有效性判据(来自 AgentRegistry); 不传则跳过归属 ACTIVE 校验。
 */
export function claimGateMissing(
  after: {
    status: string;
    manualReview: boolean | number | null | undefined;
    assignedAgent: string | null | undefined;
    expectedOwner: string | null | undefined;
    leaseExpiresAt: unknown;
    improvementType: string | null | undefined;
    sourceReflectionIds: string | null | undefined;
  },
  isActiveAgent?: (agentId: string) => boolean,
): string[] {
  const missing: string[] = [];
  if (after.status !== "PENDING") missing.push(`status=${after.status}(非 PENDING)`);
  if (after.manualReview) missing.push("manualReview=1(会被认领闸门整体排除)");
  if (after.leaseExpiresAt != null) missing.push("leaseExpiresAt 未清(仍被视为在租)");
  if (after.assignedAgent != null && isActiveAgent && !isActiveAgent(String(after.assignedAgent))) {
    missing.push(`assignedAgent=${after.assignedAgent} 未登记或非 ACTIVE(保留归属会锁死认领)`);
  }
  if (after.expectedOwner != null && isActiveAgent && !isActiveAgent(String(after.expectedOwner))) {
    missing.push(`expectedOwner=${after.expectedOwner} 未登记或非 ACTIVE`);
  }
  if (!hasReflectionSource(after.sourceReflectionIds) && !isClaimableImprovementType(after.improvementType)) {
    missing.push(
      `improvementType '${after.improvementType ?? "(null)"}' 不在认领白名单且无 sourceReflectionIds(反思衍生)`,
    );
  }
  return missing;
}

/**
 * 幂等判据: 该任务是否**已经处于复活后的规范态**(无需再改, 无需再发事件)。
 * 只认"状态机上一模一样"的情形; 任何字段需要变更 -> 不是幂等跳过, 要真正复活并留痕。
 */
export function alreadyRevived(row: ReviveTaskRow, opts: ReviveOptions = {}): boolean {
  if (row.status !== "PENDING") return false;
  if (row.manualReview) return false;
  if (row.expectedOwner != null) return false;
  if (row.leaseExpiresAt != null) return false;
  if (Number(row.retryCount ?? 0) !== 0) return false;
  if (!opts.keepOwner && row.assignedAgent != null) return false;
  return true;
}

/** 复活的 human-readable reason(留痕用), 固定前缀便于按事件回溯。 */
export function reviveEventTitle(actor: string, reason: string, title: string | null | undefined): string {
  return `复活(${String(reason).slice(0, 80)}): ${String(title || "").slice(0, 60)} [by ${String(actor).slice(0, 60)}]`.slice(0, 300);
}

export { CLAIMABLE_IMPROVEMENT_TYPES };
