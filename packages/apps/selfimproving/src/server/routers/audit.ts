/**
 * Audit Log Router — V2.0
 *
 * 提供审计日志查询端点：
 * - audit.list    : 分页查询所有审计日志
 * - audit.getEntityHistory: 查询指定实体的变更历史
 *
 * 自动记录：所有 mutation 通过中间件或手动调用 recordAuditLog() 写入
 */
import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";

// ─── 便捷写入函数（供其他 router 调用）──────────────────────────
export async function recordAuditLog(params: {
  entityType: string;
  entityId: string;
  action: string;
  actor?: string;
  actorType?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}) {
  return prisma.auditLog.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      actor: params.actor ?? "SYSTEM",
      actorType: params.actorType ?? "SYSTEM",
      before: params.before ? JSON.stringify(params.before) : null,
      after: params.after ? JSON.stringify(params.after) : null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    },
  });
}

// ─── Router ────────────────────────────────────────────────────
export const auditRouter = createRouter({
  /** 分页查询审计日志 */
  list: publicProcedure
    .input(
z.object({
        entityType: z.string().optional(),
        entityId: z.string().optional(),
        action: z.string().optional(),
        actor: z.string().optional(),
        from: z.number().optional(),
        to: z.number().optional(),
        page: z.number().default(1),
        pageSize: z.number().default(50),
      }).default({}),
    )
    .query(async ({ input }) => {
      const where: Record<string, unknown> = {};
      if (input.entityType) where.entityType = input.entityType;
      if (input.entityId) where.entityId = input.entityId;
      if (input.action) where.action = input.action;
      if (input.actor) where.actor = input.actor;

      if (input.from || input.to) {
        where.createdAt = {};
        if (input.from) (where.createdAt as Record<string, unknown>).gte = new Date(input.from);
        if (input.to) (where.createdAt as Record<string, unknown>).lte = new Date(input.to);
      }

      const [items, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        prisma.auditLog.count({ where }),
      ]);

      return { items, total, page: input.page, pageSize: input.pageSize };
    }),

  /** 查询指定实体的变更历史 */
  getEntityHistory: publicProcedure
    .input(
      z.object({
        entityType: z.string(),
        entityId: z.string(),
        page: z.number().default(1),
        pageSize: z.number().default(20),
      })
    )
    .query(async ({ input }) => {
      const [items, total] = await Promise.all([
        prisma.auditLog.findMany({
          where: {
            entityType: input.entityType,
            entityId: input.entityId,
          },
          orderBy: { createdAt: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        prisma.auditLog.count({
          where: { entityType: input.entityType, entityId: input.entityId },
        }),
      ]);

      // 解析 before/after/metadata JSON 字段
      const itemsWithParsed = items.map((item) => ({
        ...item,
        before: item.before ? JSON.parse(item.before) : null,
        after: item.after ? JSON.parse(item.after) : null,
        metadata: item.metadata ? JSON.parse(item.metadata) : null,
      }));

      return { items: itemsWithParsed, total, page: input.page, pageSize: input.pageSize };
    }),
});