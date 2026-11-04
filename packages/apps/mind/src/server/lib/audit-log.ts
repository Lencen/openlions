/**
 * audit-log.ts — AuditLog 写入的单一实现
 *
 * 2026-10-15 round 78：把 agent.ts 的私有 recordAudit 收敛到这里。
 * 2026-10-26 修（真 bug）：AuditLog.createdAt 在 PostgreSQL 里是 timestamp 列，
 *   原实现统一插 Date.now()（毫秒数字）-> 类型不匹配，INSERT 每次失败；而 recordAudit 只 console.error，
 *   于是 PG 迁移后所有审计静默丢失（实测 0 行新审计，日志里反复出现 [audit] write failed）。
 *   SQLite 下仍用整数毫秒（保持原行为），PG 下用 Date。
 */
import { prisma } from "@/lib/prisma";

function auditTs(): any {
  return String(process.env.MIND_DB_DRIVER || "").toLowerCase() === "pg" ? new Date() : Date.now();
}

export async function recordAudit(args: {
  entityType: string;
  entityId: string;
  action: string;
  actor?: string | null;
  actorType?: string | null;
  before?: string | null;
  after?: string | null;
  metadata?: any;
}): Promise<void> {
  try {
    const id = "audit_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
    await prisma.$executeRaw`
      INSERT INTO AuditLog (id, entityType, entityId, action, actor, actorType, before, after, metadata, createdAt)
      VALUES (${id}, ${args.entityType}, ${args.entityId}, ${args.action},
              ${args.actor ?? null}, ${args.actorType ?? null}, ${args.before ?? null},
              ${args.after ?? null},
              ${args.metadata !== undefined && args.metadata !== null ? JSON.stringify(args.metadata) : null},
              ${auditTs()})
    `;
  } catch (e: any) {
    console.error("[audit] write failed:", args.action, args.entityId, e?.message || e);
  }
}
