import { z } from "zod";
import { createRouter, publicProcedure, readerProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { safeCreateSkill } from "../pipeline/safe-create"; // round 57 G3
import { PrismaSkillStore, calculateMaturityScore } from "@lions/modules-skill";
import { isQuickFilter, skillQuickWhere } from "../lib/cognitive-quick-filter";
import { rangeSince } from "@/lib/range";
// 2026-10-25 R4: 归属过滤（列存在才生效；运行时探测前置，窗口前行为不变）
import { readableWhere, toAssetActor, isEnforcementOn, isAdminActor } from "../pipeline/asset-scope";
import { resolveWriteVisibility } from "../pipeline/asset-policy";
import { hasAssetColumns } from "../lib/asset-columns";

const skillStore = new PrismaSkillStore(prisma);

export const skillsRouter = createRouter({
  list: readerProcedure.input(z.object({
    category: z.string().optional(),
    level: z.string().optional(),
    search: z.string().optional(),
    page: z.number().default(1),
    pageSize: z.number().min(1).max(10000).default(100),
    // B18 修复 (2026-06-18 15:25): 前端可调排序
    sortBy: z.enum(["createdAt", "updatedAt", "totalUsageCount", "successRate", "name"]).default("updatedAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
    hasContent: z.boolean().optional(),
    // P1-2 (2026-09-01): 默认排除 legacy (无 steps 历史垃圾, SKILL-SPEC 不合规)
    includeLegacy: z.boolean().default(false),
    // 2026-09-14 UI-7: 常用快捷筛选 (高质量/近7天/被引用过/待复核)
    quick: z.enum(["highQuality", "recent7d", "referenced", "pendingReview"]).optional(),
    // 2026-10-13 round 76-CJ: 顶栏全局时间范围(③)。口径与 quick.recent7d 一致 = **createdAt**。
    range: z.enum(["1h", "24h", "7d", "30d", "all"]).optional(),
  }).optional()).query(async ({ input, ctx }) => {
    // P1.3 2026-08-28: 直接 prisma 查询 (skillStore 占位实现有缓存/字段问题, 绕开)
    const where: Record<string, unknown> = {};
    // P1-2: legacy=true 只占库不入检索 (不删数据)
    // UI-7: "待复核" 筛选本身要看 legacy 无步骤存量, 此时临时放开 legacy 排除
    const includeLegacy = !!input?.includeLegacy || input?.quick === "pendingReview";
    if (!includeLegacy) where.legacy = false;
    if (input?.category) where.category = input.category;
    if (input?.level) where.level = input.level;
    if (input?.search) where.OR = [
      { name: { contains: input.search } },
      { content: { contains: input.search } },
    ];
    if (input?.hasContent === true) where.NOT = [{ content: null }, { content: "" }];
    if (input?.hasContent === false) where.OR = [{ content: null }, { content: "" }];
    // 2026-09-14 UI-7: 快捷筛选只作用于有效记录 (归档链上的旧记录不进筛选结果)
    if (isQuickFilter(input?.quick)) {
      where.supersededBy = null;
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), skillQuickWhere(input.quick)];
    }

    // 2026-10-13 round 76-CJ: opt-in 时间窗 —— 只有显式传 range 才按 createdAt 过滤(all = 不过滤)。
    const rs = rangeSince(input?.range);
    if (rs) (where as any).createdAt = { gte: rs };

    // 2026-10-25 R4: 归属过滤（Skill 列待窗口；探测 false 时不附加）
    if (await hasAssetColumns("skill")) {
      const scope = readableWhere(toAssetActor(ctx.actor), { kind: "skill" });
      if (Object.keys(scope).length) where.AND = [...((where.AND as any[]) ?? []), scope as any];
    }

    const sortBy = input?.sortBy || "updatedAt";
    const sortOrder = input?.sortOrder || "desc";
    const orderBy: any = { [sortBy]: sortOrder };

    // 2026-09-23 agent-x #2 Skills 按需加载(方案 A): 列表只返回轻量字段, **不下传 content(steps 全文)**
    //   (默认 pageSize=100 → 旧实现一次注入 100+ 全文, 浪费 token/带宽); 有步骤全文以 hasContent
    //   布尔标识(UI 徽标用), 全文按需走 skill_view(name) / skill_get(id)。
    const [rows, total] = await Promise.all([
      prisma.skill.findMany({
        where,
        skip: ((input?.page || 1) - 1) * (input?.pageSize || 20),
        take: input?.pageSize || 20,
        orderBy,
        select: {
          id: true, name: true, businessName: true, technicalName: true, category: true, level: true, qualityScore: true,
          ownerAgentId: true, visibility: true,
          description: true, source: true, totalUsageCount: true, version: true,
          trigger: true, verification: true, pitfalls: true, platforms: true, theme: true,
          stale: true, legacy: true, supersededBy: true, createdAt: true, updatedAt: true,
        },
      }),
      prisma.skill.count({ where }),
    ]);
    // hasContent: 原始 SQL 只回布尔(不下传 content 正文), 兼容 SKILL-SPEC "无 steps 不成 skill" 徽标口径。
    const hasContentById: Record<string, boolean> = {};
    const ids = (rows as any[]).map((r: any) => r.id);
    if (ids.length) {
      try {
        const marks = await prisma.$queryRawUnsafe<any[]>(
          "SELECT id, (content IS NOT NULL AND length(content) > 0) AS c FROM Skill WHERE id IN (" + ids.map(() => "?").join(",") + ")",
          ...ids
        );
        for (const m of marks || []) hasContentById[String(m.id)] = Number(m.c) === 1 || m.c === true;
      } catch { /* hasContent 缺失不影响列表 */ }
    }
    const items = (rows as any[]).map((r: any) => ({ ...r, hasContent: !!hasContentById[r.id] }));
    // 2026-10-26: 与 memory.list 同口径回报归属范围（enforced 才是灰度是否启用，admin 视图下 scope 恒为 off）
    const actor = toAssetActor((ctx as any).actor);
    return {
      items, total, page: input?.page || 1, pageSize: input?.pageSize || 20,
      meta: { scope: isEnforcementOn() ? "enforced" : "off", enforced: isEnforcementOn(), filtered: Object.keys(readableWhere(actor, { kind: "skill" })).length > 0, actor: { agentId: actor?.agentId ?? null, role: actor?.role ?? null }, admin: isAdminActor(actor) },
    };
  }),

  get: publicProcedure.input(z.string()).query(async ({ input }) => {
    return prisma.skill.findUnique({
      where: { id: input },
      include: {
        toolProficiency: true,
        parentSkill: true,
        childSkills: true,
      },
    });
  }),

  getTree: publicProcedure.query(async () => {
    const roots = await prisma.skill.findMany({
      where: { parentSkillId: null },
      include: {
        childSkills: {
          include: { childSkills: { include: { childSkills: true } } },
        },
      },
    });
    return roots;
  }),

  getRadarData: publicProcedure.query(async () => {
    // Get skill count and level distribution per category
    const result = await prisma.skill.groupBy({
      by: ["category"],
      _count: { id: true },
    });

    // Get level counts for each category
    const levelResult = await prisma.skill.groupBy({
      by: ["category", "level"],
      _count: { id: true },
    });

    // Build a map of category -> level distribution
    const levelMap: Record<string, Record<string, number>> = {};
    levelResult.forEach((r) => {
      if (!levelMap[r.category]) levelMap[r.category] = {};
      levelMap[r.category][r.level] = r._count.id;
    });

    return result.map((r) => ({
      category: r.category,
      count: r._count.id,
      levels: levelMap[r.category] || {},
      // Convert to a "maturity" score based on level distribution
      // EXPERT=5, ADVANCED=4, INTERMEDIATE=3, BEGINNER=2, AWARENESS=1
      maturityScore: calculateMaturityScore(levelMap[r.category] || {}),
    }));
  }),

  create: publicProcedure.input(z.object({
    name: z.string(),
    category: z.string(),
    level: z.string().default("AWARENESS"),
    description: z.string().optional(),
    parentSkillId: z.string().optional(),
    // P1.6 2026-08-28 SKILL-SPEC: 技能必带可执行步骤 (content) + 适用场景 + 验证方法
    content: z.string().optional(),      // steps (markdown 编号步骤)
    trigger: z.string().optional(),      // 适用场景
    verification: z.string().optional(), // 验证方法
    pitfalls: z.string().optional(),
    platforms: z.string().optional(),
    // 2026-10-26 策略：可见性由平台档位/agent 注册选择决定（仅 agent_choice 时本字段生效）
    visibility: z.enum(["private", "shared", "global"]).optional(),
  })).mutation(async ({ input, ctx }) => {
    const steps = (input.content || "").trim();
    // SKILL-SPEC 铁律: 无 steps 不成 skill。tRPC create 也拦截。
    if (steps.length < 30) {
      throw new Error(`SKILL-SPEC: 技能 "${input.name}" 缺少可执行步骤 (content 需 >=30 字), 拒绝创建。无 steps 的技能应归入 knowledge。`);
    }
    const policy = await resolveWriteVisibility(toAssetActor((ctx as any).actor), "skill", (input as any).visibility);
    return safeCreateSkill(prisma, {
      data: {
        ...input,
        ownerAgentId: policy.ownerAgentId,
        visibility: policy.visibility,
        content: steps,
        trigger: input.trigger || input.description || "",
        verification: input.verification || "",
        version: 1,
      },
    });
  }),

  // 获取技能提升计划候选列表
  getUpgradeCandidates: publicProcedure.input(z.object({
    limit: z.number().default(10),
  }).optional()).query(async ({ input }) => {
    const limit = input?.limit ?? 10;
    // 找出可以提升的技能：usageCount达到上限的70%以上，且等级不是EXPERT
    const candidates = await prisma.skill.findMany({
      where: {
        level: { not: "EXPERT" },
      },
      orderBy: [
        { totalUsageCount: "desc" },
        { selfAssessment: "desc" },
      ],
      take: limit * 3, // 取更多以便过滤
    });

    // 计算每个技能的提升优先级
    // 优先级 = usageCount/maxUsage * 0.6 + selfAssessment/10 * 0.4
    const maxUsage: Record<string, number> = {
      EXPERT: 500, ADVANCED: 300, INTERMEDIATE: 200, BEGINNER: 100, AWARENESS: 50,
    };
    const nextLevel: Record<string, string | null> = {
      AWARENESS: "BEGINNER", BEGINNER: "INTERMEDIATE", INTERMEDIATE: "ADVANCED", ADVANCED: "EXPERT", EXPERT: null,
    };

    const withPriority = candidates.map((s) => {
      const max = maxUsage[s.level] ?? 100;
      const usageRatio = s.totalUsageCount / max;
      const assessmentRatio = (s.selfAssessment ?? 5) / 10;
      const priority = usageRatio * 0.6 + assessmentRatio * 0.4;
      return {
        ...s,
        priority,
        usagePercent: Math.round(usageRatio * 100),
        nextLevel: nextLevel[s.level],
      };
    });

    // 过滤出usagePercent >= 70%的优先提升
    const highPriority = withPriority.filter((s) => s.usagePercent >= 70);
    const normal = withPriority.filter((s) => s.usagePercent < 70 && s.usagePercent >= 50);

    return [
      ...highPriority.sort((a, b) => b.priority - a.priority).slice(0, limit),
      ...normal.sort((a, b) => b.priority - a.priority).slice(0, limit),
    ].slice(0, limit);
  }),

  // 应用技能提升计划
  applyUpgradePlan: publicProcedure.input(z.object({
    skillId: z.string(),
    targetLevel: z.string(),
  })).mutation(async ({ input }) => {
    return prisma.skill.update({
      where: { id: input.skillId },
      data: { level: input.targetLevel },
    });
  }),

  // 批量技能提升（自动提升符合条件的技能）
  autoUpgrade: publicProcedure.input(z.object({
    minUsagePercent: z.number().default(80),
    dryRun: z.boolean().default(true),
  })).mutation(async ({ input }) => {
    const maxUsage: Record<string, number> = {
      EXPERT: 500, ADVANCED: 300, INTERMEDIATE: 200, BEGINNER: 100, AWARENESS: 50,
    };
    const nextLevel: Record<string, string | null> = {
      AWARENESS: "BEGINNER", BEGINNER: "INTERMEDIATE", INTERMEDIATE: "ADVANCED", ADVANCED: "EXPERT", EXPERT: null,
    };

    const candidates = await prisma.skill.findMany({
      where: { level: { not: "EXPERT" } },
    });

    const toUpgrade: Array<{ id: string; from: string; to: string }> = [];

    for (const skill of candidates) {
      const max = maxUsage[skill.level] ?? 100;
      const usageRatio = skill.totalUsageCount / max;
      const next = nextLevel[skill.level];

      if (next && usageRatio * 100 >= input.minUsagePercent) {
        toUpgrade.push({ id: skill.id, from: skill.level, to: next });
      }
    }

    if (!input.dryRun) {
      for (const u of toUpgrade) {
        await prisma.skill.update({ where: { id: u.id }, data: { level: u.to } });
      }
    }

    return { total: toUpgrade.length, upgrades: toUpgrade, dryRun: input.dryRun };
  }),

  // 获取技能提升概览
  getUpgradeOverview: publicProcedure.query(async () => {
    const maxUsage: Record<string, number> = {
      EXPERT: 500, ADVANCED: 300, INTERMEDIATE: 200, BEGINNER: 100, AWARENESS: 50,
    };
    const nextLevel: Record<string, string | null> = {
      AWARENESS: "BEGINNER", BEGINNER: "INTERMEDIATE", INTERMEDIATE: "ADVANCED", ADVANCED: "EXPERT", EXPERT: null,
    };

    const skills = await prisma.skill.findMany({ where: { level: { not: "EXPERT" } } });

    const stats = {
      totalUpgradeable: 0,
      readyNow: 0, // >= 80%
      almostThere: 0, // 50-79%
      byLevel: {} as Record<string, { total: number; ready: number; almost: number }>,
    };

    for (const skill of skills) {
      const max = maxUsage[skill.level] ?? 100;
      const usageRatio = skill.totalUsageCount / max;
      const pct = usageRatio * 100;

      if (!stats.byLevel[skill.level]) {
        stats.byLevel[skill.level] = { total: 0, ready: 0, almost: 0 };
      }
      stats.byLevel[skill.level].total++;

      if (nextLevel[skill.level]) {
        stats.totalUpgradeable++;
        if (pct >= 80) stats.readyNow++;
        else if (pct >= 50) stats.almostThere++;
      }
    }

    return stats;
  }),

  incrementUsage: publicProcedure.input(z.string()).mutation(async ({ input }) => {
    const skill = await prisma.skill.findUnique({ where: { id: input } });
    if (!skill) throw new Error("Skill not found");

    // 等级越高上限越高
    const maxUsage: Record<string, number> = {
      EXPERT: 500,
      ADVANCED: 300,
      INTERMEDIATE: 200,
      BEGINNER: 100,
      AWARENESS: 50,
    };
    const max = maxUsage[skill.level] ?? 100;
    const newCount = Math.min(skill.totalUsageCount + 1, max);

    return prisma.skill.update({
      where: { id: input },
      data: { totalUsageCount: newCount },
    });
  }),

  updateSkill: publicProcedure.input(z.object({
    id: z.string(),
    usageMethod: z.string().optional(),
    autoMatchRules: z.string().optional(),
    description: z.string().optional(),
  })).mutation(async ({ input: { id, ...data } }) => {
    return prisma.skill.update({
      where: { id },
      data,
    });
  }),

  // 根据自动化匹配规则查找技能
  findByMatch: publicProcedure.input(z.object({
    filePath: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    context: z.string().optional(),
  })).query(async ({ input }) => {
    const orConditions: Record<string, unknown>[] = [];
    if (input.filePath) {
      orConditions.push({ autoMatchRules: { contains: input.filePath } });
    }
    if (input.keywords?.length) {
      for (const k of input.keywords) {
        orConditions.push({ autoMatchRules: { contains: k } });
        orConditions.push({ name: { contains: k } });
      }
    }

    const skills = await prisma.skill.findMany({
      where: orConditions.length > 0 ? { OR: orConditions } : {},
      include: { toolProficiency: true },
    });

    // 过滤并排序
    const matched = skills
      .filter((s) => {
        if (!s.autoMatchRules) return false;
        try {
          const rules = JSON.parse(s.autoMatchRules) as Array<{ type: string; pattern: string }>;
          return rules.some((r) => {
            if (r.type === "filePath" && input.filePath) {
              return input.filePath.includes(r.pattern);
            }
            if (r.type === "keyword" && input.keywords) {
              return input.keywords.some((k) => k.includes(r.pattern));
            }
            return false;
          });
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.totalUsageCount - a.totalUsageCount);

    return matched;
  }),
});
