// uos20 P0#3 + P0#11 权限分级守卫 (2026-09-23):
//   A 类只读接口白名单定义见 src/config/readonly-protocol-whitelist.ts (三件套);
//   ABC 分级/闸门/清单见 src/config/abc-permission-tiers.ts。
//   守卫行为: C 类 → 403 硬拒绝; A 类命中 → method/入参 schema 严格校验 (405/400);
//   B 类与未分类 → 放行 (B 现存行为不变, 由 abc-permission-tiers 的闸门管控开启)。
import { abcGuardCheck } from "./config/abc-permission-tiers";

// V6-1: 网关入口限流 (2026-06-18 09:50)
// in-memory token bucket, 不进业务代码
// 作用: 防止某个 agent 疯狂调 mind 把后端打爆
// 限制: 100 req/min per agent, burst 20
//   - > 100/min 持续 → 返 429
//   - burst 20 → 短时突发可放行, 持续打会 429
// 局限: 多实例不共享 (Next.js 单进程, 内存 limit 单机), 真分布式要换 Redis
//
// 关键: Node.js runtime, 因为 setInterval + .unref() 在 edge runtime 报错

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";  // 必须 nodejs, edge 不支持 unref() / process

interface Bucket {
  tokens: number;          // 当前剩余 token
  lastRefill: number;      // 上次补充时间 ms
}

const CAPACITY = 20;        // burst 容量
const REFILL_RATE = 100 / 60_000;  // 100/min → 0.00167 tokens/ms

// agent_id → bucket, in-memory
const buckets = new Map<string, Bucket>();

// 每 5min 清理 1h 没用的 bucket, 防止内存泄漏
setInterval(() => {
  const now = Date.now();
  const cutoff = now - 3600_000;
  buckets.forEach((b, k) => {
    if (b.lastRefill < cutoff) buckets.delete(k);
  });
}, 300_000);
// 注: nodejs runtime 下 setInterval 不需要 unref, 进程会自然退出时清理

function getBucket(agentId: string): Bucket {
  let b = buckets.get(agentId);
  const now = Date.now();
  if (!b) {
    b = { tokens: CAPACITY, lastRefill: now };
    buckets.set(agentId, b);
    return b;
  }
  // 补充 token
  const elapsed = now - b.lastRefill;
  b.tokens = Math.min(CAPACITY, b.tokens + elapsed * REFILL_RATE);
  b.lastRefill = now;
  return b;
}

function consume(agentId: string): boolean {
  const b = getBucket(agentId);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// 只对 /api/trpc 限流; 权限分级守卫见上 (matcher = /api/:path*, 全量 fail-closed)
export function middleware(req: NextRequest) {
  // ① 权限分级守卫 (uos20 P0#3 A 类 + P0#11 ABC, 2026-09-23)
  //    C 类 → 403; A 类命中按 method/入参 schema 严格校验 (405/400); B 类/未分类放行。
  const violation = abcGuardCheck(
    req.method,
    req.nextUrl.pathname,
    req.nextUrl.searchParams
  );
  if (violation) {
    return new NextResponse(
      JSON.stringify({ error: violation.error, message: violation.message }),
      { status: violation.status, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!req.nextUrl.pathname.startsWith("/api/trpc")) {
    return NextResponse.next();
  }

  // agent_id 提取: 优先 x-api-key 对应 perm 的 agent, 否则用 IP 作 fallback
  const apiKey = req.headers.get("x-api-key") || req.headers.get("x-bootstrap-key");
  const agentId = apiKey ? `key-${apiKey.slice(0, 12)}` : `ip-${req.ip || req.headers.get("x-forwarded-for") || "unknown"}`;

  if (!consume(agentId)) {
    return new NextResponse(
      JSON.stringify({
        error: "rate_limited",
        message: "Too many requests. Capacity 20 burst, 100/min sustained.",
        retry_after_ms: 600,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "1",
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": "0",
        },
      }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // trpc 网关限流
    "/api/trpc/:path*",
    // 权限分级守卫 (uos20 P0#3/#11): 全量 /api 进守卫 (fail-closed by default),
    // 由 abcGuardCheck 内部分类; 不再逐条枚举只读前缀 —— 逐条枚举会与白名单漂移
    // (2026-09-23 实测: knowledge/norms 已声明 A 类却漏配 matcher, 未知参数未被拦)。
    "/api/:path*",
    // C 类内部端点硬拒绝 (含精确 /internal 本身)
    "/internal",
    "/internal/:path*",
  ],
};
