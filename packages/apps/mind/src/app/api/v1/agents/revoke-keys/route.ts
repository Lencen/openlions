/**
 * POST /api/v1/agents/revoke-keys — 吊销"已确认失活身份"名下仍 ACTIVE 的服务 key
 *                                 (2026-10-21, spec:no-orphan-service-keys 治本配套)
 *
 * 为什么有本端点:
 *   守门 `scripts/check-orphan-service-keys.cjs` 2026-09-29 就有了, 但配套的**清理器**从未存在,
 *   而 `scripts/fix-stale-agent-status.cjs` 只降级(ACTIVE->INACTIVE)、**从不**吊销 key。
 *   结果: 身份一旦被判失活标成 INACTIVE, `AgentServicePermission.status` 就永久停在 ACTIVE,
 *   守门每轮 FAIL、计数只增不减(实测连续 13 次)。根因不是抖动, 是**机制缺一环**。
 *   本端点补上这一环: 由 `scripts/revoke-orphan-service-keys.cjs --apply` 调用。
 *
 * 与相邻端点的分工:
 *   · `POST /api/v1/agents/seen`   —— 心跳时间戳; **唯一**写 last_seen_at 的入口
 *   · `POST /api/v1/agents/status` —— 身份生命周期 status(ACTIVE/INACTIVE); **不碰** last_seen_at/权限
 *   · `POST /api/v1/agents/revoke-keys` —— **只**把 AgentServicePermission.status 置 REVOKED;
 *                                   **不改 AgentRegistry.status**, **不删行**
 *
 * 为什么不复用 tRPC `agent.revoke`(它会 REVOKED 整个身份):
 *   身份退役是**人的生命周期决策**(要撤谁、走审批、是否跨身份)。本端点只处理**凭据**这一层:
 *   身份已失活 -> 它的 key 不应继续有效, 但"这个身份是否永久退役"仍留给人判。
 *   与 `agent.revoke` 分工互补, 不冲突(两者都只会把更多凭据置失效, 方向一致)。
 *
 * 攻击面(比 adminProcedure 窄, 与 /agents/status 同级):
 *   · 只允许吊销 **ACTIVE** 的 key, 且只对**当前 status != ACTIVE** 的身份
 *     (即只处理"孤儿 key"本身; ACTIVE 身份的正常退役仍走 tRPC admin approve/revoke)。
 *   · channel === 'human' 的行**一律拒绝**(人类角色不参与心跳/失活判定)。
 *   · **不删行**: 保留审计痕迹, 人工可改回 ACTIVE。
 *   · 幂等: 无 ACTIVE key 可吊销时 changed=false, 200。
 *
 * 鉴权: X-API-Key = AgentServicePermission 的 service key(`@/server/lib/service-auth`)。
 *
 * body: { agentId, serviceNames?: string[], reason? }
 * 返回: 200 { ok, agentId, from, status, revoked, changed, revoked_at }
 *       400 入参不合法 / 401 鉴权失败 / 404 未注册 / 500 写入失败
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireServiceAuth } from "@/server/lib/service-auth";
import { recordAudit } from "@/server/lib/audit-log";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireServiceAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const body = await req.json().catch(() => ({} as any));
  const agentId = String(body?.agentId || "").trim();
  const serviceNames: string[] = Array.isArray(body?.serviceNames)
    ? body.serviceNames.map((s: unknown) => String(s).trim()).filter(Boolean)
    : [];
  const reason = body?.reason ? String(body.reason).slice(0, 500) : null;

  if (!agentId) {
    return NextResponse.json({ ok: false, error: "missing agentId" }, { status: 400 });
  }

  try {
    const reg = await prisma.agentRegistry.findUnique({
      where: { agent_id: agentId },
      select: { agent_id: true, status: true, channel: true },
    });
    if (!reg) {
      return NextResponse.json({ ok: false, error: "agent not registered" }, { status: 404 });
    }
    if (reg.channel === "human") {
      return NextResponse.json(
        { ok: false, error: "channel=human 不参与失活判定, 拒绝吊销其凭据" },
        { status: 400 },
      );
    }
    // 只处理"孤儿 key": 身份已非 ACTIVE。ACTIVE 身份的正常退役走 tRPC agent.revoke(adminProcedure)。
    if (reg.status === "ACTIVE") {
      return NextResponse.json(
        { ok: false, error: "agent is ACTIVE; 用 tRPC agent.revoke(adminProcedure) 退役身份, 本端点只处理孤儿 key" },
        { status: 400 },
      );
    }

    const where: any = { agent_id: agentId, status: "ACTIVE" };
    if (serviceNames.length > 0) where.service_name = { in: serviceNames };

    const targets = await prisma.agentServicePermission.findMany({
      where,
      select: { service_name: true },
    });

    if (targets.length === 0) {
      return NextResponse.json({ ok: true, agentId, from: reg.status, status: reg.status, revoked: 0, changed: false });
    }

    const now = new Date();
    // 只置 REVOKED, **不删行**(保留审计痕迹, 人工可改回)。
    const upd = await prisma.agentServicePermission.updateMany({
      where,
      data: { status: "REVOKED", updated_at: now },
    });

    await recordAudit({
      entityType: "AGENT",
      entityId: agentId,
      action: "REVOKE_SERVICE_KEYS",
      actor: auth.agentId || "service_key",
      actorType: "service_key",
      before: JSON.stringify({ registry_status: reg.status, keys: targets.map((t) => t.service_name) }),
      after: JSON.stringify({ key_status: "REVOKED", revoked: upd.count }),
      metadata: { reason, via: "POST /api/v1/agents/revoke-keys" },
    });

    return NextResponse.json({
      ok: true,
      agentId,
      from: reg.status,
      status: reg.status,
      revoked: upd.count,
      services: targets.map((t) => t.service_name),
      changed: true,
      revoked_at: now.toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: (e?.message || "key revoke failed").slice(0, 200) },
      { status: 500 },
    );
  }
}