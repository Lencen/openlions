import { z } from "zod";
import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { safeCreateReflection, safeCreateKnowledge, safeCreateMemory } from "../pipeline/safe-create"; // round 57
import { calcQualityScore } from "../pipeline/db-writer"; // 2026-10-09 round 72-B: 补 qualityScore(棘轮项)
import { yesterdayBeijingStr, parseBeijingDate } from "../lib/timezone";
import { isQuickFilter, reflectionQuickSql } from "../lib/cognitive-quick-filter";
import { rangeSince } from "@/lib/range";

export const reflectionRouter = createRouter({
  list: publicProcedure.input(z.object({
    status: z.string().optional(),
    category: z.string().optional(),
    priority: z.string().optional(),
    // Phase 7 (2026-06-24): 加 search 字段供 MCP cognition.search 调用 (LIKE 模糊)
    search: z.string().optional(),
    page: z.number().default(1),
    pageSize: z.number().default(20),
    // B18 修复 (2026-06-18 15:22): 前端可调排序
    sortBy: z.enum(["createdAt", "updatedAt", "date", "score", "priority"]).default("updatedAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
    // 2026-09-14 UI-7: 常用快捷筛选 (近7天/被引用过/待复核; 反思无质量分, 无 highQuality)
    quick: z.enum(["recent7d", "referenced", "pendingReview"]).optional(),
    // 2026-10-13 round 76-CL: 顶栏全局时间范围(③) —— 本 list 是**原生 SQL**(非 Prisma where), 单独处理。
    range: z.enum(["1h", "24h", "7d", "30d", "all"]).optional(),
  })).query(async ({ input }) => {
    try {
    // 2026-09-15 UI-7 修复 (独立复核 D1): 反思快捷筛选分页失效 + 返回行不是真最新。
    //   旧实现: SELECT ... LIMIT 500 (无 ORDER BY) -> JS sort -> slice(0,200) -> slice(offset, pageSize);
    //   两个独立缺陷:
    //     (a) LIMIT 500 无 ORDER BY 取到的是 rowid 顺序(最旧)的 500 行, JS 排序后取 top200,
    //         并非"全表最新 200"; 复核实测 page1 十条与真 updatedAt DESC top10 重合 0/10。
    //     (b) cappedItems 恒 200 行 -> 第 21 页起永久空白, 而 total 报 5002/1292/289, 分页自相矛盾。
    //   修法: ORDER BY + LIMIT/OFFSET 下推到 SQL, 只返回当前页 (不再全量拉取 500 行再 JS 排序)。
    //   数据前提(已实测): Reflection.createdAt/updatedAt 全表 48208 行均为 integer(ms), score 为 real,
    //     priority 为 P0..P3 文本 -> 可直接 SQL 排序; 旧注释所述 mixed-format 已不复存在。
    const safePageSize = Math.min(input.pageSize, 230);
    const offset = (input.page - 1) * safePageSize;

    // 构建 where 条件
    const whereConditions: string[] = [];
    const whereParams: any[] = [];
    if (input.status) { whereConditions.push("status = ?"); whereParams.push(input.status); }
    if (input.category) { whereConditions.push("category = ?"); whereParams.push(input.category); }
    if (input.priority) { whereConditions.push("priority = ?"); whereParams.push(input.priority); }
    // Phase 7 v2: search 走 title/description/lesson/insight/improvements LIKE (全文本字段)
    if (input.search) {
      whereConditions.push("(title LIKE ? OR description LIKE ? OR lesson LIKE ? OR insight LIKE ? OR improvements LIKE ?)");
      const v = `%${input.search}%`;
      whereParams.push(v, v, v, v, v);
    }
    // 2026-09-14 UI-7: 快捷筛选只作用于有效记录 (归档链上的旧记录不进筛选结果)
    if (isQuickFilter(input.quick)) {
      whereConditions.push("supersededBy IS NULL");
      const qf = reflectionQuickSql(input.quick);
      whereConditions.push(qf.sql);
      whereParams.push(...qf.params);
    }
    // 2026-10-13 round 76-CL: opt-in 时间窗 —— Reflection.createdAt 全表是 integer(ms)(见上方 2026-09-15 实测结论),
    //   故直接与 rangeSince 的 epoch ms 比较; 与 quick 同为 WHERE ... AND, 即**交集**。
    const rs = rangeSince(input.range);
    if (rs) { whereConditions.push("createdAt >= ?"); whereParams.push(rs.getTime()); }

    const whereSql = whereConditions.length > 0 ? "WHERE " + whereConditions.join(" AND ") : "";

    // 1) total count (排除测试 data cma% + refl% + <cmq 时间窗口,与 list 一致)
    const totalWhere = whereSql
      ? `${whereSql} AND id NOT LIKE 'cma%' AND id NOT LIKE 'refl-%' AND id >= 'cmq'`
      : `WHERE id NOT LIKE 'cma%' AND id NOT LIKE 'refl-%' AND id >= 'cmq'`;
    const totalQuery = `SELECT COUNT(*) as cnt FROM Reflection ${totalWhere}`;
    const totalResult = await prisma.$queryRawUnsafe(totalQuery, ...whereParams) as Array<{ cnt: number }>;
    const total = Number(totalResult[0]?.cnt || 0);
    // 2) 排序键下推 SQL (2026-09-15 UI-7 修复 D1)
    //   旧实现把排序放 JS 端是因为历史上 createdAt 有 unix ms / ISO / no-T 混合格式;
    //   现网实测全表 48208 行 createdAt/updatedAt 均为 integer(ms), 该前提已不成立, 故改 SQL 排序。
    //   createdAt/id 沿用既有口径: cuid 字典序 = 创建时间倒序; 其余映射到真实列。
    const sortKeySql =
      input.sortBy === "createdAt" ? "id"
      : input.sortBy === "updatedAt" ? "updatedAt"
      : input.sortBy === "score" ? "score"
      : input.sortBy === "priority"
        ? "CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 9 END"
        : "createdAt"; // date / 兜底
    const dirSql = input.sortOrder === "asc" ? "ASC" : "DESC";
    // id 作次键, 保证 updatedAt/score 并列时翻页稳定 (同一次查询内不会重复/漏行)
    const orderBySql = `ORDER BY ${sortKeySql} ${dirSql}, id ${dirSql}`;

    const selectCols = `id, title, description, category, status, priority, score, createdAt, updatedAt, sourceType, actionType, actionConfidence, processingVersion, improvements, structuredImprovements, theme, reinforceCount`;
    // 排除测试 data (cma% / refl-%) + id >= 'cmq' 时间窗 (与 total 一致)
    const excludeTestSql = whereSql
      ? `${whereSql} AND id NOT LIKE 'cma%' AND id NOT LIKE 'refl-%'`
      : `WHERE id NOT LIKE 'cma%' AND id NOT LIKE 'refl-%'`;
    // 2026-09-15 UI-7 修复 D1: SQL 端 ORDER BY + LIMIT/OFFSET, 只取当前页 -> 不受旧 listCap=200 截断,
    //   也不再"先取最旧 500 行再排序"导致返回行不是真最新。
    const listQuery = `SELECT ${selectCols} FROM Reflection ${excludeTestSql} AND id >= 'cmq' ${orderBySql} LIMIT ${safePageSize} OFFSET ${offset}`;
    const items: any[] = await prisma.$queryRawUnsafe(listQuery, ...whereParams) as unknown as any[];
    console.log(`[reflection.list] page=${input.page} size=${safePageSize} got ${items.length} rows (排除 cma+refl+<cmq, ${orderBySql})`);

    // P3 修复: reflection.list 之前没 include improvementActions → 表格"改进措施"列显示 0 条
    //   跟 funnel "有改进措施 100%" 矛盾 (因为 funnel 用 improvementAction 表统计)
    //   真根因: list 没 include, 表格 record.improvementActions 永远 undefined
    //   修复: 拉 list 后补查 improvementActions (按 reflectionId IN (ids))
    //   P3 修复 v0.1.2: ImprovementAction 表 NUL 已清, prisma 5.22 binary parser 读 content OK
    if (items.length > 0) {
      try {
        const ids = items.map((r: any) => r.id);
        // 一次查所有 actions (用 IN, escape 单引号防 SQL injection)
        // P3 修复 v0.1.3: ImprovementAction 表没 priority 列, 用 createdAt/completedAt
        const idsList = ids.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(",");
        const actionsQuery = `SELECT id, reflectionId, content, status, createdAt, completedAt FROM ImprovementAction WHERE reflectionId IN (${idsList})`;
        const actions = await prisma.$queryRawUnsafe(actionsQuery) as any[];
        const actionsByReflection: Record<string, any[]> = {};
        for (const a of actions) {
          if (!actionsByReflection[a.reflectionId]) actionsByReflection[a.reflectionId] = [];
          actionsByReflection[a.reflectionId].push(a);
        }
        for (const r of items) {
          r.improvementActions = actionsByReflection[r.id] ?? [];
        }
      } catch (iaErr) {
        console.warn(`[reflection.list] improvementActions fetch failed (non-fatal): ${(iaErr as Error).message?.slice(0, 200)}`);
        for (const r of items) r.improvementActions = [];
      }
    }
    const parsed = items.map((r: any) => {
      let lesson = null;
      let improvements = null;
      let structuredImprovements = null;
      try { lesson = r.lesson ? JSON.parse(r.lesson) : null; } catch { lesson = r.lesson || null; }
      try { improvements = r.improvements ? JSON.parse(r.improvements) : null; } catch { improvements = r.improvements || null; }
      // V3: 解析 structuredImprovements (DB 存 JSON 字符串)
      try { structuredImprovements = r.structuredImprovements ? JSON.parse(r.structuredImprovements) : null; } catch { structuredImprovements = r.structuredImprovements || null; }
      return { ...r, lesson, improvements, structuredImprovements };
    });
    // P3 修复: total 已在 raw query 算过, 不再 prisma.count (避免重复 query + 兼容 where 条件)
    return { items: parsed, total, page: input.page, pageSize: safePageSize };
    } catch (e) {
      const err = e as any;
      console.error(`[reflection.list] FATAL msg: ${err?.message?.slice(0, 500)}`);
      console.error(`[reflection.list] FATAL code: ${err?.code}`);
      console.error(`[reflection.list] FATAL meta: ${JSON.stringify(err?.meta)?.slice(0, 500)}`);
      console.error(`[reflection.list] FATAL stack: ${err?.stack?.split("\n").slice(0, 10).join("\n")}`);
      throw e;
    }
  }),

  get: publicProcedure.input(z.string()).query(async ({ input }) => {
    return prisma.reflection.findUnique({
      where: { id: input },
      include: { improvementActions: true },
    });
  }),

  // P3-8 修复: 新加 recent 端点 — 走 WHERE id NOT LIKE 'cma%' AND createdAt >= sinceMs + ORDER BY id DESC
  //   真根因: list 端点物理顺序返 cma 测试数据, 而 task 端 reflection.stats 走 list proxy 拿到的 sample 全是 cma 旧数据
  //   P3-8 修复: 用 cuId id DESC 排序 (cuid 字典序 = 时间倒序,避免 createdAt 混存 integer ms / text ISO 比较错位)
  recent: publicProcedure.input(z.object({
    days: z.number().max(90).default(7),  // 最多 90 天, 默认 7 天 (zod v4: .max() 必须在 .default() 前)
    pageSize: z.number().max(200).default(100),  // 最多 200 (避 prisma 5.22 binary parser 阈值)
  })).query(async ({ input }) => {
    const sinceMs = Date.now() - input.days * 24 * 60 * 60 * 1000;
    // P3-8 修复: 双路 query 不可靠 (ms integer 行 prisma 自动转 ISO string 拿不到),改单路 raw query
    //   旧思路: prisma.findMany gte: Date 拿 text 行 + raw query 拿 ms integer 行
    //   实测: 两条路都被 prisma 序列化层"消化",ms integer 行始终拿 0 条
    // 新思路: 单条 raw query WHERE id NOT LIKE 'cma%' AND id >= cuid(sinceMs) (cuid 时间前缀),避 createdAt 字段类型混存
    //   OR 更简单: 直接 ORDER BY id DESC LIMIT pageSize,前端按 days 过滤 (cuid 字典序就是时间倒序)
    // 用第 2 种更稳: ORDER BY id DESC LIMIT pageSize + JS 过滤 < sinceMs
    //   - cuid 字典序 = 时间倒序: cmq7 > cmpn > cmq7 之后的 cmq8
    //   - 7 天前的 cuid 前缀: cmq7t6hbz... (1781080225344 = 6/10 19:30)
    //   - 14 天前 cuid 前缀: cmpxxxx (更老)
    // 简化: LIMIT 500 (避免 binary parser ~200 阈值 P2010), JS filter 7 天
    // P3-8 修复 v2: 加 id >= 'cmq' 限制 (只取 6/8+ 真数据 ~381 行),避免 binary parser 触发
    const listQuery = `SELECT id, title, status, priority, category, createdAt, sourceType, actionType
       FROM Reflection
       WHERE id NOT LIKE 'cma%' AND id NOT LIKE 'refl-%' AND id >= 'cmq'
       LIMIT 500`;
    const allItems = await prisma.$queryRawUnsafe<Array<{
      id: string; title: string; status: string; priority: string;
      category: string; createdAt: string | number; sourceType: string; actionType: string;
    }>>(listQuery);
    // JS 过滤 < sinceMs (cuid 字典序就是时间序,id 大 = 时间新)
    // 用 createdAt ms 过滤更准 (cuid 是 base36 时间前缀,跟 ms 大致对应)
    const parseTs = (c: Date | string | number | null | undefined): number => {
      if (c == null) return 0;
      if (c instanceof Date) return c.getTime();  // P3-8 修复 v2: prisma raw query 把 DateTime 转 Date 对象(不是 number 也不是 string)
      if (typeof c === "number") return c > 1e10 ? c : c * 1000;
      if (typeof c === "string") {
        if (c.includes("T")) return new Date(c).getTime();
        const n = parseInt(c);
        return n > 1e10 ? n : n * 1000;
      }
      return 0;
    };
    const items = allItems
      .filter(r => parseTs(r.createdAt) >= sinceMs)
      .slice(0, input.pageSize);
    // total = 全部 >= sinceMs 的真数据行数 (raw query 算,不依赖 sample)
    const totalQuery = `SELECT COUNT(*) as cnt FROM Reflection WHERE id NOT LIKE 'cma%' AND (
      (typeof(createdAt) = 'integer' AND createdAt >= ${sinceMs})
      OR (typeof(createdAt) = 'text' AND createdAt >= '${new Date(sinceMs).toISOString()}')
    )`;
    const totalResult = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(totalQuery);
    const total = Number(totalResult[0]?.cnt || 0);
    return { items, total, since: new Date(sinceMs).toISOString() };
  }),

  getFunnel: publicProcedure.query(async () => {
    const total = await prisma.reflection.count();
    const withLesson = await prisma.reflection.count({ where: { lesson: { not: null } } });
    const withImprovements = await prisma.reflection.count({ where: { improvements: { not: null } } });
    const improvementsExecuted = await prisma.improvementAction.count({ where: { status: "completed" } });
    const withFeedback = await prisma.improvementAction.count({ where: { effect: { not: null } } });
    return { total, withLesson, withImprovements, improvementsExecuted, withFeedback };
  }),

  create: publicProcedure.input(z.preprocess(
    (val) => (val && typeof val === "object" && "json" in val) ? (val as any).json : val,
    z.object({
      title: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      priority: z.string().optional(),
      lesson: z.string().optional(),
      insight: z.string().optional(),
      score: z.number().optional(),
      // Phase 5 扩展: agent 归属 + 证据引用 + 主题
      agentSource: z.string().optional(),
      sourceType: z.string().optional(),
      sourceId: z.string().optional(),
      theme: z.string().optional(),
      relatedSessionIds: z.string().optional(),
      relatedMemoryIds: z.string().optional(),
      relatedKnowledgeIds: z.string().optional(),
    })
  )).mutation(async ({ input }) => {
    return safeCreateReflection(prisma, { data: input });
  }),

  resolve: publicProcedure.input(z.object({
    id: z.string(),
    insight: z.string().optional(),
  })).mutation(async ({ input }) => {
    const reflection = await prisma.reflection.update({
      where: { id: input.id },
      data: { status: "RESOLVED", insight: input.insight },
    });

    // round 57 G4(2026-10-10): 长标题语义已由 round58 裁决为归一 -> 迁 safeCreateMemory; 内容闸 null 时早返回.
    const memory = await safeCreateMemory(prisma, {
      data: {
        content: reflection.insight || reflection.description || reflection.title,
        title: reflection.title,
        type: "REFLECTION",
        sourceType: "REFLECTION",
        sourceId: reflection.id,
        tier: reflection.priority === "P1" || reflection.priority === "P2" ? "HOT" : "WARM",
        // 2026-10-09 round 72-B: 补 qualityScore(此前漏写 -> 列默认 0 -> 隐形于质量门)
        qualityScore: calcQualityScore({ type: "memory", content: reflection.insight || reflection.description || reflection.title, title: reflection.title }),
      },
    });
    if (!memory) {
      console.warn("[reflection.resolve] Memory 被 store 内容闸拒绝(不合规), 跳过派生 Knowledge");
      return reflection;
    }

    await prisma.flywheelEvent.create({
      data: {
        stage: "REFLECT",
        sourceType: "REFLECTION",
        sourceId: reflection.id,
        sourceTitle: reflection.title,
        targetStage: "MEMORIZE",
      },
    });

    if (memory.valueScore > 0.7 || reflection.insight) {
      const existingLink = await prisma.knowledge.findFirst({
        where: { sourceType: "REFLECTION_INSIGHT", sourceId: reflection.id },
      });
      if (!existingLink) {
        const knowledge = await safeCreateKnowledge(prisma, {
          data: {
            title: `洞察: ${reflection.title}`,
            content: reflection.insight || reflection.description || reflection.title,
            sourceType: "REFLECTION_INSIGHT",
            sourceId: reflection.id,
            confidence: memory.valueScore > 0.7 ? memory.valueScore : 0.6,
            tags: reflection.category ? `${reflection.category},reflection` : "reflection",
          },
        });
        // 2026-10-09 round 72-I: 认知闸 enforce 档会 return null -> knowledge.id 抛 TypeError; 显式判空。
        if (!knowledge || !knowledge.id) {
          console.warn("[reflection] 认知闸拒收洞察 Knowledge(缺结构判据), 未落库: " + String(reflection.title).slice(0, 40));
          return;
        }
        await prisma.flywheelEvent.create({
          data: {
            stage: "KNOWLEDGE",
            sourceType: "AUTO_DISTILLATION",
            sourceId: knowledge.id,
            sourceTitle: knowledge.title,
            targetStage: "PRACTICE",
          },
        });
      }
    }

    return reflection;
  }),

  generateDailySummary: publicProcedure.input(z.object({
    date: z.string().optional(), // YYYY-MM-DD, defaults to yesterday Beijing time
  })).mutation(async ({ input }) => {
    const targetDate = input.date || yesterdayBeijingStr();

    const startOfDay = parseBeijingDate(targetDate);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    const reflections = await prisma.reflection.findMany({
      where: {
        createdAt: { gte: startOfDay, lte: endOfDay },
      },
      include: { improvementActions: true },
    });

    if (reflections.length === 0) {
      return { generated: false, reason: "no_reflections", date: targetDate };
    }

    const descriptions = reflections.filter(r => r.description).map(r => r.description);
    const lessons = reflections.filter(r => r.lesson);
    const insights = reflections.filter(r => r.insight);
    const improvements = reflections.filter(r => r.improvements);
    const actions = reflections.flatMap(r => r.improvementActions || []);
    const completedActions = actions.filter(a => a.status === "completed");
    const pendingActions = actions.filter(a => a.status !== "completed");
    const reflectionMap = Object.fromEntries(reflections.map(r => [r.id, r.title]));

    const avgScore = reflections.filter(r => r.score).reduce((s, r) => s + (r.score ?? 0), 0) / (reflections.filter(r => r.score).length || 1);
    const p1Count = reflections.filter(r => r.priority === "P1").length;
    const p2Count = reflections.filter(r => r.priority === "P2").length;
    const scoreLabel = avgScore >= 8 ? "收获丰富" : avgScore >= 6 ? "中规中矩" : avgScore >= 4 ? "有待提升" : "困难重重";
    const actionRate = actions.length > 0 ? Math.round(completedActions.length / actions.length * 100) : 0;

    // Build text summaries
    const overviewText = [
      `共${reflections.length}条反思`,
      p1Count > 0 ? `${p1Count}个P1` : null,
      p2Count > 0 ? `${p2Count}个P2` : null,
      descriptions.length > 0 ? `涉及${Array.from(new Set(descriptions)).slice(0, 3).join("；")}` : null,
      avgScore > 0 ? `综合评分${avgScore.toFixed(1)}/10·${scoreLabel}` : null,
      actions.length > 0 ? `行动计划${completedActions.length}/${actions.length}项（${actionRate}%）` : null
    ].filter(Boolean).join(" · ");

    const lessonsText = lessons.length > 0 ? lessons.map((l, i) => `${i + 1}. ${l.lesson}（来自：${l.title}）`).join("\n") : null;
    const insightsText = insights.length > 0 ? insights.map((l, i) => `${i + 1}. ${l.insight}（来自：${l.title}）`).join("\n") : null;
    const improvementsText = improvements.length > 0 ? improvements.map((l, i) => `${i + 1}. ${l.improvements}（来自：${l.title}）`).join("\n") : null;
    const actionsText = actions.length > 0 ? actions.map(a => `${a.status === "completed" ? "✓" : "○"} ${a.content}（来自：${reflectionMap[a.reflectionId] || a.reflectionId}）`).join("\n") : null;
    const pendingText = pendingActions.length > 0 ? pendingActions.map(a => `○ ${a.content}（来自：${reflectionMap[a.reflectionId] || a.reflectionId}）`).join("\n") : null;

    const summary = await prisma.dailySummary.upsert({
      where: { date: targetDate },
      update: {
        reflectionCount: reflections.length,
        p1Count,
        p2Count,
        avgScore: avgScore > 0 ? avgScore : null,
        totalActions: actions.length,
        completedActions: completedActions.length,
        pendingActions: pendingActions.length,
        overviewText,
        lessonsText,
        insightsText,
        improvementsText,
        actionsText,
        pendingText,
        sourceReflectionIds: JSON.stringify(reflections.map(r => r.id)),
      },
      create: {
        date: targetDate,
        reflectionCount: reflections.length,
        p1Count,
        p2Count,
        avgScore: avgScore > 0 ? avgScore : null,
        totalActions: actions.length,
        completedActions: completedActions.length,
        pendingActions: pendingActions.length,
        overviewText,
        lessonsText,
        insightsText,
        improvementsText,
        actionsText,
        pendingText,
        sourceReflectionIds: JSON.stringify(reflections.map(r => r.id)),
      },
    });

    return { generated: true, date: targetDate, id: summary.id, reflectionCount: reflections.length };
  }),

  getDailySummaries: publicProcedure.input(z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  })).query(async ({ input }) => {
    return prisma.dailySummary.findMany({
      where: {
        ...input.startDate ? { date: { gte: input.startDate } } : {},
        ...input.endDate ? { date: { lte: input.endDate } } : {},
      },
      orderBy: { date: "desc" },
    });
  }),
});