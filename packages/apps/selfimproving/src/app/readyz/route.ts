import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * /readyz — selfimproving:3001 的就绪心跳 (2026-09-24, 休假期间首日补齐)
 *
 * 同 mind/readyz 立规背景。选最薄 $queryRawUnsafe("SELECT 1") 做连通性自检,
 * 不绑业务 schema (防 schema 漂移再击中)。selfimproving 的 DB 漂移守门已扩, 见
 * scripts/prisma-schema-drift-guard.cjs --app=selfimproving。
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
    // 2026-09-28 立规强化(portal 假绿教训): 探针**触碰真实业务表**(Task), 不只 SELECT 1。
    // 2026-10-21 Phase 2: 表名必须加引号（PG 会转小写，未加引号会命中不存在的 task）
    await withTimeout(prisma.$queryRawUnsafe('SELECT 1 FROM "Task" LIMIT 1'), READYZ_TIMEOUT_MS, "db");
    return { ok: true, ms: Date.now() - t0 };
  } catch (e: unknown) {
    return { ok: false, ms: Date.now() - t0, detail: String((e as { message?: string })?.message || e).slice(0, 200) };
  }
}

export async function GET() {
  const started = Date.now();
  const checks: Record<string, { ok: boolean; ms: number; detail?: string }> = {};
  checks.db = await checkDb();
  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    {
      ok,
      ready: ok,
      service: "selfimproving",
      port: 3001,
      timeoutMs: READYZ_TIMEOUT_MS,
      checks,
      tookMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
