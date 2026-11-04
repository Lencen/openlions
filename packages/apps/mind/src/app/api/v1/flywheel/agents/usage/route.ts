import { prisma } from "@/lib/prisma";

/**
 * POST /api/v1/flywheel/agents/usage — 各终端 responder 上报**真实 LLM 调用** (2026-09-16 方案A Part2)
 *
 * 背景: 平台 quota 原按平台自记 CALL_LLM 事件(近5h 100-183 次), 与真实 MiniMax 用量(近5h 4800 次)
 *   严重脱节 -> responder 认领时以为预算充足, 实际 5h/6000 次配额被 agentic 循环烧穿。
 *   修法: responder 每次大脑调用后 POST { agentId, calls, tokens }, 平台落 FlywheelEvent
 *   stage='LLM_USE_REAL'; quota 接口按 5h 窗口 SUM 真实调用数, 供认领前预算门使用。
 *
 * Body: { agentId: "agent-e", calls: 1, tokens: 1234 }
 */
export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const agentId = String(body.agentId || "").trim();
  const calls = Number(body.calls || 0);
  const tokens = Number(body.tokens || 0);
  if (!agentId || !(calls >= 0) || !(tokens >= 0)) {
    return Response.json({ ok: false, error: "agentId/calls/tokens required" }, { status: 400 });
  }
  try {
    await prisma.flywheelEvent.create({
      data: {
        stage: "LLM_USE_REAL",
        sourceType: "agent:" + agentId,
        sourceId: agentId,
        sourceTitle: JSON.stringify({ calls, tokens }),
        targetStage: "OK",
      },
    });
    return Response.json({ ok: true, recorded: { agentId, calls, tokens } });
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e).slice(0, 120) }, { status: 500 });
  }
}

