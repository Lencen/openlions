/**
 * service-auth.ts — mind v1 服务间鉴权的**唯一实现** (2026-10-15 portal 写转发改造)
 *
 * 为什么有本文件: portal 的 3 个写点(ingest / heartbeat / 读计数)改为转发 mind 接口后,
 *   新端点需要"服务身份"鉴权。mind **既有**做法(不新造一套密钥体系):
 *
 *     X-API-Key 明文 -> sha256 -> AgentServicePermission.api_key_hash 命中
 *       + status === "ACTIVE" + expires_at > now
 *
 *   同一判据原本散在两处实现, 本文件把判据**逐字**收敛成一处供 3 个新端点复用:
 *     · src/app/api/v1/flywheel/memory/feedback/route.ts:34-40  (round73-ae 定的三条件)
 *     · src/app/api/v1/agent/refresh-service-key/route.ts:50-62
 *   不新增 header 名、不新增密钥类型、不新增环境变量体系 —— portal 侧按仓库既有命名
 *   (LIONS_MIND_SERVICE_KEY / LIONS_MIND_API_KEY, 见 packages/apps/mcp-server/src/mind-client.ts:45)
 *   读取自己的 service key。
 *
 * ⚠ 已知边界(如实登记, 未擅自加严): 与既有两个 v1 端点一致, 本判据**不校验 service_name** ——
 *   任何一条 ACTIVE 的 AgentServicePermission key 都能通过。要收成"仅 lions_mind/memory/knowledge 族"
 *   需要人类决策(会改变既有 v1 端点的口径), 故本轮保持与既有实现一致; 详见交付说明。
 *
 * 注: 这些端点是"服务间"接口, 不对 agent 直接暴露能力扩张 —— C 类/未分类判定见
 *   src/config/abc-permission-tiers.ts (新路径未分类 -> 放行, 由本文件的鉴权管控)。
 */
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
// 2026-10-15 钥匙治理(item 2): 到期前自动续期(原地延长 expires_at, 不换密钥值)。
import { maybeAutoRenewKey } from "./key-governance";

export interface ServiceAuthResult {
  ok: boolean;
  /** ok=false 时给调用方(portal)的状态码 */
  status: 200 | 401;
  /** 命中 perm 的 agent_id(服务身份, 不是被代表的终端 agent) */
  agentId?: string;
  serviceName?: string;
  error?: string;
}

/**
 * 校验请求的 X-API-Key。
 * 判据 = packages/apps/mind/src/app/api/v1/flywheel/memory/feedback/route.ts 同款(该路由 2026-10-15
 *   起改为**调用本函数** —— 判据不再有两份):
 *   缺 key -> 401; 未命中/非 ACTIVE/已过期 -> 401(不区分原因, 防枚举)。
 *
 * 2026-10-15 钥匙治理(item 2): 通过校验后**顺手**做一次到期前自动续期
 *   (窗口内原地延长 expires_at, 不换密钥值)。fire-and-forget: 续期失败绝不改变本次鉴权结果。
 */
export async function requireServiceAuth(req: Request): Promise<ServiceAuthResult> {
  const xKey = (req.headers.get("x-api-key") || req.headers.get("X-Api-Key") || "").trim();
  if (!xKey) return { ok: false, status: 401, error: "缺少 X-API-Key" };

  const h = createHash("sha256").update(xKey).digest("hex");
  const perm = await prisma.agentServicePermission.findUnique({ where: { api_key_hash: h } });
  if (!perm || perm.status !== "ACTIVE" || new Date(perm.expires_at).getTime() <= Date.now()) {
    return { ok: false, status: 401, error: "无效/过期/已撤销的 x-api-key" };
  }
  maybeAutoRenewKey(
    { id: perm.id, agent_id: perm.agent_id, service_name: perm.service_name, expires_at: perm.expires_at, status: perm.status },
    { actor: perm.agent_id, actorType: "agent_key" },
  ).catch((e) => {
    console.error("[service-auth] auto-renew failed:", e);
  });
  return { ok: true, status: 200, agentId: perm.agent_id, serviceName: perm.service_name };
}
