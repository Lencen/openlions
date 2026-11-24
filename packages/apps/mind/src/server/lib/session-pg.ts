/**
 * session-pg.ts — mind 侧只读访问 session 服务 PG 库的唯一入口（2026-10-26，SQLite 退役 P3）
 *
 * 为什么需要：mind 的 Prisma client 只连 lions_mind，而历史指标（日结/会话提炼覆盖率）
 *   还在直连 session 的 dev.db。SQLite 退役后这些读数必须改读 lions_session。
 * 只读、连接池单例、失败抛出（调用方决定是否降级为非致命）。
 */
import fs from "fs";
import { Pool } from "pg";

let pool: Pool | null = null;

function connectionString(): string {
  if (process.env.SESSION_DATABASE_URL) return process.env.SESSION_DATABASE_URL;
  const file = process.env.LIONS_PG_PASSWORD_FILE || "~/lions/run/pg-password";
  let pw = "";
  try { pw = fs.readFileSync(file, "utf8").trim(); } catch { pw = process.env.PGPASSWORD || ""; }
  if (!pw) throw new Error("[session-pg] SESSION_DATABASE_URL 未设置且 run/pg-password 不可读");
  return "postgresql://lions:" + encodeURIComponent(pw) + "@127.0.0.1:5432/lions_session";
}

function ensurePool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: connectionString(), max: 4, idleTimeoutMillis: 30000 });
    // PG 重启/被 kill 时 pg 会对空闲连接 emit("error")；EventEmitter 的 error 事件**无监听**会被抛成
    // unhandled error -> 整个 mind 进程退出（是崩溃，不是优雅重连）。
    // 这里**只记录不退出**：坏连接由 Pool 自己丢弃，下次 query 自动新建；
    // 在途查询仍会失败，由调用方降级（本模块契约就是「失败抛出，调用方决定是否非致命」）。
    pool.on("error", (e: Error) => {
      console.error("[session-pg] idle client error（池丢弃该连接，下次 query 重建）:", e.message);
    });
  }
  return pool;
}

export async function sessionQuery<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const r = await ensurePool().query(sql, params);
  return r.rows as T[];
}
