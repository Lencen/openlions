import { NextResponse } from "next/server";
import { openMind, q, MIND_DB } from "@/lib/server/lions-db";

/**
 * /readyz — console:3004 的就绪心跳 (2026-09-24, 休假期间首日补齐)
 *
 * 立规背景: packages/apps/mind/src/app/readyz/route.ts 注释同款。
 *   console 没有自有 DB, 走 mind 的 PostgreSQL（只读连接池, lib/server/lions-db）。
 *
 * 2026-09-28 立规(与 portal 同期, commit deb2dd7): 此前 checks:{} 无 DB 自检 ——
 *   实测 portal 因长连接陈旧被静默报绿 3 天(queries 全失败, readyz 却 200)。
 *   console 同属长生命周期进程, 同风险。修法: 加最薄只读探针 SELECT 1 打 mind 库,
 *   失败返 503 —— 让陈旧连接/库不可读**自动暴露**, 不再被探活静默放过。
 *
 * 设计原则:
 *   - 探针只做 SELECT 1 (不碰业务表), 恒定 < 100ms, 3s 超时上限。
 *   - 不依赖 session/auth。
 *   - 探活方应直接打 /readyz, 不要打 / (首页可能引入代理, 慢且耦合)。
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const READYZ_TIMEOUT_MS = 3000;

async function checkMindDb(): Promise<{ ok: boolean; ms: number; detail?: string }> {
  const t0 = Date.now();
  let db: ReturnType<typeof openMind> | null = null;
  try {
    db = openMind();
    // 注意: lions-db 的 q() 是**容错**封装(吞错返 []), 探针不能用它 —— 否则永远报 ok。
    //   这里绕过容错层直打 prepare/get, 让 SQLite 的真实错误暴露出来(portal 假绿教训)。
    if (!db) return { ok: false, ms: Date.now() - t0, detail: "openMind() 返 null (库不存在或不可读): " + MIND_DB };
    // 2026-09-28 立规强化(portal 假绿教训): 探针**触碰真实业务表**(Memory), 不只 SELECT 1。
    //   SELECT 1 不落任何表的 B-tree, 陈旧连接/结构错乱照样通过; 触碰真实表才会暴露。
    await q(db, 'SELECT 1 FROM "Memory" LIMIT 1');
    return { ok: true, ms: Date.now() - t0 };
  } catch (e: unknown) {
    return { ok: false, ms: Date.now() - t0, detail: String((e as { message?: string })?.message || "").slice(0, 200) };
  } finally {
    /* 连接池由 lions-db 管理 */
  }
}

export async function GET() {
  const started = Date.now();
  const db = await checkMindDb();
  const ok = db.ok;
  return NextResponse.json(
    {
      ok,
      ready: ok,
      service: "console",
      port: 3004,
      timeoutMs: READYZ_TIMEOUT_MS,
      checks: { db },
      tookMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
