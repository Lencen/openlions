import { NextRequest, NextResponse } from "next/server";
import { getPlatformPolicy } from "@/server/pipeline/asset-policy";
import { resolveRequestActor } from "@/server/lib/request-actor";

// GET /api/v1/asset-policy/stats —— 策略诊断视图（root_admin，2026-10-26）
//
// 回答管理端最关心的三个问题：
//   1) 三类资产现在分别有多少行、多少行无主（= 切 private 后仍会保持公共的 grandfather 部分）；
//   2) 有主行的可见性分布（是否与当前平台策略一致）；
//   3) 哪些 agent 声明了数据策略、各自拥有多少行。
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TABLES: Record<string, { table: string; vis: string }> = {
  memory: { table: "Memory", vis: "memoryScope" },
  knowledge: { table: "Knowledge", vis: "visibility" },
  skill: { table: "Skill", vis: "visibility" },
};

export async function GET(req: NextRequest) {
  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ ok: false, error: who.error }, { status: who.status });
  const isAdmin = who.rootAdmin || (who.actor && who.actor.role === "OWNER");
  if (!isAdmin) return NextResponse.json({ ok: false, error: "forbidden: root_admin required" }, { status: 403 });

  // 延迟导入：构建/质检脚本的模块扫描不应该因为读不到 MIND_DATABASE_URL 而崩（与 POST 路由同口径）
  const { prisma } = await import("@/lib/prisma");
  const platform = await getPlatformPolicy(true);
  const kinds: any = {};
  for (const [k, cfg] of Object.entries(TABLES)) {
    const total = (await prisma.$queryRawUnsafe<any[]>('SELECT count(*)::int n FROM "' + cfg.table + '" WHERE "supersededBy" IS NULL'))[0].n;
    const ownerless = (await prisma.$queryRawUnsafe<any[]>('SELECT count(*)::int n FROM "' + cfg.table + '" WHERE "supersededBy" IS NULL AND "ownerAgentId" IS NULL'))[0].n;
    const byVis = await prisma.$queryRawUnsafe<any[]>(
      'SELECT coalesce("' + cfg.vis + '",\'(null)\') v, count(*)::int n FROM "' + cfg.table + '" WHERE "supersededBy" IS NULL AND "ownerAgentId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC');
    const byOwner = await prisma.$queryRawUnsafe<any[]>(
      'SELECT "ownerAgentId" o, count(*)::int n FROM "' + cfg.table + '" WHERE "supersededBy" IS NULL AND "ownerAgentId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 20');
    kinds[k] = {
      platformMode: platform[k as keyof typeof platform],
      total,
      ownerless,
      owned: total - ownerless,
      ownedVisibility: byVis,
      ownedByAgent: byOwner,
      // 切 private 后仍会保持公共的行数（grandfather 代价）
      grandfatheredIfPrivate: ownerless,
    };
  }

  let agentPolicies: any[] = [];
  try {
    agentPolicies = await prisma.$queryRawUnsafe<any[]>(
      "SELECT agent_id, memory_mode, knowledge_mode, skill_mode, accepted_at FROM agent_data_policy ORDER BY accepted_at DESC LIMIT 100");
  } catch { /* 表不存在时忽略 */ }

  return NextResponse.json({ ok: true, platform, kinds, agentPolicies, generatedAt: new Date().toISOString() });
}
