import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * /readyz — session:3002 的就绪心跳 (2026-09-24, 由休假期间首日 agent-d 补齐)
 *
 * 立规背景: packages/apps/mind/src/app/readyz/route.ts 头注释已说明 ——
 *   探活不能只靠"TCP 通了/首页 200"。但 session/console/portal/selfimproving 都没有 /readyz,
 *   平台级 /api/v1/platform/health 不得不退而求其次, 探 / 首页。
 *   实测 session 的 / 4 秒级(数据拉取 + 首屏渲染), **必然超过 3s 探活阈值** ->
 *   平台级 health 永远把 session 标 crit/code:0, 假阴。每次重启 server 都触发。
 *   同样的根因: 4 个 app 缺 /readyz。本路由是 session 的对症补刀。
 *
 * 与 mind 的差异: session 数据库是 session 自己的 (dev.db), 选 Session 表做最小连通性自检。
 *   检查只读 $queryRawUnsafe("SELECT 1") 兜底, 不绑业务 schema(防 schema 漂移再击中)。
 *
 * 设计原则(与 mind readyz 同款):
 *   - 只回答一件事: **依赖是否就绪** (DB 可查)。
 *   - 恒定 3s 阈值内返回, 超时即 503。
 *   - 探活方应直接打 /readyz, 不要打首页(首页 4s)。
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
    // 2026-09-28 立规强化(portal 假绿教训): 探针**触碰真实业务表**(Session), 不只 SELECT 1。
    await withTimeout(prisma.$queryRawUnsafe("SELECT 1 FROM Session LIMIT 1"), READYZ_TIMEOUT_MS, "db");
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
      service: "session",
      port: 3002,
      timeoutMs: READYZ_TIMEOUT_MS,
      checks,
      tookMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
