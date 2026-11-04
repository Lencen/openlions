/**
 * runtime-repo.ts — 运行期自建表的统一异步入口（2026-10-26，SQLite 退役 P3）
 *
 * 覆盖表：Todo / AcceptanceVerdict / Discussion / TodoConsumer——这些表已在 PG。
 *   历史三模式（sqlite/dual/pg）已收敛为**只走 PG**；接口保持不变，调用方零改动。
 */
import { prisma } from "@/lib/prisma";

const TABLES = ["Todo", "AcceptanceVerdict", "Discussion", "TodoConsumer"];

export type RuntimeMode = "pg";
export function runtimeMode(): RuntimeMode {
  return "pg";
}
export function runtimeReadPg(): boolean {
  return true;
}

function assertTable(sql: string): void {
  if (!TABLES.some((t) => new RegExp("\\b" + t + "\\b").test(sql))) {
    throw new Error("[runtime-repo] 只允许这些表: " + TABLES.join("/") + " —— " + sql.slice(0, 80));
  }
}
/** PG 的 bigint 不能直接 JSON 序列化（NextResponse 会抛 "Do not know how to serialize a BigInt"） */
function normalize(rows: any[]): any[] {
  return rows.map((r) => {
    const o: any = {};
    for (const k of Object.keys(r)) o[k] = typeof r[k] === "bigint" ? Number(r[k]) : r[k];
    return o;
  });
}
async function pgAll(sql: string, params: unknown[]): Promise<any[]> {
  return normalize((await prisma.$queryRawUnsafe(sql, ...(params as any[]))) as any[]);
}
async function pgRun(sql: string, params: unknown[]): Promise<{ changes: number }> {
  return { changes: Number(await prisma.$executeRawUnsafe(sql, ...(params as any[]))) || 0 };
}

/** dbPath 参数保留仅为兼容旧签名；已无 SQLite 可开，传入即忽略。 */
export function runtimeRepoFor(_dbPath?: string) {
  return {
    async all(sql: string, ...params: unknown[]): Promise<any[]> {
      assertTable(sql);
      return pgAll(sql, params);
    },
    async get(sql: string, ...params: unknown[]): Promise<any | undefined> {
      assertTable(sql);
      return (await pgAll(sql, params))[0];
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      assertTable(sql);
      return pgRun(sql, params);
    },
    async runPg(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      assertTable(sql);
      return pgRun(sql, params);
    },
  };
}

export const runtimeRepo = runtimeRepoFor();
