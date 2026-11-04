import { NextRequest, NextResponse } from "next/server";
// 2026-10-15 钥匙治理(item 1): 领取券换取正式业务钥匙的 HTTP 入口(装机脚本/curl/手册用)。
//   与 tRPC `agent.claimServiceKey` 共用同一实现(`redeemClaimTicket`), 不存在第二份签发逻辑。
import { redeemClaimTicket, BUSINESS_KEY_TTL_DAYS, isClaimTicket } from "@/server/lib/key-governance";

/**
 * POST /api/v1/agent/claim-service-key — 用**一次性领取券**换正式业务钥匙 (2026-10-15 钥匙治理)
 *
 * 背景: 注册/审批不再直发长期业务钥匙, 只发一张 `sk-claim-<64hex>` 领取券(默认 15 分钟、绑定 agent_id)。
 *   本端点就是"换一次"的入口: 换取成功后券**立即作废**(整串 CAS, 并发第二发必然失败), 业务钥匙
 *   (默认 90 天)只在本次响应里出现一次。
 *
 * 鉴权: **无需任何既有钥匙** —— 券本身就是凭据(调用者此刻还没有业务钥匙, 这正是本端点的用途)。
 *       券值请放 body(不要放 query string: 会进访问日志)。
 *
 * body: { agent_id: "agent-xxx", ticket: "sk-claim-...", reuse_existing?: true }
 *   · reuse_existing(默认 true) = 对**已存在且明文仍可读**的 ACTIVE 钥匙沿用(不轮换),
 *     这样"重装/换机"不会把在跑的客户端打断; 需要强制轮换时传 false。
 *
 * 响应: { ok:true, services: { <name>: { status, api_key, endpoint, expires_at, ... } } }
 *   status ∈ issued(新签发/轮换) | reused(沿用既有) | skipped(该服务已撤销或未启用) | failed
 *
 * 失败语义:
 *   401/403 券无效、已被换取、已作废、或已过期(不区分原因, 防枚举) —— code 字段给出可读原因
 *   404     身份不存在
 *   409     并发换取冲突(券仍有效, 直接重试)
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // 一次性读 body 再 parse: 不做"先 req.json() 再兜底 req.text()"那种二次读(流已被消费, 兜底永远拿不到)。
    let body: any = null;
    try { body = JSON.parse(await req.text()); } catch { body = null; }
    const agentId = String((body && body.agent_id) || "").trim();
    const ticket = String((body && body.ticket) || "").trim();
    const reuseExisting = body && body.reuse_existing === false ? false : true;
    if (!agentId || !ticket) {
      return NextResponse.json({ ok: false, error: "需要 body: { agent_id, ticket }" }, { status: 400 });
    }
    if (!isClaimTicket(ticket)) {
      return NextResponse.json({ ok: false, error: "ticket 格式不对(应为 sk-claim-…): 请用管理员下发的**领取券**, 不是业务钥匙" }, { status: 400 });
    }

    const res = await redeemClaimTicket({
      agentId,
      ticket,
      actor: agentId,
      actorType: "agent_self",
      reuseWhenPossible: reuseExisting,
    });

    if (!res.ok) {
      const code = res.code === "NOT_FOUND" ? 404 : res.code === "CONFLICT" ? 409 : 403;
      return NextResponse.json({ ok: false, code: res.code, error: res.message }, { status: code });
    }

    return NextResponse.json({
      ok: true,
      agent_id: res.agent_id,
      ticket_hash8: res.ticket_hash8,
      redeemed_at: res.redeemed_at,
      business_key_ttl_days: res.business_key_ttl_days ?? BUSINESS_KEY_TTL_DAYS,
      services: res.services,
      warning: "券已作废(一次性); 上方 api_key 明文只出现这一次, 请立即落盘(mode 0600)。",
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
