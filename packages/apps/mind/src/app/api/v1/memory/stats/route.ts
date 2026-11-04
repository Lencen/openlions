import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// 2026-10-23 R2-b: 统计里的 Memory 口径按归属过滤（其余表的归属列待 R5 迁移）
import { readableWhere, scopeSqlFragment } from "@/server/pipeline/asset-scope";
import { resolveRequestActor } from "@/server/lib/request-actor";

// 2026-10-15 round-78: 本路由读**实时**库统计(count/aggregate), 不是编译期常量。
//   无参 GET 且无 dynamic 声明 -> Next 在 build 期预渲染并**永不重验**(实测 .next/prerender-manifest.json
//   里 initialRevalidateSeconds:false; HTTP 出 x-nextjs-cache: HIT) -> 长期返回编译时刻快照。
//   口径跟随平台既有的读库实时路由 /api/health/db、/api/v1/rbac、/api/v1/org (均为 force-dynamic)。
export const dynamic = "force-dynamic";

// 质量分桶: high >= 0.7 / mid >= 0.4 / low < 0.4
function bucketize(counts: { high: number; mid: number; low: number }) {
  return counts;
}

export async function GET(req: NextRequest) {
  const who = await resolveRequestActor(req);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: who.status });
  const scope = readableWhere(who.actor, { kind: "memory" });
  const inScope = Object.keys(scope).length ? { AND: [scope] } : {};

  const [memory, knowledge, practice, reflection, skill, topics, emptyHash] = await Promise.all([
    prisma.memory.count({ where: inScope }),
    prisma.knowledge.count().catch(() => 0),
    prisma.practice.count().catch(() => 0),
    prisma.reflection.count().catch(() => 0),
    // 遗留#12 (2026-09-01): skill 计数排除 legacy (22888 条无内容历史垃圾, 只统计有效技能)
    prisma.skill.count({ where: { legacy: false } }).catch(() => 0),
    prisma.memoryTopic.aggregate({ _avg: { coverageScore: true }, _count: true }),
    prisma.memory.count({ where: { contentHash: { equals: "" }, ...inScope } }),
  ]);

  // Coverage distribution
  const coverageBuckets = { "0-0.2": 0, "0.2-0.4": 0, "0.4-0.6": 0, "0.6-0.8": 0, "0.8-1.0": 0 };
  const allTopics = await prisma.memoryTopic.findMany({ select: { coverageScore: true } });
  for (const t of allTopics) {
    const s = t.coverageScore || 0;
    if (s < 0.2) coverageBuckets["0-0.2"]++;
    else if (s < 0.4) coverageBuckets["0.2-0.4"]++;
    else if (s < 0.6) coverageBuckets["0.4-0.6"]++;
    else if (s < 0.8) coverageBuckets["0.6-0.8"]++;
    else coverageBuckets["0.8-1.0"]++;
  }

  // 质量分布 (2026-08-28 P1.4): 按 qualityScore 桶统计, 供看板"数据质量"维度
  // Memory/Knowledge/Practice/Skill 用 qualityScore, Reflection 用 score
  const qualityDist = async (model: string, field: string, extraWhere = "") => {
    try {
      const conds = ["supersededBy IS NULL", extraWhere].filter(Boolean);
      const rows = await prisma.$queryRawUnsafe<{ bucket: string; n: bigint }[]>(
        `SELECT CASE WHEN ${field} >= 0.7 THEN 'high' WHEN ${field} >= 0.4 THEN 'mid' ELSE 'low' END AS bucket, COUNT(*) AS n
         FROM ${model} WHERE ${conds.join(" AND ")} GROUP BY bucket`
      );
      const out = { high: 0, mid: 0, low: 0 };
      for (const r of rows) {
        const k = r.bucket as "high" | "mid" | "low";
        out[k] = Number(r.n);
      }
      return out;
    } catch {
      return { high: 0, mid: 0, low: 0 };
    }
  };

  const [memoryQ, knowledgeQ, practiceQ, skillQ, reflectionQ] = await Promise.all([
    qualityDist("Memory", "qualityScore", scopeSqlFragment(who.actor, "memory")),
    qualityDist("Knowledge", "qualityScore"),
    qualityDist("Practice", "qualityScore"),
    qualityDist("Skill", "qualityScore"),
    qualityDist("Reflection", "score"),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      tables: { memory, knowledge, practice, reflection, skill },
      topics: { total: topics._count, avgCoverage: topics._avg.coverageScore || 0 },
      quality: {
        emptyHash,
        emptySourceType: 0,
        memory: bucketize(memoryQ),
        knowledge: bucketize(knowledgeQ),
        practice: bucketize(practiceQ),
        skill: bucketize(skillQ),
        reflection: bucketize(reflectionQ),
      },
      coverageDistribution: coverageBuckets,
    },
  });
}
