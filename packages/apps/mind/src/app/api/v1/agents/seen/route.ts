/**
 * POST /api/v1/agents/seen — 心跳回写 (2026-10-15 portal 写转发改造)
 *
 * 背景: portal 的 `/api/portal/heartbeat` 原先直连 `UPDATE AgentRegistry SET last_seen_at/updated_at`
 *   (第 3 个"portal 以读写身份持有 mind 生产库"的写点)。本端点承接该写, 由 mind 自己更新。
 *
 * 语义与 portal 原 UPDATE **逐字等价**: 同两个字段、同用"现在"的墙钟时间。
 *   (`updated_at` 虽是 Prisma @updatedAt, 仍显式写入 —— 与原 SQL 语义一致, 不依赖 ORM 隐式行为。)
 *
 * 鉴权: X-API-Key = AgentServicePermission 的 service key(见 @/server/lib/service-auth)。
 * body: { agentId }
 * 返回: 200 { ok, agentId, status, last_seen_at } / 400 缺参数 / 401 鉴权失败 / 404 未注册
 *   —— 404 与 portal heartbeat 的对外语义一致("agent not registered")。
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireServiceAuth } from "@/server/lib/service-auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireServiceAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  const body = await req.json().catch(() => ({} as any));
  const agentId = String(body?.agentId || "").trim();
  if (!agentId) {
    return NextResponse.json({ ok: false, error: "missing agentId" }, { status: 400 });
  }

  try {
    // 先查在不在: portal 原实现也是先 SELECT 再 UPDATE, 未注册 -> 404(而不是静默 0 行)
    const reg = await prisma.agentRegistry.findUnique({
      where: { agent_id: agentId },
      select: { agent_id: true, status: true },
    });
    if (!reg) {
      return NextResponse.json({ ok: false, error: "agent not registered" }, { status: 404 });
    }

    const now = new Date();
    await prisma.agentRegistry.update({
      where: { agent_id: agentId },
      data: { last_seen_at: now, updated_at: now },
    });

    return NextResponse.json({
      ok: true,
      agentId,
      status: reg.status || "PENDING",
      last_seen_at: now.toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: (e?.message || "seen update failed").slice(0, 200) },
      { status: 500 },
    );
  }
}
