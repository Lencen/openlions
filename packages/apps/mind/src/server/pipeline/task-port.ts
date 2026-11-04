/**
 * task-port.ts — TaskPort 只读 adapter（2026-10-27）
 *
 * 只实现 get；create/claim/release/transition 仍走 task-lease + flywheel API。
 * 目的：换任务存储/状态机前，先让读侧依赖端口，而不是直接依赖 Prisma。
 */
import { prisma } from "@/lib/prisma";
import type { Task, TaskPort } from "./ports";

export type TaskReadPort = Pick<TaskPort, "get">;

export function createTaskReadPort(): TaskReadPort {
  return {
    async get(taskId: string): Promise<Task | null> {
      const row = await (prisma as any).task.findUnique({ where: { id: taskId } });
      if (!row) return null;
      return {
        id: String(row.id),
        status: row.status,
        title: String(row.title ?? ""),
        assignedAgent: row.assignedAgent ?? null,
        retryCount: Number(row.retryCount ?? 0),
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? ""),
      };
    },
  };
}
