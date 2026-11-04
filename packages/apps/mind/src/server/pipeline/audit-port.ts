/**
 * audit-port.ts — AuditPort 只读 adapter（2026-10-27）
 *
 * 只实现 query；record 仍走 scripts/lib/audit-log.cjs（五类写点已经统一在那里）。
 * 用于以后换审计存储时，先切读、双跑比对。
 */
import { prisma } from "@/lib/prisma";
import type { AuditPort, AuditRow } from "./ports";

function parse(v: any): unknown {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

export type AuditReadPort = Pick<AuditPort, "query">;

export function createAuditReadPort(): AuditReadPort {
  return {
    async query(f): Promise<AuditRow[]> {
      const where: any = {};
      if (f.entityType) where.entityType = f.entityType;
      if (f.entityId) where.entityId = f.entityId;
      if (f.action) where.action = f.action;
      if (f.actor) where.actor = f.actor;
      const rows = await (prisma as any).auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return rows.map((r: any) => ({
        id: String(r.id),
        entityType: String(r.entityType),
        entityId: String(r.entityId),
        action: String(r.action),
        actor: String(r.actor),
        actorType: r.actorType ?? "system",
        before: parse(r.before),
        after: parse(r.after),
        metadata: parse(r.metadata) as Record<string, unknown> | undefined,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt ?? ""),
      }));
    },
  };
}
