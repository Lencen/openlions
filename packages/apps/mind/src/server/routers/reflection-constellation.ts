/**
 * 反思主题星云 (Constellation) + 主题聚合
 *  给 /reflection 页面用 — 主题 SVG 节点 + 漏斗 + KPI
 *
 *  返回:
 *  getConstellation:
 *  {
 *    themes: [{ theme: "数据质量", count: 48, examples: ["cm..."] }, ...],
 *    total: 1199,
 *    totalThemes: 7
 *  }
 *
 *  getStatsByTheme:
 *  [{ theme, total, resolved, avgScore }, ...]
 *
 *  getClosedLoop:
 *  5 段漏斗 [{ stage, label, value, rate }, ...]
 *
 *  走 prisma.$queryRawUnsafe(query, ...params) 绕 binary parser bug
 */

import { z } from "zod";
import { publicProcedure, createRouter } from "../trpc";
import { prisma } from "@/lib/prisma";

const EXCLUDE_TEST = `id NOT LIKE 'cma%' AND id NOT LIKE 'cma000v3%'`;

export const reflectionConstellationRouter = createRouter({
  /**
   * 反思主题星云 — 按 theme 聚合 + 给前 N 个主题附 3 个 example ID
   * 排除测试数据 (cma% / cma000v3%) — 真实生产数据是 cuid cm... 开头
   */
  getConstellation: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(15) }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit ?? 15;

      // 按 theme 聚合 count
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COALESCE(theme, '未分类') as theme, COUNT(*) as count
         FROM Reflection
         WHERE ${EXCLUDE_TEST}
         GROUP BY theme
         ORDER BY count DESC
         LIMIT ?`,
        limit
      ) as Array<{ theme: string; count: number }>;

      // 总数 (同样排除测试)
      const totalRow = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) as c FROM Reflection WHERE ${EXCLUDE_TEST}`
      ) as Array<{ c: number }>;

      // 给每个主题拿前 3 个 example id (cuid 字典序 DESC = 时间倒序)
      const themesWithExamples = await Promise.all(
        rows.map(async (r) => {
          const examples = await prisma.$queryRawUnsafe(
            `SELECT id FROM Reflection
             WHERE theme = ? AND ${EXCLUDE_TEST}
             ORDER BY id DESC LIMIT 3`,
            r.theme
          ) as Array<{ id: string }>;
          return { theme: r.theme, count: Number(r.count), examples: examples.map((e) => e.id) };
        })
      );

      return {
        themes: themesWithExamples,
        total: Number(totalRow[0]?.c ?? 0),
        totalThemes: rows.length,
      };
    }),

  /**
   * 反思主题聚合 KPI — 按 theme 算 resolved / avgScore
   * 用于主题列表的 KPI 行
   */
  getStatsByTheme: publicProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(30) }).optional())
    .query(async ({ input }) => {
      // P3-8 修复: 之前用 createdAt >= cutoffIso 过滤,但 createdAt 字段 integer ms + text ISO 混存
      //   ISO 字符串比较只命中 text 字段 → 实测只返 1 个 theme (未分类 236 = 全 text 行 5/27 的 NULL)
      //   真根因: 跟 P3-8 recent 端点同根因,prisma 的 Date 比较在混存字段上不可靠
      // 修法: 不限 createdAt,直接按 theme 聚合(跟 getConstellation 一致),days 参数被忽略(保留为 no-op 不破坏前端 schema)
      // 排除测试数据规则跟 getConstellation 一致
      void input; // days 参数暂时忽略
      const rows = await prisma.$queryRawUnsafe(
        `SELECT
           COALESCE(theme, '未分类') as theme,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'RESOLVED' THEN 1 ELSE 0 END) as resolved,
           AVG(score) as avgScore
         FROM Reflection
         WHERE ${EXCLUDE_TEST}
         GROUP BY theme
         ORDER BY total DESC
         LIMIT 30`
      ) as Array<{ theme: string; total: number; resolved: number; avgScore: number | null }>;

      return rows.map((r) => ({
        theme: r.theme,
        total: Number(r.total),
        resolved: Number(r.resolved),
        avgScore: r.avgScore !== null ? Math.round(Number(r.avgScore) * 100) / 100 : null,
      }));
    }),

  /**
   * 反思 5 段漏斗 — 1199 → 1199 → 1194 → 70 → 0
   */
  getClosedLoop: publicProcedure.query(async () => {
    // 阶段 1: 反思记录
    const t1 = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as c FROM Reflection WHERE ${EXCLUDE_TEST}`
    ) as Array<{ c: number }>;
    // 阶段 2: 有教训 (lesson 非空)
    const t2 = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as c FROM Reflection
       WHERE ${EXCLUDE_TEST} AND lesson IS NOT NULL AND lesson != ''`
    ) as Array<{ c: number }>;
    // 阶段 3: 有改进措施 (improvements / structuredImprovements / improvementActions 任一非空)
    const t3 = await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT r.id) as c
       FROM Reflection r
       LEFT JOIN ImprovementAction ia ON ia.reflectionId = r.id
       WHERE ${EXCLUDE_TEST.replace(/id/g, "r.id")}
         AND (
           (r.improvements IS NOT NULL AND r.improvements != '')
           OR (r.structuredImprovements IS NOT NULL AND r.structuredImprovements != '')
           OR ia.id IS NOT NULL
         )`
    ) as Array<{ c: number }>;
    // 阶段 4: 已执行 (improvementActions.status = 'completed')
    const t4 = await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT r.id) as c
       FROM Reflection r
       JOIN ImprovementAction ia ON ia.reflectionId = r.id
       WHERE ${EXCLUDE_TEST.replace(/id/g, "r.id")} AND ia.status = 'completed'`
    ) as Array<{ c: number }>;
    // 阶段 5: 有效果反馈 (improvementActions.effect 非空)
    const t5 = await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT r.id) as c
       FROM Reflection r
       JOIN ImprovementAction ia ON ia.reflectionId = r.id
       WHERE ${EXCLUDE_TEST.replace(/id/g, "r.id")} AND ia.effect IS NOT NULL AND ia.effect != ''`
    ) as Array<{ c: number }>;

    const s1 = Number(t1[0]?.c ?? 0);
    const s2 = Number(t2[0]?.c ?? 0);
    const s3 = Number(t3[0]?.c ?? 0);
    const s4 = Number(t4[0]?.c ?? 0);
    const s5 = Number(t5[0]?.c ?? 0);

    return [
      { stage: "REFLECT", label: "反思记录", value: s1, rate: 100 },
      { stage: "LESSON", label: "有教训", value: s2, rate: s1 > 0 ? Math.round((s2 / s1) * 1000) / 10 : 0 },
      { stage: "IMPROVE", label: "有改进措施", value: s3, rate: s1 > 0 ? Math.round((s3 / s1) * 1000) / 10 : 0 },
      { stage: "EXECUTE", label: "已执行", value: s4, rate: s1 > 0 ? Math.round((s4 / s1) * 1000) / 10 : 0 },
      { stage: "EFFECT", label: "有效果反馈", value: s5, rate: s1 > 0 ? Math.round((s5 / s1) * 1000) / 10 : 0 },
    ];
  }),
});
