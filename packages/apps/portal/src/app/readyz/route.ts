import { NextResponse } from "next/server";
// 2026-10-15 架构收口(DB-ACCESS-RULE §3.1): 探活读走**驱动级只读**句柄(mind-read), 不再用 Prisma 读写打开生产库。
import { q as mindQuery } from "@/lib/mind-read";

/**
 * /readyz — portal:3006 的就绪心跳 (2026-09-24, 休假期间首日补齐)
 *
 * 2026-09-28 立规 (commit 9b2d2b0 同期发现): portal 用 mind 共享 dev.db, 之前 /readyz 无 DB 检查,
 *   导致即使 portal.query 失败, health 仍报 ok (实测 "malformed database schema () - invalid rootpage")。
 *   修法: /readyz 加一个最薄连通性自检(`SELECT 1`) - 与 mind 同款 3s 阈值, 失败返 503。
 *
 * 历史(2026-09-28): portal 用 mind 的 prisma client, 该 client 08:53 重新生成过 (Mind 应用 schema
 *   变更后), 而 portal 进程缓存了旧 client, 缓存不匹配 -> invalid rootpage。
 * 2026-10-15 架构收口后, 这条历史失效了: portal 不再有 Prisma client, 探针直连
 *   better-sqlite3 只读句柄(src/lib/mind-read.ts), "陈旧 client 与 schema 不匹配"这一整类故障不再存在;
 *   而"页引用错乱/表结构错乱"仍会被本探针(触碰真实业务表 Memory)照旧暴露。
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const READYZ_TIMEOUT_MS = 3000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timeout > " + ms + "ms")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkDb(): Promise<{ ok: boolean; ms: number; detail?: string }> {
  const t0 = Date.now();
  try {
    // 2026-09-28 立规强化: 探针必须**触碰真实业务表**, 不能只 `SELECT 1`。
    //   实测教训: portal 因陈旧连接导致 Memory/Knowledge 等表全部读失败, 而 `SELECT 1`
    //   (不落任何表的 B-tree) 照样通过 -> readyz 报 ok 假绿 3 天。
    //   `SELECT 1 FROM Memory LIMIT 1` 会真实走一遍该表的页读取, 陈旧页引用/表结构
    //   错乱才会暴露。表为空时返回 0 行亦属正常(无错误即 OK)。
    // 2026-10-15 架构收口: 驱动换成 better-sqlite3(同步)。withTimeout 的 Promise.race **无法抢占**
    //   一个正在阻塞的同步查询, 3s 阈值因此退化为"对调用方的软约束"; 真正的等待上限由 mind-read 的
    //   busy_timeout(4000ms)兜底。只读 + WAL 下读者不会被写者阻塞, 实测本探针 ~1ms。
    await withTimeout(Promise.resolve().then(() => mindQuery("SELECT 1 FROM Memory LIMIT 1")), READYZ_TIMEOUT_MS, "db");
    return { ok: true, ms: Date.now() - t0 };
  } catch (e: unknown) {
    return { ok: false, ms: Date.now() - t0, detail: String((e as { message?: string })?.message || "").slice(0, 200) };
  }
}

export async function GET() {
  const started = Date.now();
  const db = await checkDb();
  const ok = db.ok;
  return NextResponse.json(
    {
      ok,
      ready: ok,
      service: "portal",
      port: 3006,
      timeoutMs: READYZ_TIMEOUT_MS,
      checks: { db },
      tookMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
