/**
 * platform-write-guard.ts —— 平台写接口的权限校验 + 二次确认闸（0.4.40-02 批2）
 *
 * 为什么需要：console 的写接口此前**完全无鉴权**（任何能访问 3004 的请求都能发）。
 *   批1 只做了审计；批2 加"谁能写"。
 *
 * 两个开关（已登记在根 AGENTS.md §七）：
 *   PLATFORM_WRITE_AUTH    enforce | shadow | off   默认 shadow
 *     enforce: 无合法凭证 -> 401/403
 *     shadow : 判定照做，只记 would_deny 日志，不拦（先空跑看误伤）
 *     off    : 不检查（等价 0.4.39）
 *   PLATFORM_WRITE_CONFIRM on | off                默认 on
 *     on : 写请求必须带 confirm===true 或 confirmToken（二次确认痕迹，与审计 metadata 要求一致）
 *     off: 跳过（仅应急）
 *
 * 凭证：请求头 x-platform-admin-token，取值需等于服务端 env PLATFORM_ADMIN_TOKEN（未配置时回落 MIND_ADMIN_API_KEY）。
 *   铁律：admin 凭证只在服务端，绝不下发浏览器（与 macs-admin.ts 同一约定）。
 */
import type { NextRequest } from "next/server";

export type PlatformPerm = "perm.grant" | "auth.manage" | "config.write" | "agent.manage" | "ops.write";

/** 单一结果类型（不用联合类型：调用点在不严格模式下对 ok 的收窄不可靠，实测 TS2339） */
export interface GuardResult {
  ok: boolean;
  mode: string;
  /** ok=false 时有效 */
  status?: number;
  body?: Record<string, unknown>;
  /** ok=true 时有效 */
  actorId?: string;
}

export function writeAuthMode(): "enforce" | "shadow" | "off" {
  const v = String(process.env.PLATFORM_WRITE_AUTH || "shadow").toLowerCase();
  return v === "enforce" || v === "off" ? v : "shadow";
}

export function confirmRequired(): boolean {
  return String(process.env.PLATFORM_WRITE_CONFIRM || "on").toLowerCase() !== "off";
}

function expectedToken(): string {
  return String(process.env.PLATFORM_ADMIN_TOKEN || process.env.MIND_ADMIN_API_KEY || "");
}

/** 纯判定（无 IO）：给定凭证/期望值 -> 是否放行。便于自测。 */
export function decideAuth(provided: string, expected: string, mode: string): { allow: boolean; reason: string } {
  if (mode === "off") return { allow: true, reason: "mode=off" };
  if (!expected) return { allow: false, reason: "服务端未配置 PLATFORM_ADMIN_TOKEN" };
  if (!provided) return { allow: false, reason: "缺少 x-platform-admin-token" };
  if (provided !== expected) return { allow: false, reason: "token 不匹配" };
  return { allow: true, reason: "ok" };
}

/** 二次确认判定（纯函数）：confirmed===true 或非空 confirmToken。 */
export function decideConfirm(body: Record<string, unknown>): boolean {
  return body?.confirm === true || (typeof body?.confirmToken === "string" && body.confirmToken.trim() !== "");
}

type Req = { headers: { get(k: string): string | null } } | NextRequest;

export function requirePlatformWrite(req: Req, perm: PlatformPerm, body: Record<string, unknown>): GuardResult {
  const mode = writeAuthMode();
  const provided = String((req as any)?.headers?.get?.("x-platform-admin-token") || "").trim();
  const d = decideAuth(provided, expectedToken(), mode);

  if (!d.allow && mode === "enforce") {
    console.warn(JSON.stringify({ event: "platform.write.denied", perm, reason: d.reason, mode }));
    return { ok: false, status: d.reason.includes("未配置") ? 503 : 401, body: { ok: false, error: "写操作未授权", reason: d.reason }, mode };
  }
  if (!d.allow && mode === "shadow") {
    console.warn(JSON.stringify({ event: "platform.write.would_deny", perm, reason: d.reason, mode }));
  }

  if (confirmRequired() && !decideConfirm(body)) {
    return { ok: false, status: 400, body: { ok: false, error: "缺少二次确认（confirm=true 或 confirmToken）" }, mode };
  }

  const actorId = String((req as any)?.headers?.get?.("x-actor") || "console-admin").trim() || "console-admin";
  return { ok: true, actorId, mode };
}
