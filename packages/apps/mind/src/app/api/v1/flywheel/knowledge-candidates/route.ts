import { NextRequest, NextResponse } from "next/server";
import { resolveActor } from "@/server/pipeline/actor";
import { prisma } from "@/lib/prisma";
import { rangeSince } from "@/lib/range";
// 2026-10-25 R4 收口: 该接口返回 knowledge 正文，此前无归属过滤
import { readableWhere } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";

export const dynamic = "force-dynamic";

/**
 * 2026-09-10 质量治理: agent 产出候选区 (agent 结论不再直接当正式知识)
 *  GET  /api/v1/flywheel/knowledge-candidates?limit=20&status=PENDING_REVIEW
 *  POST /api/v1/flywheel/knowledge-candidates  { id, action: "verify" | "reject", by?: string, reason?: string }
 *  转正(verify): verification=VERIFIED + humanConfirmed=true -> 可被 contextSeed 注入 / 参与飞轮
 *  否决(reject): stale=true + staleReason -> 不再注入; 否决理由写回事件供提交 agent 学习
 *  人类操作(by 以 human 开头) 额外记 HUMAN_INTERVENTION, 保证自主率指标诚实。
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 20)));
  const status = url.searchParams.get("status") || "PENDING_REVIEW";
  // 2026-10-13 round 76-DD: **opt-in** 时间窗(③) —— 只有显式传 ?range= 才按 createdAt 过滤(与全局筛选口径一致)。
  const rf = rangeSince(url.searchParams.get("range"));
  const baseWhere: any = status === "ALL"
    ? { sourceType: "AGENT_OUTPUT" }
    : { sourceType: "AGENT_OUTPUT", verification: status };
  if (rf) baseWhere.createdAt = { gte: rf };
  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ ok: false, error: who.error }, { status: who.status });
  const scoped = readableWhere(who.actor, { kind: "knowledge" });
  if (Object.keys(scoped).length) baseWhere.AND = [...(baseWhere.AND ?? []), scoped];
  const rows = await prisma.knowledge.findMany({
    where: baseWhere,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, title: true, content: true, qualityScore: true, confidence: true, verification: true, humanConfirmed: true, agentSource: true, theme: true, sourceId: true, stale: true, staleReason: true, createdAt: true },
  });
  // 计数与列表同口径（否则"列表 3 条、待审 200"会让人怀疑数据丢了）
  const andScope = Object.keys(scoped).length ? { AND: [scoped] } : {};
  const pending = await prisma.knowledge.count({ where: { sourceType: "AGENT_OUTPUT", verification: "PENDING_REVIEW", stale: false, ...andScope } });
  const verified = await prisma.knowledge.count({ where: { sourceType: "AGENT_OUTPUT", verification: "VERIFIED", ...andScope } });
  const rejected = await prisma.knowledge.count({ where: { sourceType: "AGENT_OUTPUT", stale: true, ...andScope } });
  return NextResponse.json({ ok: true, pending, verified, rejected, rows });
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }
  const id = String(body.id || "");
  const action = String(body.action || "");
  const by = String(body.by || "unknown");
  const reason = String(body.reason || "").slice(0, 500);
  if (!id || !["verify", "reject"].includes(action)) return NextResponse.json({ ok: false, error: "need id + action(verify|reject)" }, { status: 400 });
  const row = await prisma.knowledge.findUnique({ where: { id }, select: { id: true, sourceType: true, title: true, sourceId: true, qualityScore: true } });
  if (!row) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (action === "verify") {
    await prisma.knowledge.update({ where: { id }, data: { verification: "VERIFIED", humanConfirmed: true, confidence: Math.max(0.8, Number(row.qualityScore ?? 0.8)), stale: false, staleReason: null } });
  } else {
    await prisma.knowledge.update({ where: { id }, data: { stale: true, staleReason: ("复核否决(" + by + "): " + reason).slice(0, 300), verification: "REJECTED" } });
  }
  await prisma.flywheelEvent.create({
    data: {
      stage: action === "verify" ? "KNOWLEDGE_VERIFIED" : "KNOWLEDGE_REJECTED",
      sourceType: "knowledge-candidates",
      sourceId: id,
      sourceTitle: (by + " " + (row.title || "").slice(0, 80) + (reason ? " | " + reason : "")).slice(0, 300),
      targetStage: action === "verify" ? "OK" : "REJECTED",
    },
  }).catch(() => null);
  // 2026-09-11: 同 todos —— 自称 human 但未声明 x-actor-kind 的按程序化处理并留审计(见 actor.ts)
  const actor = resolveActor(req, by);
  if (actor.isHuman) {
    await prisma.flywheelEvent.create({ data: { stage: "HUMAN_INTERVENTION", sourceType: "knowledge-review", sourceId: id, sourceTitle: (action + " by " + actor.actor).slice(0, 200), targetStage: "OK" } }).catch(() => null);
  } else if (actor.mislabeled) {
    await prisma.flywheelEvent.create({ data: { stage: "ACTOR_MISLABELED", sourceType: "knowledge-review", sourceId: id, sourceTitle: ("自称人类但未声明 x-actor-kind: human -> 按 " + actor.kind + " 计: " + actor.actor + " " + action).slice(0, 240), targetStage: "OK" } }).catch(() => null);
  }
  return NextResponse.json({ ok: true, id, action, by });
}