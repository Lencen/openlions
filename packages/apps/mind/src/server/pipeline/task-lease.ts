// task-lease.ts — 任务认领: 租约(TTL)+心跳续约 / version 乐观锁 / expectedOwner+takeover / 对称审计
// 落地来源: 知识条目 cmtwa1b1900j0yn162「任务认领机制应内建的并发控制要素」
//   提案 cmtwb7z1o00l11j76e6tx65um; 复核 cmu0stufv00nuki4ag8rzt5ur 限定的最小命题:
//   "新增 version/lease/expireAt/expectedOwner 字段 + 释放侧对称记 transition"。
//
// 设计取舍(为何用 CAS 而非 Redis SETNX):
//   平台是单文件 SQLite, 无 Redis 依赖(E2 复核已确认)。SQLite 的 `UPDATE ... WHERE version=?`
//   本身就是单语句原子操作(影响行=0/1), 等价于乐观锁, 无需引入新中间件。
//
// 语义约定:
//   leaseExpiresAt == NULL  -> 无租约(改动前的历史数据), 不视为过期, 沿用旧口径(updatedAt 超时回收)
//   leaseExpiresAt <  now   -> 租约到期, 可被回收/接管; 租约内他人不得抢占
//   所有归属变化(认领/续约/释放/接管/完成/超时回收)都必须:
//     1) 带 version CAS, 影响行=0 即"归属已变/发生竞争"(禁止无条件写)
//     2) 落一条 TaskStateTransition, metadata 含 {beforeOwner, afterOwner, actor, reason}(对称审计)
import { prisma } from "@/lib/prisma";

export const DEFAULT_LEASE_MS = Number(process.env.TASK_LEASE_MS || 30 * 60_000);   // 默认 30min
export const MAX_LEASE_MS = Number(process.env.TASK_LEASE_MAX_MS || 4 * 3600_000);  // 上限 4h(防无限续约霸占)
// 2026-09-15 机制修复(task-churn): 反复"认领->放回"空转的根因是释放侧无退避/隔离。
//   retryCount 复用为"放回次数"计数; 达到此阈值时不再放回 PENDING, 而是隔离为 BLOCKED + manualReview=true,
//   从根上切断空转(避免"只把任务放回队列就算处理")。阈值可被 TASK_QUARANTINE_AFTER_RELEASES 覆盖。
export const QUARANTINE_AFTER_RELEASES = Math.max(1, Number(process.env.TASK_QUARANTINE_AFTER_RELEASES ?? 2));

// ── 2026-10-23 P1/P2（消费端提效）─────────────────────────────────────────────
// P1 活动续期：租约到期但任务在最近 N 毫秒内仍有活动(updatedAt 被写)时，续租而不是回收。
//   依据：P0 归因显示 50.8% 的放回是 lease TTL，而 agent 根本不发心跳 —— "干得久"被当成"失联"。
//   默认 0 = 关闭（额度恢复后小流量验证再开）。
export const ACTIVITY_GRACE_MS = Math.max(0, Number(process.env.TASK_LEASE_ACTIVITY_GRACE_MS ?? 0));
// P2 外部故障豁免：执行体通道故障（hermes 400 / openclaw 超时 / 空输出 / 连接错误）不是 agent 的失败，
//   放回时不消耗 quarantine 次数，避免把"平台故障"记成"agent 质量差"。
//   默认 1 = 开启（低风险，且不依赖额度）。
export const EXTERNAL_FAULT_EXEMPT = String(process.env.TASK_LEASE_EXTERNAL_FAULT_EXEMPT ?? "1") !== "0";
// 2026-10-25 实测教训：外部故障不计数之后，同一批任务被 12 个任务反复认领 1,316 次（churn 109）。
//   原因是"释放回队列"没有冷却 —— 通道坏的瞬间，agent 会立刻再领同一条。
//   修法：外部故障释放时给任务一个冷却窗口（写 leaseExpiresAt，PENDING 状态下它也当"冷却到"用）。
export const EXTERNAL_FAULT_BACKOFF_MS = Math.max(0, Number(process.env.TASK_EXTERNAL_FAULT_BACKOFF_MS ?? 10 * 60_000));
const EXTERNAL_FAULT_RE = /大脑通道不可用|hermes\s+(run failed|超时)|openclaw\s*超时|执行体空输出|rc=1|ECONNREFUSED|ETIMEDOUT|TRANSPORT|socket hang up|Error code:\s*(400|429|500|502|503)/i;
export function isExternalFaultReason(reason?: string | null): boolean {
  return EXTERNAL_FAULT_RE.test(String(reason || ""));
}

/** 认领时的默认租约：机制修复类任务比交互类任务耗时长，给更长 TTL（可被 leaseMs 显式覆盖）。 */
export function defaultLeaseMsFor(improvementType?: string | null): number {
  const t = String(improvementType || "");
  const mechanism = t === "GOAL_GAP" || t === "THEME_IMPROVE" || t === "RE_RUN" || t === "FIX_CONFLICT";
  return mechanism ? Math.max(DEFAULT_LEASE_MS, 90 * 60_000) : DEFAULT_LEASE_MS;
}

export type LeaseRow = {
  id: string;
  status: string;
  assignedAgent: string | null;
  expectedOwner: string | null;
  leaseExpiresAt: number | null;
  version: number;
  updatedAt: number | null;
  retryCount: number;
  maxRetries: number;
  manualReview: boolean;
};

export function clampLeaseMs(ms?: number | null): number {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LEASE_MS;
  return Math.min(MAX_LEASE_MS, Math.max(5_000, Math.floor(n)));
}

/** 读一条任务的租约视图(全部用原始 SQL, 兼容未重新生成 Prisma client 的进程)。 */
export async function getLease(taskId: string): Promise<LeaseRow | null> {
  const rows = (await prisma.$queryRawUnsafe(
    'SELECT id, status, assignedAgent, expectedOwner, leaseExpiresAt, version, updatedAt, retryCount, maxRetries, manualReview FROM "Task" WHERE id=? LIMIT 1',
    taskId
  ).catch(() => [])) as any[];
  const r = rows?.[0];
  if (!r) return null;
  return {
    id: String(r.id),
    status: String(r.status),
    assignedAgent: r.assignedAgent == null ? null : String(r.assignedAgent),
    expectedOwner: r.expectedOwner == null ? null : String(r.expectedOwner),
    leaseExpiresAt: r.leaseExpiresAt == null ? null : Number(r.leaseExpiresAt),
    version: Number(r.version ?? 0),
    updatedAt: r.updatedAt == null ? null : Number(r.updatedAt),
    retryCount: Number(r.retryCount ?? 0),
    maxRetries: Number(r.maxRetries ?? 3),
    manualReview: !!r.manualReview,
  };
}

/** 是否持有"活"租约。无租约(NULL)不算活。 */
export function leaseActive(row: Pick<LeaseRow, "leaseExpiresAt">, now: number = Date.now()): boolean {
  return row.leaseExpiresAt != null && row.leaseExpiresAt >= now;
}

/** 租约是否已到期。NULL(无租约)= false(不判过期, 兼容旧数据)。 */
export function leaseExpired(row: Pick<LeaseRow, "leaseExpiresAt">, now: number = Date.now()): boolean {
  return row.leaseExpiresAt != null && row.leaseExpiresAt < now;
}

/**
 * 写一条"归属变化"审计。对称含义: 认领/续约/释放/接管/完成 全部走同一入口,
 * 且 metadata 同时带 beforeOwner 与 afterOwner —— 复核复测6 指出的"认领可审计、释放不可审计"
 * 正是因为释放路径绕过了 TaskStateTransition。
 */
export async function recordOwnershipChange(opts: {
  taskId: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  reason: string;
  beforeOwner: string | null;
  afterOwner: string | null;
  beforeVersion?: number;
  afterVersion?: number;
  extra?: Record<string, unknown>;
}): Promise<void> {
  const metadata = JSON.stringify({
    beforeOwner: opts.beforeOwner,
    afterOwner: opts.afterOwner,
    beforeVersion: opts.beforeVersion ?? null,
    afterVersion: opts.afterVersion ?? null,
    ...(opts.extra || {}),
  });
  await prisma.taskStateTransition.create({
    data: {
      taskId: opts.taskId,
      fromStatus: opts.fromStatus,
      toStatus: opts.toStatus,
      actor: opts.actor,
      reason: opts.reason.slice(0, 240),
      metadata: metadata.slice(0, 1000),
    },
  }).catch(() => null);
}

/**
 * 认领(或接管)一条任务: 单语句 version CAS + 写租约 + 写归属断言。
 * @returns { ok:true, version } 成功; { ok:false, reason } 竞争失败/条件不满足
 */
export async function claimWithLease(opts: {
  taskId: string;
  agentId: string;
  expectedVersion: number;
  /** 接管时要求 = 当前 assignedAgent; 普通认领传 null(表示"必须无主") */
  expectedOwner?: string | null;
  leaseMs?: number;
  actor?: string;
  reason?: string;
  takeover?: boolean;
}): Promise<{ ok: boolean; version?: number; reason?: string; affected?: number }> {
  const now = Date.now();
  const lease = now + clampLeaseMs(opts.leaseMs);
  const before = await getLease(opts.taskId);
  if (!before) return { ok: false, reason: "NOT_FOUND" };

  let affected: number;
  if (opts.takeover) {
    // 接管: 显式 expectedOwner = 当前归属, 且必须与库中一致, 且租约已到期(或当前无主)
    if (!opts.expectedOwner || before.assignedAgent !== opts.expectedOwner) {
      return { ok: false, reason: "EXPECTED_OWNER_MISMATCH", affected: 0 };
    }
    affected = await prisma.$executeRawUnsafe(
      "UPDATE \"Task\" SET status='IN_PROGRESS', assignedAgent=?, expectedOwner=?, leaseExpiresAt=?, version=version+1, updatedAt=? " +
      "WHERE id=? AND status='IN_PROGRESS' AND assignedAgent=? AND version=? AND (leaseExpiresAt IS NULL OR leaseExpiresAt < ?)",
      opts.agentId, opts.agentId, lease, now, opts.taskId, opts.expectedOwner, opts.expectedVersion, now
    );
  } else {
    // 普通认领: 必须 PENDING 且"无主或已定向给本人"(与 claim/claim-by-id 的候选条件同口径 ——
    //   定向任务 assignedAgent 已等于本人, 不能因此认领失败), 且 version 未变。
    affected = await prisma.$executeRawUnsafe(
      "UPDATE \"Task\" SET status='IN_PROGRESS', assignedAgent=?, expectedOwner=?, leaseExpiresAt=?, version=version+1, updatedAt=? " +
      "WHERE id=? AND status='PENDING' AND (assignedAgent IS NULL OR assignedAgent='' OR assignedAgent=?) " +
      "AND (expectedOwner IS NULL OR expectedOwner=?) AND version=?",
      opts.agentId, opts.agentId, lease, now, opts.taskId, opts.agentId, opts.agentId, opts.expectedVersion
    );
  }
  if (affected !== 1) {
    const after = await getLease(opts.taskId);
    return {
      ok: false,
      reason: `CAS_LOST(expectedVersion=${opts.expectedVersion}, actualVersion=${after?.version ?? "-"}, actualOwner=${after?.assignedAgent ?? "-"})`,
      affected,
      version: after?.version,
    };
  }
  await recordOwnershipChange({
    taskId: opts.taskId,
    fromStatus: before.status,
    toStatus: "IN_PROGRESS",
    actor: opts.actor || ("agent:" + opts.agentId),
    reason: opts.reason || (opts.takeover
      ? `接管(takeover): 原归属 ${opts.expectedOwner} 租约到期, 显式移交 -> ${opts.agentId}`
      : `认领(claim): 无主 -> ${opts.agentId}, 租约 ${new Date(lease).toISOString()}`),
    beforeOwner: before.assignedAgent,
    afterOwner: opts.agentId,
    beforeVersion: before.version,
    afterVersion: before.version + 1,
    extra: { leaseExpiresAt: lease, takeover: !!opts.takeover, expectedOwner: opts.expectedOwner ?? null },
  });
  return { ok: true, version: before.version + 1, affected };
}

/** 续约(heartbeat): 仅当前持有者可续; CAS on version + assignedAgent。 */
export async function renewLease(opts: {
  taskId: string;
  agentId: string;
  expectedVersion?: number;
  extendMs?: number;
}): Promise<{ ok: boolean; reason?: string; leaseExpiresAt?: number; version?: number }> {
  const now = Date.now();
  const before = await getLease(opts.taskId);
  if (!before) return { ok: false, reason: "NOT_FOUND" };
  if (before.status !== "IN_PROGRESS") return { ok: false, reason: "NOT_IN_PROGRESS" };
  if (before.assignedAgent !== opts.agentId) return { ok: false, reason: "NOT_LEASE_HOLDER" };
  if (before.leaseExpiresAt != null && before.leaseExpiresAt < now) {
    return { ok: false, reason: "LEASE_EXPIRED", leaseExpiresAt: before.leaseExpiresAt };
  }
  const expectedVersion = opts.expectedVersion == null ? before.version : Number(opts.expectedVersion);
  const lease = now + clampLeaseMs(opts.extendMs);
  const affected = await prisma.$executeRawUnsafe(
    "UPDATE \"Task\" SET leaseExpiresAt=?, expectedOwner=?, version=version+1, updatedAt=? " +
    "WHERE id=? AND status='IN_PROGRESS' AND assignedAgent=? AND version=? AND (leaseExpiresAt IS NULL OR leaseExpiresAt >= ?)",
    lease, opts.agentId, now, opts.taskId, opts.agentId, expectedVersion, now
  );
  if (affected !== 1) return { ok: false, reason: "CAS_LOST" };
  await recordOwnershipChange({
    taskId: opts.taskId, fromStatus: "IN_PROGRESS", toStatus: "IN_PROGRESS",
    actor: "agent:" + opts.agentId,
    reason: `续约(heartbeat): ${opts.agentId} 租约延至 ${new Date(lease).toISOString()}`,
    beforeOwner: before.assignedAgent, afterOwner: opts.agentId,
    beforeVersion: before.version, afterVersion: before.version + 1,
    extra: { leaseExpiresAt: lease, heartbeat: true },
  });
  return { ok: true, leaseExpiresAt: lease, version: before.version + 1 };
}

/** 释放/接管 的显式归属切换: release(自己放弃) 或 takeover(抢到期租约)。 */
export async function releaseOrTakeover(opts: {
  taskId: string;
  agentId: string;
  expectedOwner?: string | null;
  reason?: string;
  takeover?: boolean;
  leaseMs?: number;
}): Promise<{ ok: boolean; reason?: string; freed?: boolean; newVersion?: number; leaseExpiresAt?: number | null; quarantined?: boolean }> {
  const now = Date.now();
  const before = await getLease(opts.taskId);
  if (!before) return { ok: false, reason: "NOT_FOUND" };
  if (before.status !== "IN_PROGRESS") return { ok: false, reason: "NOT_IN_PROGRESS" };

  if (opts.takeover) {
    // 接管他人: expectedOwner 必须等于库中当前归属(防误抢), 且租约必须已到期
    if (!opts.expectedOwner || before.assignedAgent !== opts.expectedOwner) return { ok: false, reason: "EXPECTED_OWNER_MISMATCH" };
    if (!leaseExpired(before, now)) return { ok: false, reason: "LEASE_STILL_ACTIVE", leaseExpiresAt: before.leaseExpiresAt };
    const lease = now + clampLeaseMs(opts.leaseMs);
    const affected = await prisma.$executeRawUnsafe(
      "UPDATE \"Task\" SET assignedAgent=?, expectedOwner=?, leaseExpiresAt=?, version=version+1, updatedAt=? " +
      "WHERE id=? AND status='IN_PROGRESS' AND assignedAgent=? AND version=? AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt < ?",
      opts.agentId, opts.agentId, lease, now, opts.taskId, opts.expectedOwner, before.version, now
    );
    if (affected !== 1) return { ok: false, reason: "CAS_LOST" };
    await recordOwnershipChange({
      taskId: opts.taskId, fromStatus: "IN_PROGRESS", toStatus: "IN_PROGRESS",
      actor: "agent:" + opts.agentId,
      reason: opts.reason || `接管(takeover): ${before.assignedAgent} 租约到期 -> ${opts.agentId}`,
      beforeOwner: before.assignedAgent, afterOwner: opts.agentId,
      beforeVersion: before.version, afterVersion: before.version + 1,
      extra: { leaseExpiresAt: lease, takeover: true },
    });
    return { ok: true, freed: false, newVersion: before.version + 1 };
  }

  // 释放: 只能释放自己持有的; 或调用方显式声明 expectedOwner 与库一致(幂等确认)
  const owner = opts.expectedOwner || opts.agentId;
  if (before.assignedAgent !== owner) return { ok: false, reason: "NOT_LEASE_HOLDER:" + (before.assignedAgent ?? "-") };
  // 2026-09-15 机制修复(task-churn 空转): 放回次数达阈值即隔离(BLOCKED + manualReview), 不再放回公开队列。
  // 2026-10-23 P2: 外部通道故障不计入放回次数（平台故障 ≠ agent 失败），也不触发隔离。
  const externalFault = EXTERNAL_FAULT_EXEMPT && isExternalFaultReason(opts.reason);
  const newRetry = externalFault ? before.retryCount : before.retryCount + 1;
  const quarantine = !externalFault && newRetry >= QUARANTINE_AFTER_RELEASES;
  const targetStatus = quarantine ? "BLOCKED" : "PENDING";
  const setManual = quarantine ? ", manualReview=true " : "";
  // 外部故障：不清空 leaseExpiresAt，而是写成"冷却到"，配合认领侧过滤避免瞬间重领。
  const cooldownUntil = externalFault ? now + EXTERNAL_FAULT_BACKOFF_MS : null;
  const affected = await prisma.$executeRawUnsafe(
    "UPDATE \"Task\" SET status=?, assignedAgent=NULL, expectedOwner=NULL, leaseExpiresAt=?, retryCount=?, version=version+1, updatedAt=? " + setManual +
    "WHERE id=? AND status='IN_PROGRESS' AND assignedAgent=? AND version=?",
    targetStatus, cooldownUntil, newRetry, now, opts.taskId, owner, before.version
  );
  if (affected !== 1) return { ok: false, reason: "CAS_LOST" };
  await recordOwnershipChange({
    taskId: opts.taskId, fromStatus: "IN_PROGRESS", toStatus: targetStatus,
    actor: "agent:" + opts.agentId,
    reason: quarantine
      ? `第${newRetry}次放回, 达隔离阈值(${QUARANTINE_AFTER_RELEASES}): 隔离待人工复核(原释放原因: ${opts.reason || "主动归还"})`
      : (externalFault
        ? `[external-fault] 外部通道故障放回(不计放回次数, retryCount=${newRetry}): ${opts.reason || "-"}`
        : (opts.reason || `释放(release): ${owner} 主动归还公开队列`)),
    beforeOwner: before.assignedAgent, afterOwner: null,
    beforeVersion: before.version, afterVersion: before.version + 1,
    extra: { releasedBy: opts.agentId, retryCount: newRetry, quarantined: quarantine, externalFault },
  });
  return { ok: true, freed: true, newVersion: before.version + 1, quarantined: quarantine };
}

/**
 * 回收器专用: 把"租约到期"或"历史无租约且超时"的 IN_PROGRESS 释放回 PENDING,
 * 并逐条写对称审计(before/after owner)。返回回收条数明细。
 */
export async function recycleExpiredLeases(opts?: { timeoutMs?: number; limit?: number }): Promise<Array<{ id: string; beforeOwner: string | null; via: string; version: number; quarantined?: boolean }>> {
  const now = Date.now();
  const legacyMs = Number(opts?.timeoutMs ?? 30 * 60_000);
  const limit = Math.max(1, Number(opts?.limit ?? 200));
  const rows = (await prisma.$queryRawUnsafe(
    'SELECT id, assignedAgent, expectedOwner, version, leaseExpiresAt, updatedAt, retryCount, maxRetries FROM "Task" ' +
    "WHERE status='IN_PROGRESS' AND (" +
    "  (leaseExpiresAt IS NOT NULL AND leaseExpiresAt < ?) OR " +
    "  (leaseExpiresAt IS NULL AND updatedAt < ?)" +
    ") LIMIT " + limit,
    now, now - legacyMs
  ).catch(() => [])) as any[];
  const done: Array<{ id: string; beforeOwner: string | null; via: string; version: number; quarantined?: boolean }> = [];
  for (const r of rows || []) {
    // 2026-10-23 P1: 到期但最近仍有活动 -> 续租，不回收（默认关闭，见 ACTIVITY_GRACE_MS）
    if (ACTIVITY_GRACE_MS > 0 && r.updatedAt != null && Number(r.updatedAt) > now - ACTIVITY_GRACE_MS) {
      const lease = now + DEFAULT_LEASE_MS;
      const renewed = await prisma.$executeRawUnsafe(
        "UPDATE \"Task\" SET leaseExpiresAt=?, version=version+1 WHERE id=? AND status='IN_PROGRESS' AND version=?",
        lease, String(r.id), Number(r.version ?? 0)
      ).catch(() => 0);
      if (renewed === 1) {
        const bo = r.assignedAgent == null ? null : String(r.assignedAgent);
        await recordOwnershipChange({
          taskId: String(r.id), fromStatus: "IN_PROGRESS", toStatus: "IN_PROGRESS",
          actor: "system:claim-recycler",
          reason: `租约按活动续期(最近 ${Math.round(ACTIVITY_GRACE_MS / 60000)} 分钟内有写): 归属 ${bo || "-"} 保留到 ${new Date(lease).toISOString()}`,
          beforeOwner: bo, afterOwner: bo,
          beforeVersion: Number(r.version ?? 0), afterVersion: Number(r.version ?? 0) + 1,
          extra: { renewedBy: "activity", leaseExpiresAt: lease },
        });
        done.push({ id: String(r.id), beforeOwner: bo, via: "renewed_by_activity", version: Number(r.version ?? 0) + 1 });
        continue;
      }
    }
    const via = r.leaseExpiresAt != null ? "lease_expired" : "legacy_timeout";
    const beforeOwner = r.assignedAgent == null ? null : String(r.assignedAgent);
    const retryCount = Number(r.retryCount ?? 0);
    const newRetry = retryCount + 1;
    const quarantine = newRetry >= QUARANTINE_AFTER_RELEASES;
    const targetStatus = quarantine ? "BLOCKED" : "PENDING";
    const setManual = quarantine ? ", manualReview=true " : "";
    const affected = await prisma.$executeRawUnsafe(
      "UPDATE \"Task\" SET status=?, assignedAgent=NULL, expectedOwner=NULL, leaseExpiresAt=NULL, retryCount=?, version=version+1, updatedAt=? " + setManual +
      "WHERE id=? AND status='IN_PROGRESS' AND version=? AND (" +
      "  (leaseExpiresAt IS NOT NULL AND leaseExpiresAt < ?) OR (leaseExpiresAt IS NULL AND updatedAt < ?))",
      targetStatus, newRetry, now, String(r.id), Number(r.version ?? 0), now, now - legacyMs
    );
    if (affected !== 1) continue;
    await recordOwnershipChange({
      taskId: String(r.id), fromStatus: "IN_PROGRESS", toStatus: targetStatus,
      actor: "system:claim-recycler",
      reason: quarantine
        ? `第${newRetry}次放回(回收), 达隔离阈值(${QUARANTINE_AFTER_RELEASES}): 隔离待人工复核(原回收途径: ${via})`
        : (via === "lease_expired"
          ? `租约到期回收(lease TTL): 释放归属 ${beforeOwner || "-"} 回公开队列`
          : `超时回收(>${Math.round(legacyMs / 60000)}min 未更新, 历史无租约): 释放归属 ${beforeOwner || "-"}`),
      beforeOwner, afterOwner: null,
      beforeVersion: Number(r.version ?? 0), afterVersion: Number(r.version ?? 0) + 1,
      extra: { via, leaseExpiresAt: r.leaseExpiresAt ?? null, retryCount: newRetry, quarantined: quarantine },
    });
    done.push({ id: String(r.id), beforeOwner, via, version: Number(r.version ?? 0) + 1, quarantined: quarantine });
  }
  return done;
}
