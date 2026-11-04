import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// 2026-10-20 C1d: 产能与成本的只读聚合（console「平台管理 → 运营看板」消费）。
// 口径与 scripts/lions-capacity / lions-llm-failure-report 一致；时间戳为 epoch 毫秒。
export const dynamic = "force-dynamic";

export async function GET() {
  const now = Date.now();
  const since = now - 24 * 3600 * 1000;
  const q = async (sql: string, ...p: unknown[]): Promise<any[]> => {
    try { return (await prisma.$queryRawUnsafe(sql, ...p)) as any[]; } catch { return []; }
  };
  const [backlog, never, created, completed, inProgress, fails, agents] = await Promise.all([
    q(`SELECT COUNT(*) c FROM Task WHERE status='PENDING'`),
    q(`SELECT COUNT(*) c FROM Task t WHERE t.status='PENDING' AND NOT EXISTS(SELECT 1 FROM TaskExecution e WHERE e.taskId=t.id)`),
    q(`SELECT COUNT(*) c FROM Task WHERE createdAt >= ?`, since),
    q(`SELECT COUNT(*) c FROM Task WHERE status='DONE' AND completedAt >= ?`, since),
    q(`SELECT COUNT(*) c FROM Task WHERE status='IN_PROGRESS'`),
    q(`SELECT targetStage, COUNT(*) n FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt >= ? GROUP BY targetStage`, since),
    q(`SELECT agent_id, status, last_seen_at FROM AgentRegistry`),
  ]);
  const num = (rows: any[]) => Number(rows?.[0]?.c ?? 0);
  const calls = fails.reduce((s, r) => s + Number(r.n), 0);
  const ok = fails.filter((r) => r.targetStage === "OK").reduce((s, r) => s + Number(r.n), 0);
  const createdN = num(created), completedN = num(completed);
  return NextResponse.json({
    asOf: new Date(now).toISOString(),
    window: "24h",
    capacity: {
      backlog: num(backlog), neverClaimed: num(never), created: createdN, completed: completedN,
      netBacklogDelta: createdN - completedN,
      throughputPerHour: +(completedN / 24).toFixed(2),
      inProgress: num(inProgress),
    },
    llm: { calls, ok, failRate: calls ? +((calls - ok) / calls).toFixed(3) : null, modes: fails.map((r) => ({ mode: r.targetStage || "(null)", n: Number(r.n) })) },
    agents: agents.map((a) => ({ agentId: a.agent_id, status: a.status, lastSeen: a.last_seen_at == null ? null : Number(a.last_seen_at) })),
  });
}
