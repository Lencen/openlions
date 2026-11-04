import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { planTierChanges } from "@/server/pipeline/memory-tier-policy";

// 2026-10-20 B2: 记忆分层 sweep。GET=只读计划，POST=执行（走 mind 应用自身 = 唯一写者，避免直连 sqlite）。
// 口径见 memory-tier-policy.ts（晋升 + 降级）。
export const dynamic = "force-dynamic";

async function plan(limit = 5000) {
  // asset-scope-exempt: 维护任务（tier 升降级判定需要全量；不对客户端返回内容）
  const rows = await prisma.memory.findMany({
    take: limit,
    where: { supersededBy: null },
    select: { id: true, tier: true, accessCount: true, lastAccessed: true, updatedAt: true, createdAt: true, importance: true },
    orderBy: { updatedAt: "desc" },
  });
  return planTierChanges(rows as any[], Date.now());
}

export async function GET() {
  const p = await plan();
  return NextResponse.json({ dryRun: true, promote: p.promote.length, demote: p.demote.length, unchanged: p.unchanged, sample: { promote: p.promote.slice(0, 5), demote: p.demote.slice(0, 5) } });
}

function adminOk(req: Request): boolean {
  const expected = process.env.MIND_ADMIN_API_KEY;
  if (!expected) return false;
  return (req.headers.get("x-admin-key") || "") === expected;
}

export async function POST(req: Request) {
  if (!adminOk(req)) return NextResponse.json({ error: "需要管理员凭据（x-admin-key）" }, { status: 401 });
  const p = await plan();
  let promoted = 0, demoted = 0;
  for (const to of ["HOT", "WARM", "COLD"] as const) {
    const idsP = p.promote.filter((x) => x.to === to).map((x) => x.id);
    const idsD = p.demote.filter((x) => x.to === to).map((x) => x.id);
    const ids = idsP.concat(idsD);
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const r = await prisma.memory.updateMany({ where: { id: { in: batch } }, data: { tier: to } });
      if (to === "HOT" || to === "WARM") promoted += r.count; else demoted += r.count;
    }
  }
  return NextResponse.json({ ok: true, promoted, demoted, unchanged: p.unchanged });
}
