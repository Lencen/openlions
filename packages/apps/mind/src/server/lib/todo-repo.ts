/**
 * todo-repo.ts — Todo 访问的唯一异步入口（2026-10-26，SQLite 退役 P3）
 *
 * 历史：2026-10-23 引入 sqlite/dual/pg 三模式做迁移；2026-10-26 起 SQLite 已退役，
 *   本模块**只走 PG**。保留 all/get/run 接口与 todoMode()/todoReadPg() 供调用方零改动。
 *
 * SQL 约定：占位符用 ?；表名写 Todo、列名按源码原样（PG 侧由方言层按位置规范化）。
 */
import { prisma } from "@/lib/prisma";

export type TodoMode = "pg";

/** 兼容旧调用方：永远 PG（不再有 sqlite/dual 回退）。 */
export function todoMode(): TodoMode {
  return "pg";
}
export function todoReadPg(): boolean {
  return true;
}

function assertTodo(sql: string): void {
  if (!/\bTodo\b/.test(sql)) throw new Error("[todo-repo] 只用于 Todo 表: " + sql.slice(0, 80));
}

async function pgAll(sql: string, params: unknown[]): Promise<any[]> {
  return (await prisma.$queryRawUnsafe(sql, ...(params as any[]))) as any[];
}
async function pgRun(sql: string, params: unknown[]): Promise<{ changes: number }> {
  const n = await prisma.$executeRawUnsafe(sql, ...(params as any[]));
  return { changes: Number(n) || 0 };
}

/** dbPath 参数保留仅为兼容旧签名；已无 SQLite 可开，传入即忽略。 */
export function todoRepoFor(_dbPath?: string) {
  return {
    async all(sql: string, ...params: unknown[]): Promise<any[]> {
      assertTodo(sql);
      return pgAll(sql, params);
    },
    async get(sql: string, ...params: unknown[]): Promise<any | undefined> {
      assertTodo(sql);
      return (await pgAll(sql, params))[0];
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      assertTodo(sql);
      return pgRun(sql, params);
    },
    async runPg(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      assertTodo(sql);
      return pgRun(sql, params);
    },
  };
}

export const todoRepo = todoRepoFor();
