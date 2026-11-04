/**
 * request-actor.ts — REST 路由的"可选身份"解析（2026-10-23 资产归属 R2-b）
 *
 * 为什么需要：`app/api/v1/memory/*` 是 console 与 agent 共用的读接口，不能改成"必须带 key"
 *   （console 会 401），也不能继续"谁都能读全库"（agent 换个 URL 就绕过 tRPC 判据）。
 * 规则与 tRPC 的 `readerProcedure` 对齐：
 *   · x-admin-key 命中 MIND_ADMIN_API_KEY -> root_admin（全读，调用方是平台自身）
 *   · x-api-key 命中有效权限         -> 该身份
 *   · 无 key                          -> 匿名（只能读 无主/global）
 *   · 带 key 但失效                   -> 401（不静默降级：坏 key 要被看见）
 */
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadApiKeyPerm, permIsActive } from "./agent-key";
import type { AssetActor } from "@/server/pipeline/asset-scope";

export type RestActorResult =
  | { ok: true; actor: AssetActor; rootAdmin: boolean }
  | { ok: false; status: number; error: string };

export async function resolveRequestActor(req: NextRequest): Promise<RestActorResult> {
  const adminKey = req.headers.get("x-admin-key") || req.headers.get("X-Admin-Key");
  const expected = process.env.MIND_ADMIN_API_KEY;
  if (expected && adminKey === expected) return { ok: true, actor: { agentId: null, role: "OWNER" }, rootAdmin: true };

  const key = req.headers.get("x-api-key") || req.headers.get("X-Api-Key");
  if (!key) return { ok: true, actor: null, rootAdmin: false };

  const perm = await loadApiKeyPerm(prisma as any, key);
  if (!permIsActive(perm)) return { ok: false, status: 401, error: "invalid or expired apiKey" };
  return { ok: true, actor: { agentId: perm.agent_id, role: perm.agent?.role || "EDITOR" }, rootAdmin: false };
}
