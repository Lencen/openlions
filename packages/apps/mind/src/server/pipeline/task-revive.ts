import { prisma } from "@/lib/prisma";
import { CLAIMABLE_IMPROVEMENT_TYPES, claimableImprovementTypesSqlList } from "./agent-capability";
import {
  REVIVE_NORMALIZE_TASK,
  ReviveTaskRow,
  alreadyRevived,
  claimGateMissing,
  isTerminal,
  normalizeReviveTarget,
  reviveEventTitle,
} from "./task-revive-core";

/**
 * task-revive.ts — 平台侧"任务复活"的唯一落库入口(2026-09-17, 待办 todo_d563d97665df49428c45)。
 *
 * 归一化 + 闸门断言 + 留痕 + 幂等 + 事务内后置校验与回滚都在这里; 对外只有
 *   POST /api/v1/flywheel/tasks/revive。
 * 客户端脚本(scripts/revive-blocked-tasks.cjs 等)只调用端点, 不再各自写 UPDATE ——
 *   历史事故: 每个脚本各写各的 UPDATE, 漏清 manualReview -> 15 条复活件对所有人不可领。
 */

export const REVIVE_DEFAULT_ACTOR = "system:api:revive";
export const REVIVE_DEFAULT_REASON = "复活: 重新进入可认领状态";

export interface ReviveInput {
  ids: string[];
  actor?: string;
  reason?: string;
  keepOwner?: boolean;
  dryRun?: boolean;
}

export interface ReviveFailure {
  id: string;
  missing: string[];
  status?: string | null;
  title?: string | null;
}

export interface ReviveHttpResult {
  status: number;
  body: Record<string, any>;
}

/** 乐观锁冲突: 读候选与写复活之间任务 version 已变(并发认领/提交/复活)。 */
class ReviveCasLost extends Error {
  constructor(public readonly taskId: string) {
    super(`REVIVE_CAS_LOST:${taskId}`);
    this.name = "ReviveCasLost";
  }
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

async function loadTasks(ids: string[]): Promise<Map<string, ReviveTaskRow>> {
  const map = new Map<string, ReviveTaskRow>();
  if (!ids.length) return map;
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id,status,title,manualReview,assignedAgent,expectedOwner,leaseExpiresAt,retryCount,sourceReflectionIds,improvementType,version
     FROM Task WHERE id IN (${placeholders(ids.length)})`,
    ...ids,
  );
  for (const r of rows || []) {
    map.set(String(r.id), {
      id: String(r.id),
      status: String(r.status),
      title: r.title ?? null,
      manualReview: r.manualReview,
      assignedAgent: r.assignedAgent ?? null,
      expectedOwner: r.expectedOwner ?? null,
      leaseExpiresAt: r.leaseExpiresAt ?? null,
      retryCount: r.retryCount,
      sourceReflectionIds: r.sourceReflectionIds ?? null,
      improvementType: r.improvementType ?? null,
      version: r.version,
    });
  }
  return map;
}

async function loadActiveAgents(candidates: (string | null | undefined)[]): Promise<Set<string>> {
  const uniq = Array.from(new Set(candidates.filter(Boolean).map((x) => String(x))));
  if (!uniq.length) return new Set();
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT agent_id FROM AgentRegistry WHERE status='ACTIVE' AND agent_id IN (${placeholders(uniq.length)})`,
      ...uniq,
    );
    return new Set((rows || []).map((r) => String(r.agent_id)));
  } catch {
    // 隔离/测试库可能没有 AgentRegistry: 退化为"不校验归属 ACTIVE", 不因此阻断复活
    return new Set(uniq);
  }
}

/** 全库体检: 当前有多少 PENDING 任务**对所有人**都领不到(口径与认领闸门一致)。 */
export async function auditUnclaimable(): Promise<{ count: number; items: any[] }> {
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      "SELECT id,title,manualReview,assignedAgent,expectedOwner,improvementType FROM Task WHERE status='PENDING' AND (" +
        "manualReview = 1 " +
        "OR (expectedOwner IS NOT NULL AND expectedOwner NOT IN (SELECT agent_id FROM AgentRegistry WHERE status='ACTIVE')) " +
        "OR (assignedAgent IS NOT NULL AND assignedAgent NOT IN (SELECT agent_id FROM AgentRegistry WHERE status='ACTIVE')) " +
        "OR ((sourceReflectionIds IS NULL OR sourceReflectionIds='[]') AND (improvementType IS NULL OR improvementType NOT IN (" +
        claimableImprovementTypesSqlList() +
        ")))" +
        ")",
    );
    return {
      count: (rows || []).length,
      items: (rows || []).slice(0, 50).map((r) => ({ id: String(r.id), title: r.title ?? null, manualReview: r.manualReview, assignedAgent: r.assignedAgent ?? null, expectedOwner: r.expectedOwner ?? null, improvementType: r.improvementType ?? null })),
    };
  } catch (e: any) {
    return { count: -1, items: [{ error: String(e?.message || e).slice(0, 200) }] };
  }
}

/** 断言这些任务"真的可被领"(复用 claimGateMissing, 读当前库值)。 */
export async function verifyTasksByIds(ids: string[]): Promise<{ ok: boolean; problems: ReviveFailure[] }> {
  const byId = await loadTasks(ids);
  const active = await loadActiveAgents(Array.from(byId.values()).flatMap((r) => [r.assignedAgent, r.expectedOwner]));
  const problems: ReviveFailure[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      problems.push({ id, missing: ["不存在"] });
      continue;
    }
    const miss = claimGateMissing(
      {
        status: row.status,
        manualReview: row.manualReview,
        assignedAgent: row.assignedAgent,
        expectedOwner: row.expectedOwner,
        leaseExpiresAt: row.leaseExpiresAt,
        improvementType: row.improvementType,
        sourceReflectionIds: row.sourceReflectionIds,
      },
      (a) => active.has(a),
    );
    if (miss.length) problems.push({ id, missing: miss, status: row.status, title: row.title });
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 复活任务(单条/批量): 归一化 -> 闸门断言(不满足 422 + missing) -> 事务落库(留痕) ->
 *   事务内后置校验(不过则整批回滚) -> 返回体检读数。
 * 幂等: 已在规范态的任务走 skipped(ALREADY_REVIVED), 不重复写事件。
 */
export async function reviveTasks(input: ReviveInput): Promise<ReviveHttpResult> {
  const ids = Array.from(new Set((input.ids || []).map((x) => String(x || "").trim()).filter(Boolean)));
  const actor = String(input.actor || REVIVE_DEFAULT_ACTOR).slice(0, 120);
  const reason = String(input.reason || REVIVE_DEFAULT_REASON).slice(0, 200);
  const keepOwner = !!input.keepOwner;
  const dryRun = !!input.dryRun;

  if (!ids.length) {
    return { status: 400, body: { ok: false, error: "MISSING_TASK_IDS", detail: "body 需提供 taskIds:[...] 或 id:\"...\"" } };
  }

  const byId = await loadTasks(ids);
  const failures: ReviveFailure[] = [];
  for (const id of ids) {
    if (!byId.has(id)) failures.push({ id, missing: ["任务不存在"] });
  }
  const rows = ids.map((id) => byId.get(id)).filter(Boolean) as ReviveTaskRow[];
  const active = await loadActiveAgents(rows.flatMap((r) => [r.assignedAgent, r.expectedOwner]));

  const toApply: { row: ReviveTaskRow; target: ReturnType<typeof normalizeReviveTarget> }[] = [];
  const skipped: { id: string; reason: string; detail: string }[] = [];
  for (const row of rows) {
    if (isTerminal(row.status)) {
      failures.push({ id: row.id, status: row.status, title: row.title, missing: [`终态(${row.status})不复活(要重做请新建并说明关联)`] });
      continue;
    }
    // 先做闸门断言, 再判幂等 —— 顺序很关键(复测实测缺陷): 一条"字段已规范化但仍不可领"的任务
    //   (如 improvementType 不在白名单/保留的归属已失效)如果先判 alreadyRevived, 会被当成
    //   "ALREADY_REVIVED 成功跳过", 端点返回 200 却对它不可领的事实**静默**。这正是本次要根治的病:
    //   宁可在源头上 422 报出 missing, 也不能对外谎报成功。
    const target = normalizeReviveTarget(row, { keepOwner });
    const miss = claimGateMissing(
      {
        status: target.status,
        manualReview: target.manualReview,
        assignedAgent: target.assignedAgent,
        expectedOwner: target.expectedOwner,
        leaseExpiresAt: target.leaseExpiresAt,
        improvementType: row.improvementType,
        sourceReflectionIds: row.sourceReflectionIds,
      },
      (a) => active.has(a),
    );
    if (miss.length) {
      failures.push({ id: row.id, status: row.status, title: row.title, missing: miss });
      continue;
    }
    if (alreadyRevived(row, { keepOwner })) {
      skipped.push({ id: row.id, reason: "ALREADY_REVIVED", detail: "已是复活后的规范态且可领(幂等跳过, 不重复留痕)" });
      continue;
    }
    toApply.push({ row, target });
  }

  if (failures.length) {
    return {
      status: 422,
      body: {
        ok: false,
        error: "REVIVE_GATE_FAILED",
        message: `闸门断言未通过: ${failures.length} 条(整批未做任何变更, 请修正后重试)`,
        missing: failures,
        claimableImprovementTypes: CLAIMABLE_IMPROVEMENT_TYPES,
      },
    };
  }

  if (dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        actor,
        reason,
        keepOwner,
        revived: [],
        wouldRevive: toApply.map((x) => x.row.id),
        skipped,
        audit: await auditUnclaimable(),
      },
    };
  }

  const applied: { id: string; from: string; transitionId: string; flywheelEventId: string }[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      for (const { row, target } of toApply) {
        // version CAS: "读候选"与"写复活"之间若任务被并发改过(被认领/提交/另一次复活), 影响行=0。
        //   不用 update(按 id) 是刻意的: 那会在并发下把同一条任务复活两次并写两条 TASK_REVIVED 事件,
        //   破坏"重复调用不产生重复事件"的幂等承诺。
        const upd = await tx.task.updateMany({
          where: { id: row.id, version: row.version ?? 0 },
          data: {
            status: target.status,
            retryCount: target.retryCount,
            manualReview: target.manualReview,
            assignedAgent: target.assignedAgent,
            expectedOwner: target.expectedOwner,
            leaseExpiresAt: target.leaseExpiresAt,
            version: { increment: 1 },
            updatedAt: new Date(),
          },
        });
        if (upd.count !== 1) throw new ReviveCasLost(row.id);
        const tr = await tx.taskStateTransition.create({
          data: {
            taskId: row.id,
            fromStatus: row.status,
            toStatus: "PENDING",
            actor,
            reason,
            metadata: JSON.stringify({ normalized: REVIVE_NORMALIZE_TASK, keepOwner, source: "api:/api/v1/flywheel/tasks/revive", prevVersion: row.version ?? null }),
          },
        });
        const ev = await tx.flywheelEvent.create({
          data: {
            stage: "TASK_REVIVED",
            sourceType: "task",
            sourceId: row.id,
            sourceTitle: reviveEventTitle(actor, reason, row.title),
            targetStage: "OK",
            taskId: row.id,
          },
        });
        applied.push({ id: row.id, from: String(row.status), transitionId: tr.id, flywheelEventId: ev.id });
      }
      // 事务内后置校验: 复活完必须立刻断言可领性; 任一条不过 -> 抛错回滚整批(不留"半复活"脏状态)。
      const appliedIds = toApply.map((x) => x.row.id);
      if (appliedIds.length) {
        const afterRows = await tx.$queryRawUnsafe<any[]>(
          `SELECT id,status,manualReview,assignedAgent,expectedOwner,leaseExpiresAt,sourceReflectionIds,improvementType
           FROM Task WHERE id IN (${placeholders(appliedIds.length)})`,
          ...appliedIds,
        );
        for (const r of afterRows || []) {
          const miss = claimGateMissing(
            {
              status: String(r.status),
              manualReview: r.manualReview,
              assignedAgent: r.assignedAgent ?? null,
              expectedOwner: r.expectedOwner ?? null,
              leaseExpiresAt: r.leaseExpiresAt ?? null,
              improvementType: r.improvementType ?? null,
              sourceReflectionIds: r.sourceReflectionIds ?? null,
            },
            (a) => active.has(a),
          );
          if (miss.length) throw new Error(`POST_REVIVE_GATE_FAILED ${r.id}: ${miss.join("; ")}`);
        }
      }
    });
  } catch (e: any) {
    if (e instanceof ReviveCasLost) {
      return {
        status: 409,
        body: {
          ok: false,
          error: "REVIVE_CAS_LOST",
          message: `任务 ${e.taskId} 在读后写前被并发修改(已被认领/提交/复活), 本次整批未复活; 请重新查询后重试。`,
        },
      };
    }
    throw e;
  }

  return {
    status: 200,
    body: {
      ok: true,
      dryRun: false,
      actor,
      reason,
      keepOwner,
      revived: applied,
      skipped,
      audit: await auditUnclaimable(),
    },
  };
}
