/**
 * agent-key.ts — API key -> AgentServicePermission 的**单一实现**（2026-10-23 资产归属 R2-b 抽出）
 *
 * 为什么单独成文件：tRPC（`protectedProcedure` / `readerProcedure`）与 Next REST 路由（`app/api/v1/*`）
 *   都要按 key 认身份。原先这段只活在 trpc.ts 里，REST 侧要么复制一份（必然分叉），要么 import trpc
 *   （把 initTRPC/序列化层拖进 route bundle）。抽出来后两边共用同一判据。
 */
import { createHash } from "crypto";
import type { PrismaClient } from "../../../node_modules/.prisma/mind-client";

export type ApiKeyPerm = {
  id: string;
  agent_id: string;
  service_name: string;
  permissions: string;
  config: string | null;
  expires_at: Date;
  status: string;
  agent?: { role: string | null } | null;
} | null;

/** 返回 null = 未命中/已过期（调用方决定抛错还是降级匿名）。 */
export async function loadApiKeyPerm(
  client: PrismaClient | { agentServicePermission: { findUnique: (args: any) => Promise<any> } },
  key: string
): Promise<any> {
  const hash = createHash("sha256").update(key).digest("hex");
  return (client as any).agentServicePermission.findUnique({
    where: { api_key_hash: hash },
    include: { agent: true, service: true },
  });
}

export function permIsActive(perm: any, now: Date = new Date()): boolean {
  return !!perm && perm.status === "ACTIVE" && new Date(perm.expires_at) >= now;
}
