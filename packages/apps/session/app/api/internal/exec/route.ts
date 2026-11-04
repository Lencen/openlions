import { NextRequest, NextResponse } from "next/server";
import { readFileSync, appendFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { adaptSql } from "@/lib/sql-dialect";

/**
 * POST /api/internal/exec — Phase 1 写网关（session，2026-10-21，Phase 2）
 *
 * 只允许本机进程（回环 + 共享 secret）把 SQL 交给 **mind 的 owner 连接** 执行：
 *   · 单个进程内**串行**（promise 链），避免网关自身并发；
 *   · 失败返回 500 + 错误；成功返回 rows/rowsAffected；
 *   · 审计写 logs/session-internal-exec.jsonl（不记 params，防泄密）。
 *
 * 边界：这是过渡期网关；最终 Phase 2 换 PostgreSQL 后由 DB 连接池/MVCC 承担并发。
 */
const SECRET_FILE = "~/lions/run/internal-secret";
const AUDIT = "~/lions/logs/session-internal-exec.jsonl";

let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

function audit(rec: Record<string, unknown>): void {
  try {
    appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), ...rec }) + "\n");
  } catch { /* 审计失败不影响主路径 */ }
}

function bigintSafe(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

export async function POST(req: NextRequest) {
  let expected = "";
  try { expected = readFileSync(SECRET_FILE, "utf8").trim(); } catch { expected = ""; }
  if (!expected) return NextResponse.json({ ok: false, error: "internal-secret-missing" }, { status: 503 });
  const got = (req.headers.get("x-internal-secret") || "").trim();
  if (got !== expected) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({} as any));

  // 批量：一个事务内执行多条（脚本侧 transaction 的落点；原子、串行、一次往返）
  if (Array.isArray(body?.batch)) {
    const batch = body.batch.slice(0, 200).map((b: any) => ({
      sql: adaptSql(String(b?.sql || "").trim()),
      params: Array.isArray(b?.params) ? b.params : [],
      kind: b?.kind === "query" ? "query" : "exec",
    }));
    if (!batch.length || batch.some((b: any) => !b.sql)) return NextResponse.json({ ok: false, error: "batch sql required" }, { status: 400 });
    const started = Date.now();
    try {
      const result = await serialize(() => prisma.$transaction(batch.map((b: any) =>
        b.kind === "query" ? prisma.$queryRawUnsafe(b.sql, ...b.params) : prisma.$executeRawUnsafe(b.sql, ...b.params),
      )));
      audit({ batch: batch.length, ok: true, ms: Date.now() - started, sql: batch[0].sql.slice(0, 120) });
      return NextResponse.json({ ok: true, result: JSON.parse(JSON.stringify(result, bigintSafe)) });
    } catch (e: any) {
      audit({ batch: batch.length, ok: false, ms: Date.now() - started, error: String(e?.message || e).slice(0, 200) });
      return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
    }
  }

  const sql = adaptSql(String(body?.sql || "").trim());
  const kind = body?.kind === "query" ? "query" : "exec";
  const params: unknown[] = Array.isArray(body?.params) ? body.params : [];
  if (!sql) return NextResponse.json({ ok: false, error: "sql required" }, { status: 400 });

  const started = Date.now();
  try {
    const result = await serialize(async () => {
      if (kind === "query") return prisma.$queryRawUnsafe(sql, ...params);
      return prisma.$executeRawUnsafe(sql, ...params);
    });
    audit({ kind, ok: true, ms: Date.now() - started, sql: sql.slice(0, 200) });
    return NextResponse.json({ ok: true, result: JSON.parse(JSON.stringify(result, bigintSafe)) });
  } catch (e: any) {
    audit({ kind, ok: false, ms: Date.now() - started, sql: sql.slice(0, 200), error: String(e?.message || e).slice(0, 200) });
    return NextResponse.json({ ok: false, error: String(e?.message || e).slice(0, 300) }, { status: 500 });
  }
}
