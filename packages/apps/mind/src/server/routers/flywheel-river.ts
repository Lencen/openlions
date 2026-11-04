/**
 * 飞轮 24H 事件流 (Flywheel River)
 *  给 /flywheel 页面用 — 7 彩色轨道横向时间河 + dot 事件 + NOW 游标
 *
 *  返回:
 *  {
 *    buckets: [{ hour: "2026-06-08 14", stage: "LEARN", count: 3 }, ...],
 *    totalEvents: 12317,
 *    last24hEvents: 662,
 *    stageCounts: { LEARN: 22, ... }
 *  }
 *
 *  走 prisma.$queryRawUnsafe(query, ...params) 绕 binary parser bug
 *   (模板字符串插值 prisma 不支持, 用 ? 占位 + spread)
 */

import { z } from "zod";
import { publicProcedure, createRouter } from "../trpc";
import { prisma } from "@/lib/prisma";

const STAGE_ORDER = ["LEARN", "REFLECT", "MEMORIZE", "KNOWLEDGE", "PRACTICE", "OUTCOME", "EVALUATE"] as const;
const HOURS_DEFAULT = 24;

export const flywheelRiverRouter = createRouter({
  /**
   * 飞轮 24H 事件流 — 按时段 (hour) + stage 聚合
   * input: { hours: 24 (默认) / 168 (7D) / 720 (30D) }
   */
  getRiver: publicProcedure
    .input(z.object({ hours: z.number().int().min(1).max(720).default(HOURS_DEFAULT) }).optional())
    .query(async ({ input }) => {
      const hours = input?.hours ?? HOURS_DEFAULT;
      // 截到现在 — FlywheelEvent.createdAt 在 db 里是 unix ms integer (13位),
      //  不能用 ISO 字符串比较 (永远 <, 0 命中 — P2-11 教训)
      const cutoffMs = Date.now() - hours * 3600 * 1000;

      // 按小时 + stage 聚合 (SQLite strftime 截到小时 — 需先 /1000 转秒)
      const buckets = await prisma.$queryRawUnsafe(
        `SELECT
          strftime('%Y-%m-%d %H', createdAt / 1000, 'unixepoch') as hour,
          stage,
          COUNT(*) as count
        FROM FlywheelEvent
        WHERE createdAt >= ?
        GROUP BY hour, stage
        ORDER BY hour ASC`,
        cutoffMs
      ) as Array<{ hour: string; stage: string; count: number | bigint }>;

      // 计算 last24h 总数
      const last24hMs = Date.now() - 24 * 3600 * 1000;
      const last24hRow = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) as c FROM FlywheelEvent WHERE createdAt >= ?`,
        last24hMs
      ) as Array<{ c: number | bigint }>;

      // 全期 stage 计数
      const totalStageRows = await prisma.$queryRawUnsafe(
        `SELECT stage, COUNT(*) as count FROM FlywheelEvent GROUP BY stage`
      ) as Array<{ stage: string; count: number }>;

      // 全期总数
      const totalRow = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) as c FROM FlywheelEvent`
      ) as Array<{ c: number | bigint }>;

      // 拼成 stageCounts, 7 阶段全占位 (没数据补 0)
      // Number() 转 bigint, 避免 superjson 序列化 BigInt 错
      const stageCounts: Record<string, number> = {};
      for (const s of STAGE_ORDER) stageCounts[s] = 0;
      for (const r of totalStageRows) stageCounts[r.stage] = Number(r.count);

      return {
        buckets: buckets.map((b) => ({ hour: b.hour, stage: b.stage, count: Number(b.count) })),
        last24hEvents: Number(last24hRow[0]?.c ?? 0),
        totalEvents: Number(totalRow[0]?.c ?? 0),
        stageCounts,
        hours,
      };
    }),

  /**
   * 7 阶段转化率 — 从 stageCounts 算占比
   * 用于 /flywheel 页面"7 阶段转化"卡片
   */
  getConversion: publicProcedure.query(async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT stage, COUNT(*) as count FROM FlywheelEvent GROUP BY stage ORDER BY count DESC`
    ) as Array<{ stage: string; count: number }>;
    const total = rows.reduce((s, r) => s + Number(r.count), 0);
    return rows.map((r) => ({
      stage: r.stage,
      count: Number(r.count),
      rate: total > 0 ? Math.round((Number(r.count) / total) * 1000) / 10 : 0,
    }));
  }),
});
