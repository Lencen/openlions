import { z } from "zod";
import { createRouter, publicProcedure, readerProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { PrismaKnowledgeStore, extractTags, extractDomain } from "@lions/modules-knowledge";
import { isQuickFilter, knowledgeQuickWhere } from "../lib/cognitive-quick-filter";
import { rangeSince } from "@/lib/range";
// 2026-10-07 round 53: 受控枚举投影 + 质量分单一天平(本文件 8 处 create 原先漏写质量分)
import { projectDomain, projectCategory } from "../pipeline/enum-projection";
import { safeCreateKnowledge, safeCreateMemory } from "../pipeline/safe-create"; // round 57: 统一写入层(store 闸)
import { calcQualityScore } from "../pipeline/db-writer";
// 2026-10-25 R4: 归属过滤（列存在才生效；用运行时探测做前置，窗口前行为不变）
import { readableWhere, canRead, toAssetActor, isEnforcementOn, isAdminActor } from "../pipeline/asset-scope";
import { resolveWriteVisibility } from "../pipeline/asset-policy";
import { hasAssetColumns } from "../lib/asset-columns";

const knowledgeStore = new PrismaKnowledgeStore(prisma);

// Re-export for backward compat (other routers may import these)
export { extractTags, extractDomain };

export const knowledgeRouter = createRouter({
  list: readerProcedure.input(z.object({
    category: z.string().optional(),
    tag: z.string().optional(),
    search: z.string().optional(),
    page: z.number().default(1),
    pageSize: z.number().default(20),
    // B18 修复 (2026-06-18 16:45): 加 sortBy/sortOrder 前端可调
    sortBy: z.enum(["createdAt", "updatedAt", "confidence", "title", "usageCount"]).default("updatedAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
    // 2026-09-14 UI-7: 常用快捷筛选 (高质量/近7天/被引用过/待复核)
    quick: z.enum(["highQuality", "recent7d", "referenced", "pendingReview"]).optional(),
    // 2026-10-13 round 76-CK: 顶栏全局时间范围(③)。口径与 quick.recent7d 一致 = **createdAt**。
    range: z.enum(["1h", "24h", "7d", "30d", "all"]).optional(),
    // 2026-10-26 口径统一：默认只列有效条目（与 memory/skill 列表一致），审计场景可显式打开
    includeSuperseded: z.boolean().default(false),
  })).query(async ({ input, ctx }) => {
    // P1.3 沿用 skills 的做法: 直接 prisma 查询 (占位 store 会丢 sortBy/category, 且不支持 quick 筛选)
    const where: Record<string, unknown> = {};
    if (input.category) where.category = input.category;
    if (input.tag) where.tags = { contains: input.tag };
    if (input.search) where.OR = [
      { title: { contains: input.search } },
      { content: { contains: input.search } },
    ];
    // 2026-10-26: 默认排除已退役（supersededBy IS NOT NULL）。此前只有 quick 筛选才排除，导致列表 total
    //   等于全表（85,421）而 memory/skill 是未退役口径 —— 同一个 UI 的"共 N 条"三个页面含义不同。
    if (!input.includeSuperseded) where.supersededBy = null;
    // 2026-09-14 UI-7: 快捷筛选只作用于有效记录 (归档链上的旧记录不进筛选结果)
    if (isQuickFilter(input.quick)) {
      where.supersededBy = null;
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), knowledgeQuickWhere(input.quick)];
    }
    // 2026-10-13 round 76-CK: opt-in 时间窗(与 quick 是**交集**, 实测不覆盖)。
    const rs = rangeSince(input.range);
    if (rs) (where as any).createdAt = { gte: rs };

    // 2026-10-25 R4: 归属过滤（Knowledge 列待窗口；探测为 false 时不附加 -> 与改造前逐字一致）
    if (await hasAssetColumns("knowledge")) {
      const scope = readableWhere(toAssetActor(ctx.actor), { kind: "knowledge" });
      if (Object.keys(scope).length) where.AND = [...((where.AND as any[]) ?? []), scope as any];
    }

    const orderBy: Record<string, string> = { [input.sortBy]: input.sortOrder };
    const [items, total] = await Promise.all([
      prisma.knowledge.findMany({
        where,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        orderBy,
      }),
      prisma.knowledge.count({ where }),
    ]);
    // 2026-10-26: 与 memory.list 同口径回报归属范围（enforced=灰度是否启用；admin 视图下 scope 恒为 off）
    const actor = toAssetActor((ctx as any).actor);
    return {
      items, total, page: input.page, pageSize: input.pageSize,
      meta: { scope: isEnforcementOn() ? "enforced" : "off", enforced: isEnforcementOn(), filtered: Object.keys(readableWhere(actor, { kind: "knowledge" })).length > 0, actor: { agentId: actor?.agentId ?? null, role: actor?.role ?? null }, admin: isAdminActor(actor) },
    };
  }),

  // Phase 3: 语义搜索 - tag + domain 组合搜索，支持置信度排序
  semanticSearch: publicProcedure.input(z.object({
    query: z.string().optional(),
    domain: z.string().optional(),
    tags: z.array(z.string()).optional(),
    sortBy: z.enum(["confidence", "createdAt", "usageCount"]).default("confidence"),
    page: z.number().default(1),
    pageSize: z.number().default(20),
  })).query(async ({ input }) => {
    const skip = (input.page - 1) * input.pageSize;

    // Build Knowledge SQL where clause (category = domain filter)
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 0;

    if (input.domain) {
      paramIdx++;
      conditions.push(`category = $${paramIdx}`);
      params.push(input.domain);
    }
    if (input.tags && input.tags.length > 0) {
      const tagConditions = input.tags.map(() => {
        paramIdx++;
        return `tags LIKE $${paramIdx}`;
      });
      conditions.push(`(${tagConditions.join(" OR ")})`);
      input.tags.forEach(t => { paramIdx++; params.push(`%${t}%`); });
    }
    if (input.query) {
      // P4-6 (2026-07-12): 改 token-OR 搜索 — 之前全字符串 LIKE, 中文混合 query (如 "flywheel 并行") 找不到
      // 现在按空格分词, 每个 token 单独 LIKE, OR 连接 (任一命中即匹配)
      const tokens = input.query.trim().split(/\s+/).filter(t => t.length > 0);
      if (tokens.length === 1) {
        paramIdx++;
        conditions.push(`(title LIKE $${paramIdx} OR content LIKE $${paramIdx})`);
        params.push(`%${tokens[0]}%`);
      } else if (tokens.length > 1) {
        const orParts: string[] = [];
        tokens.forEach(tok => {
          paramIdx++;
          orParts.push(`(title LIKE $${paramIdx} OR content LIKE $${paramIdx})`);
          params.push(`%${tok}%`);
        });
        conditions.push(`(${orParts.join(" OR ")})`);
      }
    }

    const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    // Sort clause
    const orderClause = input.sortBy === "confidence" ? "ORDER BY confidence DESC"
      : input.sortBy === "usageCount" ? "ORDER BY usageCount DESC"
      : "ORDER BY createdAt DESC";

    // 2026-09-15 retract-flow: 失效/被否决/被取代的知识一律不参与语义检索(置信度排序下尤其危险: 0.95 的撤回结论
    //   仍可能因 ORDER BY confidence DESC 排在第一位, 任何 agent 调用 semanticSearch 都会把它当事实引用)。
    //   与 portal/knowledge 检索保持口径一致 (stale=0 AND verification!='REJECTED' AND supersededBy IS NULL)。
    const baseFilter = "(COALESCE(stale,0)=0 AND COALESCE(verification,'')<>'REJECTED' AND supersededBy IS NULL)";
    const knowledgeWhereClause = whereClause ? `WHERE ${baseFilter} AND ${whereClause.slice("WHERE ".length)}` : `WHERE ${baseFilter}`;
    const knowledgeSql = `SELECT id, title, category as domain, tags, confidence, usageCount, createdAt
      FROM Knowledge ${knowledgeWhereClause} ${orderClause} LIMIT ${input.pageSize} OFFSET ${skip}`;
    const knowledgeCountSql = `SELECT COUNT(*) + 0 as cnt FROM Knowledge ${knowledgeWhereClause}`;

    const [knowledgeRows, countRow]: any[] = await Promise.all([
      (prisma as any).$queryRawUnsafe(knowledgeSql, ...params),
      (prisma as any).$queryRawUnsafe(knowledgeCountSql, ...params),
    ]);

    // Query Memory (domain filter, no text search for simplicity)
    const memConditions: string[] = [];
    const memParams: any[] = [];
    let memIdx = 0;

    if (input.domain) {
      memIdx++;
      memConditions.push(`domain = $${memIdx}`);
      memParams.push(input.domain);
    }
    if (input.tags && input.tags.length > 0) {
      const tagConditions = input.tags.map(() => {
        memIdx++;
        return `tags LIKE $${memIdx}`;
      });
      memConditions.push(`(${tagConditions.join(" OR ")})`);
      input.tags.forEach(t => { memIdx++; memParams.push(`%${t}%`); });
    }

    const memWhereClause = memConditions.length > 0 ? "WHERE " + memConditions.join(" AND ") : "";
    const memorySql = `SELECT id, title, domain, tags, createdAt FROM Memory ${memWhereClause} ORDER BY createdAt DESC LIMIT ${input.pageSize} OFFSET ${skip}`;
    const memoryCountSql = `SELECT COUNT(*) + 0 as cnt FROM Memory ${memWhereClause}`;

    const [memoryRows, memCountRow]: any[] = await Promise.all([
      memConditions.length > 0 ? (prisma as any).$queryRawUnsafe(memorySql, ...memParams) : Promise.resolve([]),
      memConditions.length > 0 ? (prisma as any).$queryRawUnsafe(memoryCountSql, ...memParams) : Promise.resolve([{ cnt: 0 }]),
    ]);

    const knowledgeTotal = Number(countRow?.[0]?.cnt || 0);
    const memoryTotal = Number(memCountRow?.[0]?.cnt || 0);

    // Merge results
    const merged: Array<{ id: string; title: string; type: "memory" | "knowledge"; domain?: string; tags?: string; confidence?: number; createdAt: Date }> = [];

    (knowledgeRows || []).forEach((k: any) => {
      merged.push({
        id: k.id,
        title: k.title,
        type: "knowledge",
        domain: k.domain || undefined,
        tags: k.tags || undefined,
        confidence: k.confidence || 0,
        createdAt: k.createdAt,
      });
    });

    (memoryRows || []).forEach((m: any) => {
      merged.push({
        id: m.id,
        title: m.title || "",
        type: "memory",
        domain: m.domain || undefined,
        tags: m.tags || undefined,
        confidence: undefined,
        createdAt: m.createdAt,
      });
    });

    // Sort by confidence if requested (knowledge items have it, memory don't)
    if (input.sortBy === "confidence") {
      merged.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    }

    const total = knowledgeTotal + memoryTotal;
    const paged = merged.slice(0, input.pageSize);

    return {
      items: paged,
      total,
      page: input.page,
      pageSize: input.pageSize,
      breakdown: { knowledge: knowledgeTotal, memory: memoryTotal },
    };
  }),

  // 2026-10-25 R4: 单条读也判归属（列未生成时 owner 视为 NULL -> 放行，与改造前一致；列生成后自动生效）
  get: readerProcedure.input(z.string()).query(async ({ input, ctx }) => {
    const row = await knowledgeStore.get(input);
    return canRead(toAssetActor(ctx.actor), row, "knowledge") ? row : null;
  }),

  getGraph: publicProcedure.input(z.object({
    limit: z.number().default(100),
  }).optional()).query(async ({ input }) => {
    return knowledgeStore.getGraph(input?.limit ?? 100);
  }),

  create: publicProcedure.input(z.object({
    title: z.string(),
    content: z.string(),
    category: z.string().optional(),
    tags: z.string().optional(),
    sourceType: z.string().optional(),
    sourceId: z.string().optional(),
    sourceDetail: z.string().optional(),
    // 2026-10-26 策略：可见性由平台档位/agent 注册选择决定（仅 agent_choice 时本字段生效）
    visibility: z.enum(["private", "shared", "global"]).optional(),
  })).mutation(async ({ input, ctx }) => {
    const policy = await resolveWriteVisibility(toAssetActor((ctx as any).actor), "knowledge", (input as any).visibility);
    return knowledgeStore.create({ ...input, ownerAgentId: policy.ownerAgentId, visibility: policy.visibility });
  }),

  // 自动从学习里程碑创建知识
  createFromLearning: publicProcedure.input(z.object({
    milestoneId: z.string(),
    title: z.string(),
    content: z.string(),
    category: z.string().optional(),
    tags: z.string().optional(),
  })).mutation(async ({ input }) => {
    return safeCreateKnowledge(prisma, {
      data: {
        title: input.title,
        content: input.content,
        sourceType: "LEARNING",
        sourceId: input.milestoneId,
        sourceDetail: "通过学习里程碑自动提取",
        category: projectCategory(input.category, "knowledge") ?? "OTHER", // 2026-10-08 round 54
        tags: input.tags,
        confidence: 0.7,
      },
    });
  }),

  // 自动从实践创建知识
  createFromPractice: publicProcedure.input(z.object({
    practiceId: z.string(),
    title: z.string(),
    content: z.string(),
    category: z.string().optional(),
    tags: z.string().optional(),
    effectiveness: z.number().optional(),
  })).mutation(async ({ input }) => {
    return safeCreateKnowledge(prisma, {
      data: {
        title: input.title,
        content: input.content,
        sourceType: "PRACTICE",
        sourceId: input.practiceId,
        sourceDetail: "通过实践项目自动总结",
        category: projectCategory(input.category, "knowledge") ?? "OTHER", // 2026-10-08 round 54
        tags: input.tags,
        confidence: input.effectiveness ?? 0.6,
      },
    });
  }),

  // 从查询结果创建知识
  createFromQuery: publicProcedure.input(z.object({
    query: z.string(),
    answer: z.string(),
    category: z.string().optional(),
    tags: z.string().optional(),
  })).mutation(async ({ input }) => {
    return safeCreateKnowledge(prisma, {
      data: {
        title: `查询: ${input.query.slice(0, 50)}`,
        content: input.answer,
        sourceType: "QUERY",
        sourceDetail: "通过 AI 查询自动沉淀",
        category: projectCategory(input.category, "knowledge") ?? "OTHER", // 2026-10-08 round 54
        tags: input.tags,
        confidence: 0.8,
      },
    });
  }),

  // 从反思总结创建知识
  createFromReflection: publicProcedure.input(z.object({
    reflectionId: z.string(),
    title: z.string(),
    content: z.string(),
    tags: z.string().optional(),
  })).mutation(async ({ input }) => {
    return safeCreateKnowledge(prisma, {
      data: {
        title: input.title,
        content: input.content,
        sourceType: "SELF_SUMMARY",
        sourceId: input.reflectionId,
        sourceDetail: "通过反思总结自动提炼",
        tags: input.tags,
        confidence: 0.75,
      },
    });
  }),

  // 外部系统调用统一反思生成（Task完成/Problem解决后的反思增强）
  generate: publicProcedure.input(z.object({
    type: z.enum(["TASK_COMPLETION", "PROBLEM_RESOLUTION", "AGENT_REFLECTION"]),
    sourceId: z.string(),
    title: z.string(),
    description: z.string(),
    executionOutput: z.string().optional(),
    problemsEncountered: z.string().optional(),
    solutionsApplied: z.string().optional(),
    rootCause: z.string().optional(),
    resolution: z.string().optional(),
    domain: z.string().optional(),
    tags: z.array(z.string()).optional(),
    sourceAgent: z.string().default("lions-task"),
    buildGraph: z.boolean().optional().default(false),
  })).mutation(async ({ input }) => {
    // 构建反思上下文
    const contextMap = {
      TASK_COMPLETION: {
        section: "## 任务完成反思",
        prompt: `任务「${input.title}」已完成。\n描述：${input.description}\n产出：${input.executionOutput || "无"}\n问题：${input.problemsEncountered || "无"}\n解决方案：${input.solutionsApplied || "无"}`,
      },
      PROBLEM_RESOLUTION: {
        section: "## 问题解决复盘",
        prompt: `问题「${input.title}」已解决。\n描述：${input.description}\n根因：${input.rootCause || "无"}\n解决方案：${input.resolution || "无"}`,
      },
      AGENT_REFLECTION: {
        section: "## Agent 反思",
        prompt: `标题：${input.title}\n内容：${input.description}`,
      },
    };

    const ctx = contextMap[input.type];
    const reflectionContent = input.executionOutput || input.description || "";

    // 生成建议标签（优先使用传入值，否则自动提取）
    const finalTags = input.tags && input.tags.length > 0
      ? input.tags.join(",")
      : extractTags(reflectionContent + " " + (input.problemsEncountered || "") + " " + (input.solutionsApplied || ""));
    // 2026-10-07 修(实测缺陷): `extractDomain` 在 @lions/modules-knowledge 里是**占位实现**(`return ""`),
    //   即本行原来是"永远返回空串"的假提取。改为平台唯一分类实现(命中枚举 -> 归一, 否则关键词分类, 仍不中 -> null)。
    const finalDomain = projectDomain(input.domain, { title: input.title, content: input.description });

    // 写入 Memory（反思内容）
    // round 57 G4(2026-10-10): 长标题语义已由 round58 裁决为"归一(不拒绝)" -> 原豁免条件消失, 迁 safeCreateMemory.
    const memory = await safeCreateMemory(prisma, {
      data: {
        content: `${ctx.section}\n\n**来源**: ${input.title}\n**描述**: ${input.description}\n\n${input.executionOutput ? `**产出**:\n${input.executionOutput}\n\n` : ""}${input.problemsEncountered ? `**遇到的问题**: ${input.problemsEncountered}\n\n` : ""}${input.solutionsApplied ? `**解决方案**: ${input.solutionsApplied}\n\n` : ""}${input.rootCause ? `**根因分析**: ${input.rootCause}\n\n` : ""}${input.resolution ? `**解决方案**: ${input.resolution}\n\n` : ""}`.trim(),
        title: `[反思] ${input.title}`.slice(0, 100),
        tier: "WARM",
        type: "REFLECTION",
        sourceType: input.type,
        sourceId: input.sourceId,
        domain: finalDomain,
        tags: typeof finalTags === "string" ? finalTags : finalTags.join(","),
        // 2026-10-07: 本路径原先漏写质量分(列默认 0 -> 产物隐形于质量读数)
        qualityScore: calcQualityScore({ type: "memory", content: input.title + " " + (input.description || ""), title: `[反思] ${input.title}`, theme: finalDomain, tags: typeof finalTags === "string" ? finalTags : finalTags.join(","), valueScore: 0.5 }),
      },
    });
    if (!memory) {
      console.warn("[knowledge.selfSummary] Memory 被 store 内容闸拒绝(不合规), 不落库");
      return { memoryId: null, knowledgeId: null, suggestedTags: finalTags, suggestedDomain: finalDomain };
    }

    // 写入 Knowledge（洞察）
    const insights: string[] = [];

    if (input.problemsEncountered) {
      insights.push(`问题识别: ${input.problemsEncountered.slice(0, 100)}`);
    }
    if (input.solutionsApplied) {
      insights.push(`解决方案: ${input.solutionsApplied.slice(0, 100)}`);
    }
    if (input.rootCause) {
      insights.push(`根因: ${input.rootCause.slice(0, 100)}`);
    }

    let knowledge = null;
    if (insights.length > 0) {
      knowledge = await safeCreateKnowledge(prisma, {
        data: {
          title: `${input.type === "PROBLEM_RESOLUTION" ? "问题解决" : "任务完成"}洞察: ${input.title}`.slice(0, 100),
          content: insights.join("\n"),
          sourceType: "SELF_SUMMARY",
          sourceId: memory.id,
          sourceDetail: `来源: ${input.sourceAgent}`,
          category: finalDomain,
          tags: typeof finalTags === "string" ? finalTags : finalTags.join(","),
          confidence: 0.75,
        },
      });
    }

    // 如果 buildGraph=true，自动从反思内容构建知识图谱
    if (input.buildGraph) {
      const graphText = [
        input.title,
        input.description,
        input.executionOutput,
        input.problemsEncountered,
        input.solutionsApplied,
        input.rootCause,
        input.resolution,
      ].filter(Boolean).join(" ");

      // 通过 HTTP 调用 knowledgeGraph.buildFromText（异步，不阻塞返回值）
      fetch(`http://localhost:3000/api/trpc/knowledgeGraph.buildFromText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: graphText }),
      }).catch(() => {}); // fire-and-forget
    }

    return {
      memoryId: memory.id,
      knowledgeId: knowledge?.id || null,
      suggestedTags: finalTags,
      suggestedDomain: finalDomain,
    };
  }),

  // 从用户告知创建知识
  createFromUser: publicProcedure.input(z.object({
    title: z.string(),
    content: z.string(),
    category: z.string().optional(),
    tags: z.string().optional(),
  })).mutation(async ({ input }) => {
    return safeCreateKnowledge(prisma, {
      data: {
        title: input.title,
        content: input.content,
        sourceType: "USER_PROVIDED",
        sourceDetail: "用户提供",
        category: projectCategory(input.category, "knowledge") ?? "OTHER", // 2026-10-08 round 54
        tags: input.tags,
        confidence: 0.9,
      },
    });
  }),

  incrementUsage: publicProcedure.input(z.string()).mutation(async ({ input }) => {
    const result = await knowledgeStore.incrementUsage(input);
    if (!result) throw new Error("Knowledge not found");
    return result;
  }),
});
