/**
 * POST /api/v1/agents/status — agent 生命周期状态变更的内部入口 (2026-10-15 round 78)
 *
 * 为什么有本端点:
 *   `scripts/fix-stale-agent-status.cjs` 原先用 better-sqlite3 **直连写** mind 生产库
 *   (`UPDATE AgentRegistry SET status='INACTIVE' ...`), 违反 scripts/DB-ACCESS-RULE.md §1
 *   ("除 mind 应用本身之外, 任何进程都不得以读写方式打开生产库") —— round 77 的写入口收敛漏了它。
 *   本端点把那次写承接进 mind; 脚本改为发 HTTP(见 scripts/lib/mind-service.cjs), 对生产库回归只读。
 *
 * 与相邻端点的分工:
 *   · `POST /api/v1/agents/seen`   —— **心跳**时间戳(last_seen_at/updated_at); 唯一写 last_seen_at 的入口
 *   · `POST /api/v1/agents/status` —— **生命周期状态**(status/updated_at); 本文件; **不碰 last_seen_at**
 *   把两件事分成两个字段/两个入口, 是 round 78 "让心跳读数可信" 的核心:
 *   status 不再被时间戳污染, last_seen_at 也不再表示"谁被判定过"。
 *
 * 刻意收窄的攻击面(比 adminProcedure 更窄, 只做存活判定需要的那一个动作):
 *   · 只允许 status ∈ {ACTIVE, INACTIVE} —— PENDING/REVOKED/DEPRECATED 属注册审批流,
 *     仍只能走 tRPC adminProcedure(approve/reject), 不由本端点开放。
 *   · channel === 'human' 的行**一律拒绝**(人类角色不参与心跳/失活判定)。
 *   · **不写** last_seen_at / 不写 profile / 不动 AgentServicePermission。
 *
 * 鉴权: X-API-Key = AgentServicePermission 的 service key(`@/server/lib/service-auth`,
 *   与 agents/seen、ingest、knowledge/usage 同一判据)。已知边界与那些端点一致:
 *   不校验 service_name, 任何一条 ACTIVE key 都能通过(见 service-auth.ts 的登记)。
 *
 * body: { agentId, status, reason? }
 * 返回: 200 { ok, agentId, from, status, changed, updated_at }
 *       400 入参不合法 / 401 鉴权失败 / 404 未注册 / 500 写入失败
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireServiceAuth } from "@/server/lib/service-auth";
import { recordAudit } from "@/server/lib/audit-log";

export const dynamic = "force-dynamic";

/** 本端点允许的取值: 只有存活判定的两个方向。 */
const ALLOWED = new Set(["ACTIVE", "INACTIVE"]);

export async function POST(req: NextRequest) {
  const auth = await requireServiceAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const body = await req.json().catch(() => ({} as any));
  const agentId = String(body?.agentId || "").trim();
  const status = String(body?.status || "").trim().toUpperCase();
  const reason = body?.reason ? String(body.reason).slice(0, 500) : null;

  if (!agentId) {
    return NextResponse.json({ ok: false, error: "missing agentId" }, { status: 400 });
  }
  if (!ALLOWED.has(status)) {
    return NextResponse.json(
      { ok: false, error: "status must be one of ACTIVE|INACTIVE (PENDING/REVOKED/DEPRECATED 走 admin approve/reject)" },
      { status: 400 },
    );
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
        { ok: false, error: "channel=human 不参与存活判定, 拒绝改状态" },
        { status: 400 },
      );
    }

    const from = reg.status || "PENDING";
    if (from === status) {
      return NextResponse.json({ ok: true, agentId, from, status, changed: false });
    }

    const now = new Date();
    // 只写 status + updated_at。**刻意不写 last_seen_at** —— 那一列只由 /agents/seen 写,
    //   否则 "最近在线" 会被状态机污染(这正是 round 78 要修的问题 A)。
    await prisma.agentRegistry.update({
      where: { agent_id: agentId },
      data: { status, updated_at: now },
    });

    // 生命周期留痕(与 approve/reject 同表同口径, 长期保留供审计)
    await recordAudit({
      entityType: "AGENT",
      entityId: agentId,
      action: status === "INACTIVE" ? "DEACTIVATE" : "REACTIVATE",
      actor: auth.agentId || "service_key",
      actorType: "service_key",
      before: JSON.stringify({ status: from }),
      after: JSON.stringify({ status }),
      metadata: { reason, via: "POST /api/v1/agents/status" },
    });

    return NextResponse.json({ ok: true, agentId, from, status, changed: true, updated_at: now.toISOString() });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: (e?.message || "status update failed").slice(0, 200) },
      { status: 500 },
    );
  }
}
