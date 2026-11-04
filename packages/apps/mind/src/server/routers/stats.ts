import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
// 2026-09-23 uos20 #8: Skills 成功率 (与提取 pipeline 共用同一口径纯函数, 避免两处公式漂移)
import { computeSkillSuccessRate } from "../pipeline/skill-success-rate";

export const statsRouter = createRouter({
  getOverview: publicProcedure.query(async () => {
    const [
      learningPaths,
      learningMilestones,
      memories,
      knowledge,
      reflections,
      skills,
      practices,
      outputs,
      flywheelEvents,
    ] = await Promise.all([
      prisma.learningPath.count(),
      prisma.milestone.count({ where: { status: "COMPLETED" } }),
      prisma.memory.count(),
      prisma.knowledge.count(),
      prisma.reflection.count(),
      prisma.skill.count(),
      prisma.practice.count(),
      prisma.output.count(),
      prisma.flywheelEvent.count(),
    ]);

    const hotMemories = await prisma.memory.count({ where: { tier: "HOT" } });
    const resolvedReflections = await prisma.reflection.count({ where: { status: "RESOLVED" } });
    const successfulPractices = await prisma.practice.count({ where: { outcome: "SUCCESS" } });
    const exceptionalOutputs = await prisma.output.count({ where: { quality: "EXCEPTIONAL" } });
    const advancedSkills = await prisma.skill.count({ where: { level: { in: ["ADVANCED", "EXPERT"] } } });
    const avgQuality = await prisma.output.aggregate({ _avg: { qualityScore: true } });
    const avgReflectionScore = await prisma.reflection.aggregate({ _avg: { score: true } });

    return {
      learning: { total: learningPaths, completedMilestones: learningMilestones },
      memory: { total: memories, hot: hotMemories },
      knowledge: { total: knowledge },
      reflection: { total: reflections, resolved: resolvedReflections, avgScore: avgReflectionScore._avg.score ?? 0 },
      skills: { total: skills, advanced: advancedSkills },
      practice: { total: practices, successful: successfulPractices, successRate: practices > 0 ? Math.round((successfulPractices / practices) * 100) : 0 },
      portfolio: { total: outputs, exceptional: exceptionalOutputs, avgQuality: avgQuality._avg.qualityScore ?? 0 },
      flywheel: { totalEvents: flywheelEvents },
    };
  }),

  getGrowthTrend: publicProcedure.input(z.object({ days: z.number().default(30) })).query(async ({ input }) => {
    const since = new Date();
    since.setDate(since.getDate() - input.days);
    const sinceStr = since.toISOString().slice(0, 10);

    const [memories, knowledge, practices, outputs] = await Promise.all([
      (prisma as any).$queryRaw`SELECT DATE(createdAt) as createdAt, COUNT(*) + 0 as _count FROM Memory WHERE createdAt >= ${sinceStr} GROUP BY DATE(createdAt) ORDER BY createdAt`,
      (prisma as any).$queryRaw`SELECT DATE(createdAt) as createdAt, COUNT(*) + 0 as _count FROM Knowledge WHERE createdAt >= ${sinceStr} GROUP BY DATE(createdAt) ORDER BY createdAt`,
      (prisma as any).$queryRaw`SELECT DATE(createdAt) as createdAt, COUNT(*) + 0 as _count FROM Practice WHERE createdAt >= ${sinceStr} GROUP BY DATE(createdAt) ORDER BY createdAt`,
      (prisma as any).$queryRaw`SELECT DATE(createdAt) as createdAt, COUNT(*) + 0 as _count FROM Output WHERE createdAt >= ${sinceStr} GROUP BY DATE(createdAt) ORDER BY createdAt`,
    ]);

    // Convert BigInt to Number for JSON serialization
    const convert = (rows: { createdAt: string; _count: bigint }[]) =>
      rows.map(r => ({ createdAt: r.createdAt, _count: Number(r._count) }));

    return { memories: convert(memories), knowledge: convert(knowledge), practices: convert(practices), outputs: convert(outputs) };
  }),

  // ===== 2026-09-23 uos20 #8 Skills 成功率统计 (轻量版, 按日粒度) =====
  // 口径: 生成即成功。窗口内
  //   分子 skillsCreated   = 新建 Skill 行数 (过 SKILL-SPEC, 落 Skill 表)
  //   降级 skillsDowngraded = 新建 Knowledge 行且 tags 含 skill-downgraded (无 steps 的技能候选)
  //   分母 skillCandidatesTotal = skillsCreated + skillsDowngraded
  // 两位小数 + 原始分子分母; 无候选时 rate=null。独立于 totalRecordsCreated。
  // 注: 这是持久化侧(历史可复算)的近似口径 —— Skill 同名 upsert 更新不产生新行, 故与
  //     提取 pipeline 单次 run 的 skillsCreated(含更新)略有差异; 单次 run 的精确口径见
  //     PipelineReport.skillSuccess。两者共用 computeSkillSuccessRate 公式。
  getSkillSuccessRate: publicProcedure.input(z.object({ days: z.number().min(1).max(3650).default(30) })).query(async ({ input }) => {
    const sinceMs = Date.now() - input.days * 24 * 60 * 60 * 1000;
    const rows = await prisma.$queryRawUnsafe<Array<{ day: string | null; created: bigint | number; downgraded: bigint | number }>>(
      `SELECT day, SUM(created) AS created, SUM(downgraded) AS downgraded FROM (
         SELECT strftime('%Y-%m-%d', createdAt/1000, 'unixepoch') AS day, COUNT(*) AS created, 0 AS downgraded
           FROM Skill WHERE createdAt >= ? GROUP BY day
         UNION ALL
         SELECT strftime('%Y-%m-%d', createdAt/1000, 'unixepoch') AS day, 0 AS created, COUNT(*) AS downgraded
           FROM Knowledge WHERE createdAt >= ? AND tags LIKE '%skill-downgraded%' GROUP BY day
       ) GROUP BY day ORDER BY day`,
      sinceMs, sinceMs,
    );
    const byDay = (rows || []).map((r) => {
      const created = Number(r.created || 0);
      const downgraded = Number(r.downgraded || 0);
      return { day: r.day, ...computeSkillSuccessRate(created, downgraded) };
    });
    const created = byDay.reduce((s, r) => s + r.skillsCreated, 0);
    const downgraded = byDay.reduce((s, r) => s + r.skillsDowngraded, 0);
    return {
      windowDays: input.days,
      since: new Date(sinceMs).toISOString(),
      criterion: "generated==success (SKILL-SPEC steps>=30); denominator = candidates",
      overall: computeSkillSuccessRate(created, downgraded),
      byDay,
    };
  }),

  getActivityFeed: publicProcedure.input(z.object({ limit: z.number().default(50) })).query(async ({ input }) => {
    return prisma.flywheelEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: input.limit,
    });
  }),

  getFlywheelHealth: publicProcedure.query(async () => {
    const totalReflections = await prisma.reflection.count();
    const totalMemories = await prisma.memory.count();
    const totalKnowledge = await prisma.knowledge.count();
    const totalPractices = await prisma.practice.count();
    const totalOutputs = await prisma.output.count();

    const evaluatedPractices = await prisma.practiceEvaluation.count();
    const practicesWithKnowledge = await prisma.practiceKnowledgeLink.groupBy({ by: ["practiceId"] });

    return {
      stages: [
        { name: "LEARN", label: "学习", status: "healthy", value: "active" },
        { name: "REFLECT", label: "反思", status: totalReflections > 0 ? "healthy" : "empty", value: totalReflections },
        { name: "MEMORIZE", label: "记忆", status: totalMemories > 0 ? "healthy" : "empty", value: totalMemories },
        { name: "KNOWLEDGE", label: "知识", status: totalKnowledge > 0 ? "healthy" : "empty", value: totalKnowledge },
        { name: "PRACTICE", label: "实践", status: totalPractices > 0 ? "healthy" : "empty", value: totalPractices },
        { name: "OUTCOME", label: "产出", status: totalOutputs > 0 ? "healthy" : "empty", value: totalOutputs },
        { name: "EVALUATE", label: "评估", status: evaluatedPractices > 0 ? "healthy" : "empty", value: evaluatedPractices },
      ],
      transitionRates: {
        knowledgeApplication: totalPractices > 0 ? Math.round((practicesWithKnowledge.length / totalPractices) * 100) : 0,
        evaluationRate: totalPractices > 0 ? Math.round((evaluatedPractices / totalPractices) * 100) : 0,
      },
    };
  }),

  getSkillRadar: publicProcedure.query(async () => {
    const skills = await prisma.skill.groupBy({
      by: ["category"],
      _avg: { selfAssessment: true },
    });

    return skills.map((s) => ({
      category: s.category,
      level: Math.round((s._avg.selfAssessment ?? 0) * 10) / 10,
    }));
  }),

  // 2026-06-06 SHARED-BRAIN-V2 P0-23a: Agent 活跃度
  // 返 3 个核心指标:
  //   - 24h 内每个 agentSource 的 remember 次数 (来自 Memory.agentSource, 写入次数)
  //   - HOT 记忆按 agentSource 分布饼图
  //   - 总记忆按 agentSource 分布
  // 注: recall 次数 SDK 端目前用 process metrics 跟踪 (暂未落库), 后续 P1 加 AccessLog 表
  agentActivity: publicProcedure.query(async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 1. 24h 内每个 agent 写入次数
    const writes24hRaw = await prisma.memory.groupBy({
      by: ["agentSource"],
      where: {
        createdAt: { gte: dayAgo },
        agentSource: { not: null },
      },
      _count: { id: true },
    });
    const writes24h = writes24hRaw
      .map((w) => ({ agent: w.agentSource || "UNKNOWN", count: w._count.id }))
      .sort((a, b) => b.count - a.count);

    // 2. HOT 记忆按 agentSource 分布
    const hotByAgentRaw = await prisma.memory.groupBy({
      by: ["agentSource"],
      where: { tier: "HOT", agentSource: { not: null } },
      _count: { id: true },
    });
    const hotByAgent = hotByAgentRaw
      .map((w) => ({ agent: w.agentSource || "UNKNOWN", count: w._count.id }))
      .sort((a, b) => b.count - a.count);

    // 3. 总记忆按 agentSource 分布
    const totalByAgentRaw = await prisma.memory.groupBy({
      by: ["agentSource"],
      where: { agentSource: { not: null } },
      _count: { id: true },
    });
    const totalByAgent = totalByAgentRaw
      .map((w) => ({ agent: w.agentSource || "UNKNOWN", count: w._count.id }))
      .sort((a, b) => b.count - a.count);

    // 总条数 (供前端百分比计算)
    const totalMemories = await prisma.memory.count();

    return {
      writes24h,
      hotByAgent,
      totalByAgent,
      totalMemories,
      generatedAt: new Date().toISOString(),
    };
  }),
});
