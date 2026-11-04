/**
 * 2026-06-26 P0-A: Dead Letter Queue Router (V1.1 §16.10/§21.4 + §18.7 SLO)
 *
 * 设计目标:
 *   - 所有投递/重试失败的消息或事件落库, 给 ops 排障 + SLO "DLQ 堆积 <100" 告警
 *   - 来源: HOOK_DELIVERY / REPLY_META / PIPELINE_SCAN / SESSION_SYNC / MCP_SEND / CUSTOM
 *
 * 端点:
 *   - dlq.enqueue    (protected): agent/服务端写入失败事件
 *   - dlq.list       (public):    dashboard 查看
 *   - dlq.stats      (public):    SLO 监控 (按 source/status 聚合)
 *   - dlq.resolve    (protected): ops 标记处理完成
 *   - dlq.retry      (protected): bump retry_count + 状态置 RETRYING (业务层负责真正重试)
 *
 * 鉴权:
 *   - enqueue / resolve / retry: protectedProcedure (apiKey)
 *   - list / stats: publicProcedure (dashboard 可读)
 */

import { z } from "zod";
import { createRouter, publicProcedure, protectedProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";

// ─── Constants ────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64KB
const MAX_ERROR_BYTES = 4 * 1024; // 4KB

const SourceEnum = z.enum([
  "HOOK_DELIVERY",
  "REPLY_META",
  "PIPELINE_SCAN",
  "SESSION_SYNC",
  "MCP_SEND",
  "CUSTOM",
]);

const ReasonEnum = z.enum([
  "TIMEOUT",
  "5XX",
  "VALIDATION",
  "DEAD_LETTER",
  "CIRCUIT_BREAKER",
  "UNKNOWN",
]);

const StatusEnum = z.enum(["OPEN", "RETRYING", "RESOLVED", "EXPIRED", "IGNORED"]);

// ─── Router ────────────────────────────────────────────────────

export const dlqRouter = createRouter({
  /**
   * dlq.enqueue — agent/服务端写入一条投递失败事件
   */
  enqueue: protectedProcedure
    .input(
      z.object({
        source: SourceEnum,
        ref_id: z.string().optional(),
        agent_id: z.string().optional(),
        reason: ReasonEnum.default("UNKNOWN"),
        error_message: z.string().optional(),
        payload: z.string().optional(),
        max_retries: z.number().int().min(0).max(20).default(3),
      })
    )
    .mutation(async ({ input }) => {
      const errorMessage =
        input.error_message && input.error_message.length > MAX_ERROR_BYTES
          ? input.error_message.slice(0, MAX_ERROR_BYTES) + "...[truncated]"
          : input.error_message;
      const payload =
        input.payload && input.payload.length > MAX_PAYLOAD_BYTES
          ? input.payload.slice(0, MAX_PAYLOAD_BYTES) + "...[truncated]"
          : input.payload;

      const row = await prisma.deadLetterQueue.create({
        data: {
          source: input.source,
          ref_id: input.ref_id ?? null,
          agent_id: input.agent_id ?? null,
          reason: input.reason,
          error_message: errorMessage ?? null,
          payload: payload ?? null,
          max_retries: input.max_retries,
        },
      });
      return { id: row.id, status: row.status };
    }),

  /**
   * dlq.list — 分页查 DLQ 条目
   */
  list: publicProcedure
    .input(
      z.object({
        source: SourceEnum.optional(),
        status: StatusEnum.optional(),
        agent_id: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const where: Record<string, unknown> = {};
      if (input.source) where.source = input.source;
      if (input.status) where.status = input.status;
      if (input.agent_id) where.agent_id = input.agent_id;

      const [items, total] = await Promise.all([
        prisma.deadLetterQueue.findMany({
          where,
          orderBy: { created_at: "desc" },
          take: input.limit,
          skip: input.offset,
        }),
        prisma.deadLetterQueue.count({ where }),
      ]);

      return { items, total, limit: input.limit, offset: input.offset };
    }),

  /**
   * dlq.stats — SLO 监控聚合
   * 输出: 总 OPEN 数 + 按 source 分布 + 按 status 分布
   * SLO 阈值: open_total < 100 (warning >50, critical >100)
   */
  stats: publicProcedure.query(async () => {
    const SLO_WARNING = 50;
    const SLO_CRITICAL = 100;

    const [bySource, byStatus, openTotal, total24h] = await Promise.all([
      prisma.deadLetterQueue.groupBy({
        by: ["source", "status"],
        _count: { _all: true },
      }),
      prisma.deadLetterQueue.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      prisma.deadLetterQueue.count({ where: { status: "OPEN" } }),
      prisma.deadLetterQueue.count({
        where: {
          created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    let sloLevel: "ok" | "warning" | "critical" = "ok";
    if (openTotal >= SLO_CRITICAL) sloLevel = "critical";
    else if (openTotal >= SLO_WARNING) sloLevel = "warning";

    return {
      open_total: openTotal,
      total_24h: total24h,
      by_source: bySource.map((g: { source: string; status: string; _count: { _all: number } }) => ({
        source: g.source,
        status: g.status,
        count: g._count._all,
      })),
      by_status: byStatus.map((g: { status: string; _count: { _all: number } }) => ({
        status: g.status,
        count: g._count._all,
      })),
      slo: {
        level: sloLevel,
        threshold_warning: SLO_WARNING,
        threshold_critical: SLO_CRITICAL,
        target: "open_total < 100",
      },
    };
  }),

  /**
   * dlq.resolve — ops 标记 DLQ 条目处理完成
   */
  resolve: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        resolution: z.string().min(1),
        resolved_by: z.string().default("ops"),
      })
    )
    .mutation(async ({ input }) => {
      const row = await prisma.deadLetterQueue.update({
        where: { id: input.id },
        data: {
          status: "RESOLVED",
          resolved_at: new Date(),
          resolved_by: input.resolved_by,
          resolution: input.resolution,
        },
      });
      return { id: row.id, status: row.status };
    }),

  /**
   * dlq.retry — bump retry_count, 状态置 RETRYING (业务层负责真正重试)
   * 达到 max_retries 后置 EXPIRED
   */
  retry: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const cur = await prisma.deadLetterQueue.findUnique({
        where: { id: input.id },
      });
      if (!cur) throw new Error("DLQ entry not found");

      const next = cur.retry_count + 1;
      const newStatus = next >= cur.max_retries ? "EXPIRED" : "RETRYING";

      const row = await prisma.deadLetterQueue.update({
        where: { id: input.id },
        data: { retry_count: next, status: newStatus },
      });
      return { id: row.id, status: row.status, retry_count: row.retry_count };
    }),
});
