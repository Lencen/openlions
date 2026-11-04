// mind-read.ts — portal 对 mind 的**只读读取层**（2026-10-21 Phase 2：mind 已切 PostgreSQL，本层改为 PG 只读连接）
//
// 历史：2026-10-15 之前 portal 用 Prisma 读写 mind 的 dev.db，导致"除 mind 外 0 持有者"硬闸失效；
//   之后收口成 better-sqlite3 只读。2026-10-21 mind 已切 PG，只读层随之改为 PG 连接池，
//   SQL 经共享方言适配（? -> $n、标识符引号化、DateTime 处理）。
// 失败仍**抛出**，由调用方 silentQuery 兜底（保持 2026-09-17 stale-WAL 事故后的可见性口径）。
import fs from "fs";
import { Pool } from "pg";
import { adaptSql } from "./sql-dialect";

const PG_PASSWORD = (() => {
  // 开源可移植：优先环境变量，其次可配置路径，再次仓库内默认（仅本机开发）
  const file = process.env.LIONS_PG_PASSWORD_FILE || ((process.env.LIONS_HOME || process.cwd()) + "/run/pg-password");
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return process.env.PGPASSWORD || ""; }
})();

/** mind 的 PG 连接串（MIND_DATABASE_URL 优先，否则用本机默认 + run/pg-password） */
export const MIND_DB =
  process.env.MIND_DATABASE_URL ||
  (PG_PASSWORD ? `postgresql://lions:${PG_PASSWORD}@127.0.0.1:5432/lions_mind` : "");

const globalForMindRead = globalThis as unknown as { portalMindReadPool?: Pool };

/** 进程内单例连接池（Next dev/prod 都会重复求值模块，钉在 globalThis 上） */
export function mindReadDb(): Pool | null {
  if (!MIND_DB) return null;
  if (!globalForMindRead.portalMindReadPool) {
    globalForMindRead.portalMindReadPool = new Pool({ connectionString: MIND_DB, max: 4 });
  }
  return globalForMindRead.portalMindReadPool;
}

/** 任意查询 → 对象数组（字段名大小写与 SQL 一致）。失败抛出。 */
export async function q(sql: string, ...params: any[]): Promise<any[]> {
  const pool = mindReadDb();
  if (!pool) throw new Error(`mind PG 只读连接不可用 (MIND_DB=${MIND_DB ? "set" : "empty"})`);
  const r = await pool.query(adaptSql(sql), params);
  return r.rows;
}

/** 单行查询 → 对象或 null。失败抛出。 */
export async function one(sql: string, ...params: any[]): Promise<any | null> {
  const rows = await q(sql, ...params);
  return rows[0] ?? null;
}

// ── 出口解码（保持 Prisma 语义契约）──────────────────────────────
export function asDate(v: any): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    // 2026-10-21 时区修复：PG 的 timestamp without time zone 返回 "YYYY-MM-DD HH:MM:SS"（无时区），
    // 直接 new Date() 会按本机时区解析 -> 8 小时偏移。这里显式按 UTC 解析（带时区后缀的保持原样）。
    const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(v);
    const s = naive ? v.replace(" ", "T") + "Z" : v;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const n = Number(v);
  return Number.isFinite(n) ? new Date(n) : null;
}

export function asBool(v: any): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  return Number(v) !== 0;
}
