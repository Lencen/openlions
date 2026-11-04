import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
// 2026-10-08 round 54: category 受控投影
import { projectCategory } from "../pipeline/enum-projection";
import { calcQualityScore } from "../pipeline/db-writer"; // 2026-10-09 round 72-B: 补 qualityScore(棘轮项)
import { safeCreateKnowledge, safeCreateReflection, safeCreateMemory } from "../pipeline/safe-create"; // round 57

export const learningRouter = createRouter({
  listPaths: publicProcedure.input(z.object({
    category: z.string().optional(),
    status: z.string().optional(),
    difficulty: z.string().optional(),
  }).optional()).query(async ({ input }) => {
    return prisma.learningPath.findMany({
      where: input ?? {},
      include: { milestones: { orderBy: { order: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
  }),

  getPath: publicProcedure.input(z.string()).query(async ({ input }) => {
    return prisma.learningPath.findUnique({
      where: { id: input },
      include: {
        milestones: {
          orderBy: { order: "asc" },
          include: {
            learningLogs: { orderBy: { createdAt: "desc" } },
            learningSummary: true,
          },
        },
      },
    });
  }),

  createLog: publicProcedure.input(z.object({
    milestoneId: z.string(),
    type: z.string().default("LEARNING"),
    content: z.string(),
    duration: z.number().optional(),
  })).mutation(async ({ input }) => {
    return prisma.milestoneLog.create({ data: input });
  }),

  createSummary: publicProcedure.input(z.object({
    milestoneId: z.string(),
    learningLog: z.string().optional(),
    practiceSummary: z.string().optional(),
    skillsGained: z.string().optional(), // JSON array string
    toolsMastered: z.string().optional(), // JSON array string
    documents: z.string().optional(), // JSON array string
    demos: z.string().optional(), // JSON array string
  })).mutation(async ({ input }) => {
    const existing = await prisma.learningSummary.findUnique({
      where: { milestoneId: input.milestoneId },
    });
    if (existing) {
      return prisma.learningSummary.update({
        where: { id: existing.id },
        data: input,
      });
    }
    return prisma.learningSummary.create({ data: input });
  }),

  getMilestoneLogs: publicProcedure.input(z.string()).query(async ({ input }) => {
    return prisma.milestoneLog.findMany({
      where: { milestoneId: input },
      orderBy: { createdAt: "desc" },
    });
  }),

  deleteLog: publicProcedure.input(z.string()).mutation(async ({ input }) => {
    return prisma.milestoneLog.delete({ where: { id: input } });
  }),

  updateLog: publicProcedure.input(z.object({
    id: z.string(),
    content: z.string().optional(),
    duration: z.number().optional(),
  })).mutation(async ({ input: { id, ...data } }) => {
    return prisma.milestoneLog.update({ where: { id }, data });
  }),

  createPath: publicProcedure.input(z.object({
    title: z.string(),
    description: z.string().optional(),
    category: z.string().optional(),
    difficulty: z.string().optional(),
    totalHours: z.number().optional(),
  })).mutation(async ({ input }) => {
    return prisma.learningPath.create({ data: input });
  }),

  updatePath: publicProcedure.input(z.object({
    id: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    difficulty: z.string().optional(),
    totalHours: z.number().optional(),
    completedHours: z.number().optional(),
    status: z.string().optional(),
  })).mutation(async ({ input: { id, ...data } }) => {
    return prisma.learningPath.update({ where: { id }, data });
  }),

  deletePath: publicProcedure.input(z.string()).mutation(async ({ input }) => {
    await prisma.milestone.deleteMany({ where: { learningPathId: input } });
    return prisma.learningPath.delete({ where: { id: input } });
  }),

  addMilestone: publicProcedure.input(z.object({
    learningPathId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    order: z.number().optional(),
    reflectionPrompt: z.string().optional(),
    resources: z.string().optional(),
    autoReflect: z.boolean().optional(),
  })).mutation(async ({ input }) => {
    const count = await prisma.milestone.count({
      where: { learningPathId: input.learningPathId },
    });
    return prisma.milestone.create({
      data: {
        ...input,
        order: input.order ?? count + 1,
        autoReflect: input.autoReflect ?? true,
      },
    });
  }),

  updateMilestone: publicProcedure.input(z.object({
    id: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    order: z.number().optional(),
    reflectionPrompt: z.string().optional(),
    resources: z.string().optional(),
    autoReflect: z.boolean().optional(),
    status: z.string().optional(),
  })).mutation(async ({ input: { id, ...data } }) => {
    return prisma.milestone.update({ where: { id }, data });
  }),

  deleteMilestone: publicProcedure.input(z.string()).mutation(async ({ input }) => {
    const ms = await prisma.milestone.findUnique({ where: { id: input } });
    if (!ms) throw new Error("Milestone not found");
    await prisma.milestone.delete({ where: { id: input } });
    if (ms.learningPathId) {
      const remaining = await prisma.milestone.findMany({
        where: { learningPathId: ms.learningPathId },
        orderBy: { order: "asc" },
      });
      for (let i = 0; i < remaining.length; i++) {
        await prisma.milestone.update({
          where: { id: remaining[i].id },
          data: { order: i + 1 },
        });
      }
      const completed = remaining.filter((m) => m.status === "COMPLETED").length;
      const total = remaining.length;
      await prisma.learningPath.update({
        where: { id: ms.learningPathId },
        data: { progress: total > 0 ? completed / total : 0 },
      });
    }
    return { success: true };
  }),

  completeMilestone: publicProcedure.input(z.object({
    milestoneId: z.string(),
  })).mutation(async ({ input }) => {
    const milestone = await prisma.milestone.update({
      where: { id: input.milestoneId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const path = await prisma.learningPath.findUnique({
      where: { id: milestone.learningPathId },
      include: { milestones: true },
    });

    if (path) {
      const completed = path.milestones.filter((m) => m.status === "COMPLETED").length;
      const total = path.milestones.length;
      await prisma.learningPath.update({
        where: { id: path.id },
        data: { progress: total > 0 ? completed / total : 0 },
      });
    }

    if (milestone.autoReflect) {
      await safeCreateReflection(prisma, {
        data: {
          title: `完成 ${milestone.title} 后的反思`,
          description: milestone.reflectionPrompt ?? `完成学习里程碑: ${milestone.title}`,
          milestoneId: milestone.id,
          learningPathId: milestone.learningPathId,
          status: "OPEN",
        },
      });

      // round 57 G4(2026-10-10): 长标题语义已由 round58 裁决为归一 -> 迁 safeCreateMemory.
      const _mem = await safeCreateMemory(prisma, {
        data: {
          content: `完成了学习里程碑: ${milestone.title}`,
          title: milestone.title,
          type: "LEARNING",
          sourceType: "LEARNING",
          sourceId: milestone.id,
          tier: "HOT",
          // 2026-10-09 round 72-B: 补 qualityScore(此前漏写 -> 列默认 0 -> 隐形于质量门)
          qualityScore: calcQualityScore({ type: "memory", content: `完成了学习里程碑: ${milestone.title}`, title: milestone.title }),
        },
      });
      if (!_mem) console.warn("[learning.completeMilestone] Memory 被 store 内容闸拒绝(不合规), 未落库");

      await prisma.flywheelEvent.create({
        data: {
          stage: "LEARN",
          sourceType: "MILESTONE",
          sourceId: milestone.id,
          sourceTitle: milestone.title,
          targetStage: "REFLECT",
        },
      });
    }

    // 自动从学习里程碑提取知识
    const summary = await prisma.learningSummary.findUnique({
      where: { milestoneId: input.milestoneId },
    });
    if (summary) {
      const skills = summary.skillsGained ? JSON.parse(summary.skillsGained) : [];
      const tools = summary.toolsMastered ? JSON.parse(summary.toolsMastered) : [];
      const docs = summary.documents ? JSON.parse(summary.documents) : [];
      const demos = summary.demos ? JSON.parse(summary.demos) : [];

      // 从学习日志提取核心知识
      const logs = await prisma.milestoneLog.findMany({
        where: { milestoneId: input.milestoneId },
        orderBy: { createdAt: "desc" },
        take: 5,
      });

      if (logs.length > 0) {
        const contentSnippet = logs.map(l => l.content).join("\n\n");
        await safeCreateKnowledge(prisma, {
          data: {
            title: `学习总结: ${milestone.title}`,
            content: contentSnippet.slice(0, 1000),
            sourceType: "LEARNING",
            sourceId: milestone.id,
            sourceDetail: "通过学习里程碑自动提取",
            category: projectCategory(milestone.description?.split("\n")[0] ?? "LEARNING", "knowledge") ?? "OTHER", // 2026-10-08 round 54
            tags: skills.slice(0, 5).join(","),
            confidence: 0.7,
          },
        });
      }

      // 从掌握的技能创建知识
      for (const skill of skills) {
        await safeCreateKnowledge(prisma, {
          data: {
            title: `技能: ${skill}`,
            content: `通过 ${milestone.title} 学习获得的技能: ${skill}`,
            sourceType: "LEARNING",
            sourceId: milestone.id,
            sourceDetail: "通过学习里程碑自动提取",
            category: "SKILL",
            tags: "skill,learning",
            confidence: 0.75,
          },
        });
      }

      // 从掌握的工具创建知识
      for (const tool of tools) {
        await safeCreateKnowledge(prisma, {
          data: {
            title: `工具: ${tool}`,
            content: `通过 ${milestone.title} 掌握的工具: ${tool}`,
            sourceType: "LEARNING",
            sourceId: milestone.id,
            sourceDetail: "通过学习里程碑自动提取",
            category: "TOOL",
            tags: "tool,learning",
            confidence: 0.8,
          },
        });
      }

      // 从文档成果创建知识
      for (const doc of docs) {
        await safeCreateKnowledge(prisma, {
          data: {
            title: `文档: ${doc}`,
            content: `通过 ${milestone.title} 创建的文档: ${doc}`,
            sourceType: "LEARNING",
            sourceId: milestone.id,
            sourceDetail: "通过学习里程碑自动提取",
            category: "DOCUMENT",
            tags: "document,learning",
            confidence: 0.85,
          },
        });
      }

      // 从Demo创建知识
      for (const demo of demos) {
        await safeCreateKnowledge(prisma, {
          data: {
            title: `Demo: ${demo}`,
            content: `通过 ${milestone.title} 创建的Demo: ${demo}`,
            sourceType: "LEARNING",
            sourceId: milestone.id,
            sourceDetail: "通过学习里程碑自动提取",
            category: projectCategory("DEMO", "knowledge") ?? "OTHER", // 2026-10-08 round 54: DEMO 未在受控集 -> OTHER
            tags: "demo,learning",
            confidence: 0.85,
          },
        });
      }
    }

    return milestone;
  }),
});
