import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";

export const portfolioRouter = createRouter({
  list: publicProcedure.input(z.object({
    type: z.string().optional(),
    quality: z.string().optional(),
    project: z.string().optional(),
    page: z.number().default(1),
    pageSize: z.number().default(20),
  })).query(async ({ input }) => {
    const where: Record<string, unknown> = {};
    if (input.type) where.type = input.type;
    if (input.quality) where.quality = input.quality;
    if (input.project) where.projectId = input.project;

    const [items, total] = await Promise.all([
      prisma.output.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      prisma.output.count({ where }),
    ]);

    return { items, total, page: input.page, pageSize: input.pageSize };
  }),

  get: publicProcedure.input(z.string()).query(async ({ input }) => {
    return prisma.output.findUnique({
      where: { id: input },
      include: {
        knowledgeLinks: { include: { knowledge: true } },
        practiceLinks: { include: { practice: true } },
        evaluations: true,
      },
    });
  }),

  getQualityTrend: publicProcedure.query(async () => {
    const outputs = await prisma.output.findMany({
      select: { qualityScore: true, createdAt: true, type: true },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return outputs;
  }),

  getHighlights: publicProcedure.query(async () => {
    return prisma.output.findMany({
      where: { quality: { in: ["EXCEPTIONAL", "GOOD"] } },
      orderBy: { qualityScore: "desc" },
      take: 20,
    });
  }),

  create: publicProcedure.input(z.object({
    title: z.string(),
    type: z.string(),
    quality: z.string(),
    qualityScore: z.number().optional(),
    projectId: z.string().optional(),
    gitCommitHash: z.string().optional(),
    linesAdded: z.number().optional(),
    linesRemoved: z.number().optional(),
  })).mutation(async ({ input }) => {
    const output = await prisma.output.create({ data: input });

    await prisma.flywheelEvent.create({
      data: {
        stage: "OUTCOME",
        sourceType: "OUTPUT",
        sourceId: output.id,
        sourceTitle: output.title,
        targetStage: "EVALUATE",
      },
    });

    return output;
  }),
});
