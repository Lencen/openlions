import { NextRequest, NextResponse } from "next/server";
import { readFileSync, appendFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/internal/agent-health-reset — 通道修好后重置某个 agent 的健康判据基线（2026-10-26）
 *
 * 背景：认领健康闸门判据是"近 1 小时认领 >= 6 且提交 = 0"就停派单，解除条件是"出现一次成功提交"，
 *   否则最长要等 60 分钟（旧认领滚出窗口）。实测代价：operator 的 openclaw 通道预算 bug 修好后，
 *   仍被 180s 时代留下的 6 认领/0 提交挡在门外，只能每 20 分钟 probation 试一次。
 * 本接口写一条 AGENT_HEALTH_RESET 事件，认领侧从该时刻起重新计数 —— 有审计、可追溯。
 *
 * 鉴权：本机共享 secret（run/internal-secret），与 /api/internal/exec 同口径。
 */
const SECRET_FILE = "~/lions/run/internal-secret";
const AUDIT = "~/lions/logs/mind-agent-health-reset.jsonl";

export async function POST(req: NextRequest) {
  let expected = "";
  try { expected = readFileSync(SECRET_FILE, "utf8").trim(); } catch { expected = ""; }
  if (!expected) return NextResponse.json({ ok: false, error: "internal-secret-missing" }, { status: 503 });
  if ((req.headers.get("x-internal-secret") || "").trim() !== expected) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({} as any));
  const agentId = String(body?.agentId || "").trim();
  const why = String(body?.why || "").trim().slice(0, 160);
  if (!agentId) return NextResponse.json({ ok: false, error: "agentId-required" }, { status: 400 });

  const ev = await prisma.flywheelEvent.create({
    data: {
      stage: "AGENT_HEALTH_RESET",
      sourceType: "operator",
      sourceId: agentId,
      sourceTitle: ("reset by=" + agentId + (why ? " why=" + why : "")).slice(0, 240),
      targetStage: "OK",
    },
  }).catch(() => null);
  if (!ev) return NextResponse.json({ ok: false, error: "write-failed" }, { status: 500 });
  try {
    appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), agentId, why }) + "\n");
  } catch { /* 审计失败不影响主路径 */ }
  return NextResponse.json({ ok: true, agentId, why });
}
