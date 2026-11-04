import { Pool } from "pg";

/**
 * session 服务读 mind 库的只读连接池（2026-10-21 Phase 2）。
 * 之前 mindAuth 用 better-sqlite3 直读 dev.db，换库后新授权的 key 只进 PG，
 * 导致 session 认证 401。这里统一走 MIND_DATABASE_URL。
 */
const MIND_DB = process.env.MIND_DATABASE_URL || "";

const globalForMind = globalThis as unknown as { sessionMindPool?: Pool | null };
const pool: Pool | null =
  globalForMind.sessionMindPool ??
  (MIND_DB ? new Pool({ connectionString: MIND_DB, max: 5 }) : null);
if (MIND_DB && !globalForMind.sessionMindPool) globalForMind.sessionMindPool = pool;

export async function one(sql: string, ...params: any[]): Promise<any | null> {
  if (!pool) return null;
  const r = await pool.query(sql, params);
  return r.rows[0] ?? null;
}
