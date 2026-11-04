import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
// 2026-10-15 钥匙治理(item 2/3): 轮换/续期/明文窗口/审计的**单一实现**。
import { refreshBusinessKey, expireStaleKeys, BUSINESS_KEY_TTL_DAYS, PLAINTEXT_CACHE_MS } from "@/server/lib/key-governance";

/**
 * POST /api/v1/agent/refresh-service-key — 2026-09-24 新增(人类决策), 2026-10-15 钥匙治理改造
 *
 * 目的: 解决"会话同步器需要 lions_session key,但每个 agent 机器都得人工下发"这件事 —
 *   现用现刷: 客户端用 **任意自己有效的 key**(MCP / lionsMind 等都行)调本接口,
 *   body 指定 service_name="lions_session", 平台**当场换发一个新 key**并写库,
 *   旧 key 立即失效。客户端把新 key 写到 ~/.config/lions/session-sync.json 即用即弃。
 *
 * 这是 OAuth refresh-token 的标准模式: 短/中期会话 key + 长期 bootstrap key(MCP key)。
 *
 * 鉴权: header X-API-Key = 当前任何一条 AgentServicePermission 的明文 key
 *       (必须 status=ACTIVE 且 expires_at>now; 其 service_name 任意, 只要这条 perm 属于该 agentId)。
 *
 * body:  { agentId: "agent-i", service_name: "lions_session" }
 *
 * 返:  { ok:true, service_name, api_key, agentId, expires_at }
 *
 * ── 2026-10-15 钥匙治理修好的两处缺陷(item 2, 人类点名) ─────────────────────────
 *   ① 旧实现 `UPDATE ... SET api_key_hash=?, api_key_plain=?, token_id=?, updated_at=?` ——
 *      **不改 expires_at**, 于是"轮换不续期": 换出的新钥匙仍带着旧到期时间(等于把 TTL 缩短)。
 *      现在: 走 `refreshBusinessKey()`, 新钥匙 expires_at = now + 90 天(与初次签发同口径)。
 *   ② 旧实现**全文件零审计**(无 recordAudit / 无 AuditLog 行)。
 *      现在: 每次轮换落 AuditLog(`REFRESH_SERVICE_KEY`), before/after 只记 key **指纹**(sha256 前 8 位)
 *      与到期时间, 绝不记钥匙值。
 *   ③ 顺带: 明文缓存窗口统一为 1 小时(item 3); 轮换后顺手跑一次到期收口(翻 EXPIRED + 清过期明文)。
 *
 * 安全注意(保持原有约束):
 *   1) 不允许通过本接口**新增 service_name** —— 那应该是 register_agent / grantServiceToAgent 的活。
 *   2) agentId 必须等于 X-API-Key 所归属的 agentId(防"用 A 的 key 给 B 刷 key")。
 *   3) 失败统一返 401(不区分"key 错"/"agentId 不匹配"), 防枚举; 未授权 404 / 已撤销 403。
 */
export const dynamic = "force-dynamic";

function hashApiKey(k: string): string {
  return createHash("sha256").update(k).digest("hex");
}

interface VerifyResult {
  ok: boolean;
  agentId?: string;
  reason?: string;
}

async function verifyKey(key: string): Promise<VerifyResult> {
  if (!key || !key.startsWith("sk-mind-")) return { ok: false, reason: "格式" };
  const h = hashApiKey(key);
  const now = new Date();
  // 任意 service_name 的明文匹配的 perm 都算(bootstrap 友好: MCP key 也能刷 lions_session)
  const rows: any = await prisma.$queryRawUnsafe(
    `SELECT agent_id, service_name, status, expires_at
       FROM AgentServicePermission
       WHERE api_key_hash = ?
       LIMIT 1`,
    h
  );
  const r = rows && rows[0];
  if (!r) return { ok: false, reason: "未命中" };
  if (String(r.status) !== "ACTIVE") return { ok: false, reason: "已停用" };
  if (r.expires_at && new Date(r.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "已过期" };
  return { ok: true, agentId: String(r.agent_id) };
}

export async function POST(req: NextRequest) {
  try {
    const xKey = req.headers.get("x-api-key") || "";
    const v = await verifyKey(xKey);
    if (!v.ok) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    let body: any = null;
    try { body = await req.json(); } catch { body = null; }
    const agentId = String((body && body.agentId) || "").trim();
    const serviceName = String((body && body.service_name) || "").trim();
    if (!agentId || !serviceName) {
      return NextResponse.json({ ok: false, error: "需要 agentId 和 service_name" }, { status: 400 });
    }
    if (agentId !== v.agentId) {
      // 防"用 A 的 key 给 B 刷 key": 用 A 的 key 写 agentId=B 也算 401
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    // 检查该 service_name 是否已对该 agent 授权(不创建新服务)
    const exist: any = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM AgentServicePermission WHERE agent_id = ? AND service_name = ? LIMIT 1`,
      agentId, serviceName
    );
    const e = exist && exist[0];
    if (!e) {
      return NextResponse.json(
        { ok: false, error: `该 agent 尚未被授予 ${serviceName}; 请先在平台注册/授权该服务` },
        { status: 404 }
      );
    }

    // 轮换 + 续期 90 天 + 明文窗口 1 小时 + 审计(单一实现)
    const rotated = await refreshBusinessKey({
      agentId,
      serviceName,
      actor: agentId,
      actorType: "agent_key",
    });
    if (!rotated.ok) {
      return NextResponse.json({ ok: false, error: rotated.message }, { status: rotated.code });
    }

    // 顺手做一次到期收口(best-effort; 失败不影响本次轮换结果)
    const expired = await expireStaleKeys({ actor: "system:refresh-service-key", actorType: "system" }).catch((err) => {
      console.error("[refresh-service-key] expireStaleKeys failed:", err?.message || err);
      return null;
    });

    return NextResponse.json({
      ok: true,
      service_name: serviceName,
      api_key: rotated.api_key,
      agentId,
      expires_at: rotated.expires_at,
      ttl_days: BUSINESS_KEY_TTL_DAYS,
      key_fp: rotated.key_fp,
      plaintext_cache_seconds: Math.floor(PLAINTEXT_CACHE_MS / 1000),
      expired_sweep: expired,
      note: "已轮换密钥并续期 90 天(旧 key 立即失效), 本次轮换已落 AuditLog(REFRESH_SERVICE_KEY)",
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
