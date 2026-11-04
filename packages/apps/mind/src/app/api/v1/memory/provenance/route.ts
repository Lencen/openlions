import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildProvenanceChain } from "@/server/pipeline/memory-provenance";
// 2026-10-23 R2-b: 单条读判归属；无权时按 404 处理（不泄露存在性）
import { canRead } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";

// 2026-10-20 B4: 记忆来源链（只读）。GET /api/v1/memory/provenance?id=<memoryId>
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const row = await prisma.memory.findUnique({
    where: { id },
    select: { id: true, title: true, summary: true, sourceType: true, sourceId: true,
      sourcePracticeId: true, supersededBy: true, supersededAt: true, createdAt: true,
      ownerAgentId: true, memoryScope: true },
  });
  // 越权与不存在返回同一个 404：避免"存在但你看不到"成为探测通道
  const memory = canRead(who.actor, row, "memory") ? row : null;
  if (!memory) return NextResponse.json({ error: "not found" }, { status: 404 });
  const practice = memory.sourcePracticeId
    ? await prisma.practice.findUnique({ where: { id: memory.sourcePracticeId }, select: { id: true, title: true, completedAt: true, createdAt: true } }).catch(() => null)
    : null;
  const events = await prisma.flywheelEvent.findMany({
    where: { OR: [{ sourceId: id }, { targetId: id }] },
    orderBy: { createdAt: "asc" }, take: 20,
    select: { id: true, stage: true, taskId: true, createdAt: true },
  }).catch(() => []);
  return NextResponse.json({ memoryId: id, chain: buildProvenanceChain({ memory, practice, events }) });
}
