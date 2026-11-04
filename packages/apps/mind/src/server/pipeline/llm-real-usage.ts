import { prisma } from "@/lib/prisma";

/**
 * 真实 LLM 用量聚合 (2026-09-16 方案A Part2)
 * responder 每次大脑调用后 POST /api/v1/flywheel/agents/usage -> FlywheelEvent stage='LLM_USE_REAL'
 * (sourceTitle = {"calls":N,"tokens":M}); 本模块按 5h 窗口 SUM, 供 quota 接口与预算门使用。
 */
export async function realUsage5h(agentId?: string): Promise<{ totalCalls: number; byAgent: Record<string, number> }> {
  const since = new Date(Date.now() - 5 * 3600e3);
  const where: any = { stage: "LLM_USE_REAL", createdAt: { gte: since } };
  if (agentId) where.sourceId = agentId;
  const rows = await prisma.flywheelEvent.findMany({
    where,
    select: { sourceId: true, sourceTitle: true },
  });
  const byAgent: Record<string, number> = {};
  let totalCalls = 0;
  for (const r of rows) {
    let calls = 0;
    try {
      calls = Number(JSON.parse(String(r.sourceTitle || "{}")).calls || 0);
    } catch {}
    if (!(calls >= 0)) calls = 0;
    const a = String(r.sourceId || "unknown");
    byAgent[a] = (byAgent[a] || 0) + calls;
    totalCalls += calls;
  }
  return { totalCalls, byAgent };
}
