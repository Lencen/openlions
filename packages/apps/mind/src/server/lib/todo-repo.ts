/**
 * todo-repo.ts — Todo 访问的唯一异步入口（2026-10-23，迁移 P1/P2 底座）
 *
 * 为什么需要它：现有代码用 better-sqlite3 的**同步** API（prepare().get/all/run），
 *   而 PG 只能异步访问。要"切读到 PG"就必然把调用点改成 await —— 本模块把这件事收口成
 *   一个很小的接口，调用方只认 all/get/run，不关心底层是谁。
 *
 * 模式（环境变量 TODO_DB_DRIVER，默认 sqlite，秒级回退）：
 *   sqlite  读/写都走 dev.db（行为与迁移前完全一致）
 *   dual    写：先写 SQLite（主），再写 PG；读：仍 SQLite（P1 期间）
 *   pg      读/写都走 PG（P2 之后）
 *
 * SQL 约定：占位符用 ?；表名写 Todo、列名按源码原样（PG 侧由方言层按位置规范化）。
 *   不要自己加引号，也不要传 $1（方言层只认 ?）。
 */
import fs from "fs";
import path from "path";
import { openMindDb } from "./open-mind-db";
import { prisma } from "@/lib/prisma";

const MIRROR_LOG = "~/lions/logs/todo-mirror.log";
/** 双写失败只留痕、不打断业务（读仍是 SQLite，PG 落后由对账脚本暴露） */
function logMirror(rec: Record<string, unknown>): void {
  try { fs.appendFileSync(MIRROR_LOG, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n"); } catch { /* ignore */ }
}

export type TodoMode = "sqlite" | "dual" | "pg";

export function todoMode(): TodoMode {
  const v = String(process.env.TODO_DB_DRIVER || "sqlite").toLowerCase();
  return v === "dual" || v === "pg" ? (v as TodoMode) : "sqlite";
}

/** 读路径是否走 PG（P2 开关，与写路径解耦：可 dual 写 + PG 读） */
export function todoReadPg(): boolean {
  return todoMode() === "pg" || String(process.env.TODO_READ_PG || "") === "1";
}

const DEFAULT_DB_PATH = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");

/** 按库路径缓存 SQLite 连接（迁移前的代码是每次 open/close，这里保留长连接以减少 churn） */
const CACHE = new Map<string, any>();
function sqliteAt(dbPath: string): any {
  if (!CACHE.has(dbPath)) {
    CACHE.set(dbPath, openMindDb({ role: "direct-rw", dbPath, caller: "todo-repo" }));
  }
  return CACHE.get(dbPath);
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

/** 造一个绑定到指定 SQLite 路径的 repo（保留测试/夹具传 dbPath 的能力） */
export function todoRepoFor(dbPath?: string) {
  const pathOf = () => dbPath || DEFAULT_DB_PATH;
  return {
    async all(sql: string, ...params: unknown[]): Promise<any[]> {
      assertTodo(sql);
      if (todoReadPg()) return pgAll(sql, params);
      return sqliteAt(pathOf()).prepare(sql).all(...params) as any[];
    },
    async get(sql: string, ...params: unknown[]): Promise<any | undefined> {
      assertTodo(sql);
      if (todoReadPg()) return (await pgAll(sql, params))[0];
      return sqliteAt(pathOf()).prepare(sql).get(...params);
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      assertTodo(sql);
      const mode = todoMode();
      if (mode === "pg") return pgRun(sql, params);
      const r = sqliteAt(pathOf()).prepare(sql).run(...params) as { changes: number };
      if (mode === "dual") {
        try { await pgRun(sql, params); }
        catch (e: any) { logMirror({ ok: false, sql: sql.slice(0, 160), err: String(e?.message || e).slice(0, 300) }); }
      }
      return { changes: Number(r?.changes) || 0 };
    },
    async runPg(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      assertTodo(sql);
      return pgRun(sql, params);
    },
  };
}

export const todoRepo = todoRepoFor();
