import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { safeCreatePractice } from "../pipeline/safe-create"; // round 57 G3
import { PrismaPracticeStore } from "@lions/modules-practice";
import { isQuickFilter, practiceQuickWhere } from "../lib/cognitive-quick-filter";
import { rangeSince } from "@/lib/range";

const practiceStore = new PrismaPracticeStore(prisma);

export const practiceRouter = createRouter({
  list: publicProcedure.input(z.object({
    type: z.string().optional(),
    outcome: z.string().optional(),
    // Phase 7 (2026-06-24): 加 search 字段供 MCP cognition.search (title/description OR)
    search: z.string().optional(),
    page: z.number().default(1),
    pageSize: z.number().default(20),
    // B18 修复 (2026-06-18 15:25): 前端可调排序
    sortBy: z.enum(["createdAt", "updatedAt", "startedAt", "effectiveness", "name"]).default("updatedAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
    // 2026-09-14 UI-7: 常用快捷筛选 (高质量/近7天/被引用过/待复核)
    quick: z.enum(["highQuality", "recent7d", "referenced", "pendingReview"]).optional(),
    // 2026-10-13 round 76-CK: 顶栏全局时间范围(③)。口径与 quick.recent7d 一致 = **createdAt**。
    range: z.enum(["1h", "24h", "7d", "30d", "all"]).optional(),
  })).query(async ({ input }) => {
    // P1.3 沿用 skills 的做法: 直接 prisma 查询 (占位 store 会丢 sortBy/type/outcome, 且不支持 quick 筛选)
    const where: Record<string, unknown> = {};
    if (input.type) where.type = input.type;
    if (input.outcome) where.outcome = input.outcome;
    if (input.search) where.OR = [
      { title: { contains: input.search } },
      { description: { contains: input.search } },
      { theme: { contains: input.search } },
    ];
    // 2026-09-14 UI-7: 快捷筛选只作用于有效记录 (归档链上的旧记录不进筛选结果)
    if (isQuickFilter(input.quick)) {
      where.supersededBy = null;
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), practiceQuickWhere(input.quick)];
    }
    // 2026-10-13 round 76-CK: opt-in 时间窗(与 quick 是**交集**, 实测不覆盖)。
    const rs = rangeSince(input.range);
    if (rs) (where as any).createdAt = { gte: rs };

    // sortBy 枚举含历史别名 (name/effectiveness 不是 Practice 列) -> 映射到等价列, 避免 Prisma Unknown argument
    const sortCol = input.sortBy === "name" ? "title" : input.sortBy === "effectiveness" ? "qualityScore" : input.sortBy;
    const orderBy: Record<string, string> = { [sortCol]: input.sortOrder };
    const [items, total] = await Promise.all([
      prisma.practice.findMany({
        where,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        orderBy,
      }),
      prisma.practice.count({ where }),
    ]);
    return { items, total, page: input.page, pageSize: input.pageSize };
  }),

  get: publicProcedure.input(z.string()).query(async ({ input }) => {
    return practiceStore.get(input);
  }),

  create: publicProcedure.input(z.preprocess(
    (val) => (val && typeof val === "object" && "json" in val) ? (val as any).json : val,
    z.object({
      title: z.string(),
      description: z.string().optional(),
      type: z.string(),
      outcome: z.string(),
      qualityScore: z.number().optional(),
      difficulty: z.number().optional(),
      duration: z.number().optional(),
      skillIds: z.array(z.string()).optional(),
      knowledgeIds: z.array(z.string()).optional(),
    })
  )).mutation(async ({ input }) => {
    const { skillIds, knowledgeIds, ...data } = input;

    const practice = await safeCreatePractice(prisma, {
      data: {
        ...data,
        startedAt: new Date(),
        skillLinks: skillIds ? { create: skillIds.map((id) => ({ skillId: id })) } : undefined,
        knowledgeLinks: knowledgeIds ? { create: knowledgeIds.map((id) => ({ knowledgeId: id })) } : undefined,
      },
      include: { skillLinks: true, knowledgeLinks: true },
    });
    // 2026-10-09 round 72-I: 认知闸 enforce 档会 return null -> practice.id 抛 TypeError; 显式判空。
    if (!practice || !practice.id) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "认知闸拒收: 实践内容不满足完备性判据(title/outcome/lesson)" });
    }

    await prisma.flywheelEvent.create({
      data: {
        stage: "PRACTICE",
        sourceType: "PRACTICE",
        sourceId: practice.id,
        sourceTitle: practice.title,
        targetStage: "OUTCOME",
      },
    });

    return practice;
  }),

  getKnowledgeUsage: publicProcedure.query(async () => {
    const links = await prisma.practiceKnowledgeLink.findMany({
      include: { knowledge: true, practice: true },
      orderBy: { effectiveness: "desc" },
      take: 20,
    });

    return links.map((l) => ({
      knowledgeId: l.knowledgeId,
      knowledgeTitle: l.knowledge.title,
      usageCount: 1,
      avgEffectiveness: l.effectiveness,
    }));
  }),

  getOutcomeStats: publicProcedure.query(async () => {
    const total = await prisma.practice.count();
    const success = await prisma.practice.count({ where: { outcome: "SUCCESS" } });
    const partial = await prisma.practice.count({ where: { outcome: "PARTIAL" } });
    const failed = await prisma.practice.count({ where: { outcome: "FAILED" } });
    const abandoned = await prisma.practice.count({ where: { outcome: "ABANDONED" } });

    return {
      total,
      success,
      partial,
      failed,
      abandoned,
      successRate: total > 0 ? Math.round((success / total) * 100) : 0,
    };
  }),
});
