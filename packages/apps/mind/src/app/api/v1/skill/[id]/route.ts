import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// 2026-10-25 R4: 单条技能详情判归属；无权限与"不存在"统一 404（防枚举，与 memory.provenance 同口径）
import { canRead } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";

// ===== SKILL-SPEC 2026-08-28 =====
// GET   /api/v1/skill/[id] - 技能详情 (含完整 steps, mcp skill_get 用)
// PATCH /api/v1/skill/[id] - 实践更新: 改 steps -> version+1; usageCount 手动核销

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const skill = await prisma.skill.findUnique({
    where: { id },
    include: {
      practiceSkillLinks: { include: { practice: { select: { id: true, title: true, outcome: true, createdAt: true } } }, take: 10, orderBy: { practice: { createdAt: "desc" } } },
    },
  });
  // 越权与不存在同一返回：不让 404/403 的差异成为"这条技能存在"的探测通道
  if (!skill || !canRead(who.actor, skill as any, "skill")) return NextResponse.json({ error: "skill not found" }, { status: 404 });
  return NextResponse.json({ skill });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const existing = await prisma.skill.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "skill not found" }, { status: 404 });

  const data: any = {};
  const newSteps = body.steps !== undefined ? String(body.steps).trim() : undefined;
  if (newSteps !== undefined) {
    if (newSteps.length < 30)
      return NextResponse.json({ error: "steps ≥30 字 (无 steps 不成 skill)" }, { status: 400 });
    data.content = newSteps;
    data.version = existing.version + 1; // 实践更新 -> 版本+1
    if (body.updateReason) data.staleReason = `[v${existing.version}->v${existing.version + 1}] ${body.updateReason}`;
    data.stale = false; // 更新后解除失效
  }
  if (body.trigger !== undefined) data.trigger = String(body.trigger).trim();
  if (body.verification !== undefined) data.verification = String(body.verification).trim();
  if (body.pitfalls !== undefined) data.pitfalls = String(body.pitfalls).trim();
  if (body.platforms !== undefined) data.platforms = String(body.platforms).trim();
  if (body.stale === true) {
    data.stale = true;
    data.staleReason = body.staleReason || "manual mark stale";
  }

  if (Object.keys(data).length === 0)
    return NextResponse.json({ error: "无可更新字段 (steps/trigger/verification/pitfalls/platforms/stale)" }, { status: 400 });

  const skill = await prisma.skill.update({ where: { id }, data });
  return NextResponse.json({ ok: true, skill });
}
