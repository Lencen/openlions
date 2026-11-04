import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";

export const reviewRouter = createRouter({
  getPending: publicProcedure
    .input(z.object({ taskId: z.string().optional() }))
    .query(async ({ input }) => {
      return prisma.taskReview.findMany({
        where: {
          status: "PENDING",
          ...(input.taskId ? { taskId: input.taskId } : {}),
        },
        include: { task: true },
        orderBy: { createdAt: "asc" },
      });
    }),

  getByTask: publicProcedure.input(z.string()).query(async ({ input }) => {
    return prisma.taskReview.findMany({
      where: { taskId: input },
      orderBy: { createdAt: "desc" },
    });
  }),

  record: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        reviewerId: z.string(),
        reviewerRole: z.string(),
        status: z.string(),
        score: z.number().optional(),
        strengths: z.string().optional(),
        weaknesses: z.string().optional(),
        lessonsLearned: z.string().optional(),
        feedbackNotes: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const review = await prisma.taskReview.create({ data: input });

      if (input.status === "PASSED") {
        await prisma.task.update({
          where: { id: input.taskId },
          data: { status: "COMPLETED" },
        });

        await prisma.flywheelEvent.create({
          data: {
            stage: "TASK_COMPLETED",
            sourceType: "TASK_REVIEW",
            sourceId: review.id,
            sourceTitle: "Task review passed",
            targetStage: "KNOWLEDGE",
          },
        });
      } else if (input.status === "REVISION_REQUIRED") {
        await prisma.task.update({
          where: { id: input.taskId },
          data: { status: "IN_PROGRESS" },
        });
      }

      return review;
    }),
});