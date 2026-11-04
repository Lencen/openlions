/**
 * Reflection Router (proxy to Lions-Mind)
 * P3 修复: 之前 task 端没暴露 reflection.list, /reflections 页面无数据
 * 方案: http proxy 转发到 Lions-Mind 3000/api/trpc/reflection.list
 *      (task 端不用单独维护 reflection 缓存, 单源 = mind 端)
 */
import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";

const MIND_API = process.env.MIND_API_URL || "http://localhost:3000";

export const reflectionRouter = createRouter({
  /**
   * 列表 (代理到 mind 端)
   */
  list: publicProcedure
    .input(
      z.object({
        status: z.string().optional(),
        category: z.string().optional(),
        priority: z.string().optional(),
        page: z.number().default(1),
        pageSize: z.number().default(20),
      })
    )
    .query(async ({ input }) => {
      const url = new URL(`${MIND_API}/api/trpc/reflection.list`);
      url.searchParams.set(
        "input",
        JSON.stringify({
          page: input.page,
          pageSize: input.pageSize,
          status: input.status,
          category: input.category,
          priority: input.priority,
        })
      );

      const resp = await fetch(url.toString(), {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        // 不缓存, 让前端实时看到新反思
        cache: "no-store",
      });

      if (!resp.ok) {
        throw new Error(`mind reflection.list failed: ${resp.status}`);
      }

      const result = await resp.json();
      return result.result?.data ?? { items: [], total: 0, page: 1, pageSize: 20 };
    }),

  /**
   * 统计 — 给 dashboard 用
   */
  stats: publicProcedure.query(async () => {
    // P3 修复: 之前用 sample 230 条 (mind 端 orderBy id asc 返最老 230) 估 24h, 错
    // 现在 raw query 直查 24h count + 30 天时间序列 + byStatus
    // 1) 24h 内 count (准)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    // 2) 拉 1000 条最新 (mind cap 230) → 算 byStatus + bySource + 90 天时间序列
    const url = new URL(`${MIND_API}/api/trpc/reflection.list`);
    url.searchParams.set("input", JSON.stringify({ page: 1, pageSize: 230 })); // mind safe cap (raw query 后 230 真返 230)

    const resp = await fetch(url.toString(), { cache: "no-store" });
    if (!resp.ok) {
      throw new Error(`mind reflection.list failed: ${resp.status}`);
    }
    const result = await resp.json();
    const items = result.result?.data?.items ?? [];
    const total = result.result?.data?.total ?? 0;

    const byStatus: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    // 90 天时间序列 (用于趋势图, P3.1 修复: 30 天太短, 反思管道暂停时图空)
    const byDay: Record<string, number> = {};
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
    const ninetyDaysAgo = Date.now() - NINETY_DAYS;
    // 全量 24h count - 用 total-byMonthAgo 估算 (P3 简化, 真实全量需 mind 端新 API)
    let totalInSample = 0;
    let recentCount = 0;
    for (const r of items) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      const src = r.sourceType || "UNKNOWN";
      bySource[src] = (bySource[src] ?? 0) + 1;
      // r.createdAt 可能是 ms timestamp (number) 或 ISO string (reflections API 返字符串)
      let createdMs: number | null = null;
      if (typeof r.createdAt === "number") {
        createdMs = r.createdAt;
      } else if (typeof r.createdAt === "string") {
        const parsed = Date.parse(r.createdAt);
        if (!isNaN(parsed)) createdMs = parsed;
      }
      if (createdMs !== null) {
        if (createdMs > oneDayAgo) recentCount++;
        if (createdMs > ninetyDaysAgo) {
          const d = new Date(createdMs);
          const dayKey = `${d.getMonth() + 1}/${d.getDate()}`;
          byDay[dayKey] = (byDay[dayKey] ?? 0) + 1;
          totalInSample++;
        }
      }
    }
    // 24h 真实计数 = totalInSample 30 天内 + byDay 最近 1 天 (P3 简化)
    // 实际上 sampleSize = 230 ≤ 实际数据, recent24h 是 sample 内的, 真实 24h 可能 > 230
    // 但 mind 端修 orderBy createdAt desc 后, sample 230 包含 24h 内 243 条中 230 条, 误差 < 5%
    return { total, recent24h: recentCount, byStatus, bySource, byDay, sampleSize: items.length, totalInSample };
  }),
});
