/**
 * runtime-repo.ts — 运行期自建表的统一异步入口（2026-10-23，P5）
 *
 * 覆盖表：Todo / AcceptanceVerdict / Discussion / TodoConsumer
 *   （这些表不在 Prisma schema 里，历史上由各路由 better-sqlite3 自建自读写。）
 *
 * 模式（与 todo-repo 同一套开关，秒级回退）：
 *   RUNTIME_DB_DRIVER = sqlite | dual | pg   默认 sqlite
 *   RUNTIME_READ_PG   = 1                     读走 PG（与写解耦，用于分阶段切读）
 *
 * 约束：占位符用 ?；表名/列名按源码原样（PG 侧由方言层按位置规范化）。
 */
import fs from "fs";
import path from "path";
import { openMindDb } from "./open-mind-db";
import { prisma } from "@/lib/prisma";

const TABLES = ["Todo", "AcceptanceVerdict", "Discussion", "TodoConsumer"];
const DEFAULT_DB = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");
const MIRROR_LOG = "~/lions/logs/runtime-repo-mirror.log";

export type RuntimeMode = "sqlite" | "dual" | "pg";
export function runtimeMode(): RuntimeMode {
  const v = String(process.env.RUNTIME_DB_DRIVER || "sqlite").toLowerCase();
  return v === "dual" || v === "pg" ? (v as RuntimeMode) : "sqlite";
}
export function runtimeReadPg(): boolean {
  return runtimeMode() === "pg" || String(process.env.RUNTIME_READ_PG || "") === "1";
}

const CACHE = new Map<string, any>();
function sqliteAt(dbPath: string): any {
  if (!CACHE.has(dbPath)) CACHE.set(dbPath, openMindDb({ role: "direct-rw", dbPath, caller: "runtime-repo" }));
  return CACHE.get(dbPath);
}
function log(rec: Record<string, unknown>): void {
  try { fs.appendFileSync(MIRROR_LOG, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n"); } catch { /* ignore */ }
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

export function runtimeRepoFor(dbPath?: string) {
  const pathOf = () => dbPath || DEFAULT_DB;
  return {
    async all(sql: string, ...params: unknown[]): Promise<any[]> {
      assertTable(sql);
      if (runtimeReadPg()) return pgAll(sql, params);
      return sqliteAt(pathOf()).prepare(sql).all(...params) as any[];
    },
    async get(sql: string, ...params: unknown[]): Promise<any | undefined> {
      assertTable(sql);
      if (runtimeReadPg()) return (await pgAll(sql, params))[0];
      return sqliteAt(pathOf()).prepare(sql).get(...params);
    },
    async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      assertTable(sql);
      const mode = runtimeMode();
      if (mode === "pg") return pgRun(sql, params);
      const r = sqliteAt(pathOf()).prepare(sql).run(...params) as { changes: number };
      if (mode === "dual") {
        try { await pgRun(sql, params); }
        catch (e: any) { log({ ok: false, sql: sql.slice(0, 160), err: String(e?.message || e).slice(0, 300) }); }
      }
      return { changes: Number(r?.changes) || 0 };
    },
    async runPg(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
      assertTable(sql);
      return pgRun(sql, params);
    },
  };
}

export const runtimeRepo = runtimeRepoFor();
