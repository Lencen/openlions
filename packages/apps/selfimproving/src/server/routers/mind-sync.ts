/**
 * Mind Sync Router — V2.0
 *
 * Syncs improvements from Lions-Mind reflections into Tasks.
 * Fetches recent reflections, creates Tasks from their improvements,
 * and tracks progress via FlywheelEvent.
 */
import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "./audit";

export const mindSyncRouter = createRouter({
  /**
   * Trigger sync: fetch reflections from Lions-Mind and create tasks
   */
  trigger: publicProcedure.mutation(async () => {
    // 1. Fetch recent reflections from Lions-Mind
    const url = new URL("http://localhost:3000/api/trpc/reflection.list");
    url.searchParams.set("input", JSON.stringify({ page: 1, pageSize: 10 }));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch reflections: ${response.status}`);
    }

    const result = await response.json();
    const reflections = result.result?.data?.items || [];

    let created = 0;
    let skipped = 0;
    const tasks: { id: string; title: string }[] = [];

    // 2. Process each reflection
    for (const reflection of reflections) {
      // Parse improvements — they may be a JSON string or already an array
      let improvements: string[] = [];
      if (reflection.improvements) {
        try {
          improvements = typeof reflection.improvements === "string"
            ? JSON.parse(reflection.improvements)
            : reflection.improvements;
        } catch {
          improvements = [];
        }
      }

      // Skip if no improvements
      if (!improvements || improvements.length === 0) {
        continue;
      }

      // 3. Check for existing tasks (deduplication via FlywheelEvent)
      const existingEvent = await prisma.flywheelEvent.findFirst({
        where: {
          sourceType: "REFLECTION",
          sourceId: reflection.id,
          targetType: "TASK",
        },
      });

      if (existingEvent) {
        skipped += improvements.length;
        continue;
      }

      // 4. Create a task for each improvement
      for (const improvement of improvements) {
        const taskTitle = improvement.slice(0, 100);
        const task = await prisma.task.create({
          data: {
            title: taskTitle,
            description: `来自反思"${reflection.title}"中的待办项。\n\n内容：${improvement}`,
            background: `来源：Lions-Mind 反思记录 — "${reflection.title}"。反思ID：${reflection.id}。`,
            requirements: "1. 理解任务目标\n2. 收集相关信息\n3. 制定执行计划\n4. 执行并验证\n5. 记录执行过程和问题",
            materials: `反思记录：${reflection.title}`,
            acceptanceCriteria: "1. 完成了待办项\n2. 有完整的执行记录\n3. 解决了执行中的问题",
            qualityStandards: "执行过程清晰，问题记录准确，解决方案合理",
            priority: "P2",
            sourceReflectionIds: JSON.stringify([reflection.id]),
          },
        });

        // 5. Track with FlywheelEvent
        await prisma.flywheelEvent.create({
          data: {
            stage: "TASK_CREATED",
            sourceType: "REFLECTION",
            sourceId: reflection.id,
            sourceTitle: improvement.slice(0, 50),
            targetStage: "TASK",
            targetType: "TASK",
            targetId: task.id,
            taskId: task.id,
          },
        });

        tasks.push({ id: task.id, title: task.title });
        created++;
      }
    }

    // 6. Record audit log for bulk operation
    await recordAuditLog({
      entityType: "MindSync",
      entityId: "mind-sync-trigger",
      action: "BULK_CREATED",
      actor: "SYSTEM",
      actorType: "SYSTEM",
      metadata: { created, skipped, tasksCount: tasks.length },
    });

    return { created, skipped, tasks };
  }),
});