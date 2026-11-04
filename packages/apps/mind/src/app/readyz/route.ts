import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * /readyz — mind:3000 的就绪心跳 (2026-09-14, 提案 cmtwl36jy02bx1j76zndaehd0 第 2 项落地)。
 *
 * 为什么不能只靠"端口能连":
 *   实测探活脚本把"TCP 通了 / 首页返回 200"当成健康, 但 next dev 冷启动/DB 锁住时,
 *   接口会 200 一个错误页或 500 —— 探活仍显示 ok, 派单却拿不到数据 (假阳/假阴都遇到过)。
 *   /readyz 只回答一件事: **依赖是否就绪**(当前 = 数据库可查询), 就绪 200 / 未就绪 503。
 *
 * 与 /api/v1/platform/health 的分工:
 *   /readyz                —— 单服务自检(本服务依赖就绪), 供负载/探测直接打, 恒定 3s 阈值内返回。
 *   /api/v1/platform/health —— 平台级聚合(逐个服务探活), 其中 Mind 一律打 /readyz 而不是首页。
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** 统一探活阈值 3s: 与 platform/health 的 PROBE_TIMEOUT_MS 同值, 避免"这边 2s 那边 3s"的口径漂移。 */
// Next.js route 模块只允许导出约定的 handler/config 符号, 故此处常量不导出(避免 .next/types 校验报错)。
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
    // 2026-09-28 立规强化(portal 假绿教训): 探针**触碰真实业务表**, 不只 SELECT 1。
    //   实测: portal 陈旧连接使业务表全读失败, 而 SELECT 1 照样通过 -> readyz 假绿 3 天。
    //   `SELECT 1 FROM Memory LIMIT 1` 真实走该表页读取; 表空返 0 行亦正常(无错误即 OK)。
    await withTimeout(prisma.$queryRawUnsafe("SELECT 1 FROM Memory LIMIT 1"), READYZ_TIMEOUT_MS, "db");
    return { ok: true, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, detail: String(e?.message || e).slice(0, 200) };
  }
}

/** 2026-10-26 P4：生产模式下必须有构建产物。
 *  背景：当天 .next/BUILD_ID 丢失，服务回退 dev 并崩循环，但外部只看到 systemd failed；
 *  把"构建产物缺失"变成 readyz 的 503，探测/负载均衡能立刻看见。 */
function checkBuild(): { ok: boolean; ms: number; detail?: string } {
  const t0 = Date.now();
  if (process.env.NODE_ENV !== "production") return { ok: true, ms: Date.now() - t0, detail: "dev mode" };
  try {
    const fs = require("fs");
    const path = require("path");
    const f = path.join(process.cwd(), ".next", "BUILD_ID");
    const id = String(fs.readFileSync(f, "utf8")).trim();
    return id ? { ok: true, ms: Date.now() - t0, detail: id } : { ok: false, ms: Date.now() - t0, detail: "BUILD_ID empty" };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, detail: "missing .next/BUILD_ID: " + String(e?.message || e).slice(0, 120) };
  }
}

export async function GET() {
  const started = Date.now();
  const checks: Record<string, { ok: boolean; ms: number; detail?: string }> = {};
  checks.build = checkBuild();
  checks.db = await checkDb();
  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    {
      ok,
      ready: ok,
      service: "mind",
      port: 3000,
      timeoutMs: READYZ_TIMEOUT_MS,
      checks,
      tookMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
