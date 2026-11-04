import { z } from "zod";
import { createRouter, publicProcedure, protectedProcedure, readerProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { PrismaMemoryStore } from "@lions/modules-memory";
import { isQuickFilter, memoryQuickWhere } from "../lib/cognitive-quick-filter";
import { rangeSince } from "@/lib/range";
// 2026-10-07 round 53: 受控枚举投影 + 质量分单一天平(本端点原先直写 input.domain 且漏写质量分)
import { projectDomain } from "../pipeline/enum-projection";
import { calcQualityScore } from "../pipeline/db-writer";
// 2026-10-23 资产归属 R2: 判据收敛到 asset-scope（memory-permission 已降级为兼容 shim）
import { readableWhere, canRead, isAdminActor, isEnforcementOn, toAssetActor, scopeSqlFragment, memoryWriteFields } from "../pipeline/asset-scope";
import { resolveWriteVisibility } from "../pipeline/asset-policy";
import { recordAudit } from "../lib/audit-log";

const memoryStore = new PrismaMemoryStore(prisma);

export const memoryRouter = createRouter({
  // 2026-06-17 P3 修复: list/get/getTierDistribution/getDomainDistribution 改回 publicProcedure
  // 早上 P3-14 改成 protectedProcedure 是过度保护, 导致 dashboard 全空
  // 根因: 前端 fetch 没带 x-api-key header → 401 → stats=0 → Empty 渲染
  //   - DB 实际有 5272 条 memory, 但页面 4 张 KPI 卡全 0
  //   - read 类端点不需要 attribution, 改 public (跟 knowledge/practice/reflection 一致)
  //   - write 类端点 (create) 保持 protected (写入必须记录 agent_source)
  //
  // P3-9 修复 (保持): tRPC v11 client 把 input 包装成 {json:{...}},server 端 zod 拿到的是包装对象
  //   - z.preprocess 先拆 json 包装(向后兼容裸对象,这样 v10 v11 client 都能用)
  //   - 改用 raw SQL + 类型化 where,确保 tier/search filter 真正生效
  //   - 修后: tier=HOT 单独查 total=2638; tier=HOT+search=dashboard total=137
  //   详见: docs/SHARED-BRAIN-V2-P3-REPORT.md §P3-9
  // 2026-10-23 R2: 改 readerProcedure（可选身份）。不带 key 的 console 走匿名视图，行为在"无 owner 行"上与旧版一致。
  list: readerProcedure
    .input(
      z.preprocess(
        (val) => {
          if (val && typeof val === "object" && "json" in (val as any)) {
            return (val as any).json;
          }
          return val;
        },
        z.object({
          tier: z.string().optional(),
          domain: z.string().optional(),
          type: z.string().optional(),
          search: z.string().optional(),
          theme: z.string().optional(),
          sourceType: z.string().optional(),
          activeOnly: z.boolean().optional(),
          page: z.number().default(1),
          pageSize: z.number().default(20),
          sortBy: z.enum(["createdAt", "updatedAt", "importance", "valueScore"]).default("updatedAt"),
          sortOrder: z.enum(["asc", "desc"]).default("desc"),
          // 2026-09-14 UI-7: 常用快捷筛选 (高质量/近7天/被引用过/待复核)
          quick: z.enum(["highQuality", "recent7d", "referenced", "pendingReview"]).optional(),
          // 2026-10-13 round 76-CJ: 顶栏全局时间范围(③)。口径与 quick.recent7d 一致 = **createdAt**。
          range: z.enum(["1h", "24h", "7d", "30d", "all"]).optional(),
        })
      )
    )
    .query(async ({ input, ctx }) => {
      const where: any = {};
      if (input.tier) where.tier = input.tier;
      if (input.domain) where.domain = input.domain;
      if (input.type) where.type = input.type;
      if (input.sourceType) where.sourceType = input.sourceType;
      if (input.theme) where.theme = input.theme;
      if (input.activeOnly) where.supersededBy = null;
      if (input.search) {
        where.OR = [
          { content: { contains: input.search } },
          { summary: { contains: input.search } },
          { title: { contains: input.search } },
        ];
      }
      // 2026-09-14 UI-7: 快捷筛选只作用于有效记录 (归档链上的旧记录不进筛选结果)
      if (isQuickFilter(input.quick)) {
        where.supersededBy = null;
        where.AND = [...(where.AND ?? []), memoryQuickWhere(input.quick)];
      }
      // 2026-10-23 R2: 归属过滤与 search 的 OR 用 AND 组合（不能覆盖 search）。
      const actor = toAssetActor(ctx.actor);
      const scope = readableWhere(actor, { kind: "memory" });
      const scopeEnforced = Object.keys(scope).length > 0;
      if (scopeEnforced) where.AND = [...(where.AND ?? []), scope];
      // 2026-10-13 round 76-CJ: opt-in 时间窗 —— 只有显式传 range 才按 createdAt 过滤(all = 不过滤)。
      const rs = rangeSince(input.range);
      if (rs) (where as any).createdAt = { gte: rs };

      const orderBy: any = {};
      orderBy[input.sortBy] = input.sortOrder;
      const [items, total] = await Promise.all([
        prisma.memory.findMany({
          where,
          orderBy,
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
          select: {
            id: true, content: true, summary: true, title: true, tier: true,
            type: true, domain: true, valueScore: true, accessCount: true,
            tags: true, sourceType: true, sourceId: true, linkedTo: true,
            filePath: true, theme: true, agentSource: true, reinforceCount: true,
            supersededBy: true, importance: true, qualityScore: true,
            createdAt: true, updatedAt: true, lastAccessed: true,
            // 2026-10-23 R-contract: 归属字段**增量**暴露给前端（前端线要按 owner/visibility 渲染）
            ownerAgentId: true, memoryScope: true,
          },
        }),
        prisma.memory.count({ where }),
      ]);
      // 前端需要区分「本来就没有」和「按归属过滤掉了」：meta 是增量字段，老调用方忽略即可。
      return { items, total, meta: { scope: isEnforcementOn() ? "enforced" : "off", enforced: isEnforcementOn(), filtered: scopeEnforced, actor: { agentId: actor?.agentId ?? null, role: actor?.role ?? null }, admin: isAdminActor(actor) } };
    }),

  // 2026-06-17 P3 修复: get 端点 改回 publicProcedure (跟 list 一致, 单条 memory 读)
  // 注: 原 protectedProcedure 时顺手加了 accessCount++ 副作用,
  //     public 后保留这个读热度统计逻辑 (best-effort, 失败不影响返回)
  // 2026-10-23 R2: 单条读也判归属；无权读 = 返回 null（不泄露"存在但不可见"）。
  get: readerProcedure.input(z.string()).query(async ({ input, ctx }) => {
    const row = await memoryStore.get(input);
    return canRead(toAssetActor(ctx.actor), row, "memory") ? row : null;
  }),

  // 2026-06-17 P3 修复: 统计类端点 改回 publicProcedure (跟 list/get 一致)
  getTierDistribution: publicProcedure.query(async () => {
    return memoryStore.getTierDistribution();
  }),

  getDomainDistribution: publicProcedure.query(async () => {
    return memoryStore.getDomainDistribution();
  }),

  // P4 新增: 主题分组概览 (飞轮结构化展示用)
  themeSummary: readerProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in (val as any)) return (val as any).json;
        return val;
      },
      z.object({
        activeOnly: z.boolean().default(true),
      }).optional()
    ))
    .query(async ({ input, ctx }) => {
      const activeOnly = input?.activeOnly ?? true;
      // 2026-10-23 R2: 裸 SQL 聚合同样按归属过滤（scopeSqlFragment 与 readableWhere 同源）。
      const scopeFrag = scopeSqlFragment(toAssetActor(ctx.actor), "memory");
      const conds = [activeOnly ? "supersededBy IS NULL" : "", scopeFrag].filter(Boolean);
      const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
      const rows = await prisma.$queryRawUnsafe(`
        SELECT
          COALESCE(theme, '(未分类)') as theme,
          COUNT(*) as totalCount,
          SUM(CASE WHEN supersededBy IS NULL THEN 1 ELSE 0 END) as activeCount,
          SUM(CASE WHEN supersededBy IS NOT NULL THEN 1 ELSE 0 END) as supersededCount,
          AVG(CASE WHEN supersededBy IS NULL THEN importance ELSE NULL END) as avgImportance,
          MAX(CASE WHEN supersededBy IS NULL THEN updatedAt ELSE NULL END) as latestUpdate
        FROM Memory
        ${where}
        GROUP BY COALESCE(theme, '(未分类)')
        ORDER BY activeCount DESC
        LIMIT 100
      `);
      // BigInt -> Number/string (SQLite COUNT/SUM/MAX 返回 BigInt, tRPC 不能序列化)
      return (rows as any[]).map(r => ({
        theme: String(r.theme),
        name: String(r.theme),  // 前端用 name 字段
        totalCount: Number(r.totalCount),
        activeCount: Number(r.activeCount),
        supersededCount: Number(r.supersededCount),
        avgImportance: r.avgImportance ? Number(r.avgImportance) : 0,
        latestUpdate: r.latestUpdate ? String(r.latestUpdate) : null,
      }));
    }),

  // P4 新增: 按主题分页查询 (支持 activeOnly + theme 过滤)
  // 2026-10-20 B1: 按 agent 作用域读取（agent 自带 x-api-key）。管理员读全部；普通 agent 读"无主 + shared + 自己的"。
  //   保留既有 list/get 不动（console 管理端仍走 public），避免打断现有界面。
  listScoped: protectedProcedure
    .input(z.object({ page: z.number().default(1), pageSize: z.number().default(20), search: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const actor = toAssetActor((ctx as any).actor) ?? toAssetActor({ agentId: (ctx as any).agent?.agent_id ?? null, role: null });
      const where: any = readableWhere(actor, { kind: "memory" });
      // A1 审计：**身份管理员**越权读全库留痕；root_admin 是平台自身（console），常规读不刷 AuditLog。
      if (isAdminActor(actor) && actor?.agentId) {
        await recordAudit({
          entityType: "Memory", entityId: "*", action: "memory.read.all",
          actor: actor.agentId, actorType: (ctx as any).actor?.kind ?? "identity_admin",
          metadata: { page: input.page, pageSize: input.pageSize, search: input.search ?? null },
        });
      }
      if (input.search) {
        where.AND = [{ OR: [
          { content: { contains: input.search } },
          { summary: { contains: input.search } },
          { title: { contains: input.search } },
        ] }];
      }
      const [items, total] = await Promise.all([
        prisma.memory.findMany({
          where, orderBy: { updatedAt: "desc" },
          skip: (input.page - 1) * input.pageSize, take: input.pageSize,
          select: { id: true, content: true, summary: true, title: true, tier: true, type: true, domain: true,
            sourceType: true, theme: true, agentSource: true, ownerAgentId: true, memoryScope: true, createdAt: true, updatedAt: true },
        }),
        prisma.memory.count({ where }),
      ]);
      return { items, total, page: input.page, pageSize: input.pageSize, actor: { agentId: actor?.agentId ?? null, role: actor?.role ?? null }, admin: isAdminActor(actor) };
    }),

  listByTheme: readerProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in (val as any)) return (val as any).json;
        return val;
      },
      z.object({
        theme: z.string().optional(),
        activeOnly: z.boolean().default(true),
        sourceType: z.string().optional(),
        page: z.number().default(1),
        pageSize: z.number().default(20),
      })
    ))
    .query(async ({ input, ctx }) => {
      const where: any = {};
      if (input.activeOnly) where.supersededBy = null;
      if (input.theme && input.theme !== "(未分类)") where.theme = input.theme;
      if (input.theme === "(未分类)") where.theme = null;
      if (input.sourceType) where.sourceType = input.sourceType;
      // 2026-10-23 R2: 归属过滤
      const scope = readableWhere(toAssetActor(ctx.actor), { kind: "memory" });
      if (Object.keys(scope).length) where.AND = [...(where.AND ?? []), scope];

      const [items, total] = await Promise.all([
        prisma.memory.findMany({
          where,
          orderBy: { importance: "desc" },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        prisma.memory.count({ where }),
      ]);
      return { items, total };
    }),

  // P3-14: create 端点 (protectedProcedure + ctx.agent.agent_source)
  create: protectedProcedure
    .input(z.preprocess(
      (val) => {
        if (val && typeof val === "object" && "json" in val) return (val as any).json;
        return val;
      },
      z.object({
        content: z.string(),
        title: z.string().optional(),
        tier: z.string().default("WARM"),
        type: z.string().optional(),
        domain: z.string().optional(),
        tags: z.string().optional(),
        importance: z.number().optional(),
        decayScore: z.number().optional(),
        agentSource: z.string().optional(),
        sourceType: z.string().optional(),
        sourceId: z.string().optional(),
        // 2026-10-23 R3: 归属可见性（owner 由服务端从 x-api-key 身份推导，客户端不能指定 owner）
        visibility: z.enum(["private", "shared", "global"]).optional(),
      })
    ))
    .mutation(async ({ input, ctx }) => {
    const sourceAgent = input.agentSource || ctx.agent.agent_id;
    // 2026-10-23 R3: 有身份写入 = 归属到该身份；无身份(理论上不会走到这里) = NULL 公共行。
    // 2026-10-26 策略：可见性由平台策略/agent 注册选择决定（平台 public/private 强制，agent_choice 时可用逐条参数覆盖）。
    const policy = await resolveWriteVisibility(toAssetActor((ctx as any).actor), "memory", input.visibility);
    const ownerFields = { ownerAgentId: policy.ownerAgentId, memoryScope: policy.visibility };
    return memoryStore.create({
      ownerAgentId: ownerFields.ownerAgentId,
      memoryScope: ownerFields.memoryScope,
      content: input.content,
      title: input.title,
      tier: input.tier,
      type: input.type,
      // 2026-10-07: 调用方(agent/console)传的 domain 是自由文本 -> 过投影, 不命中落 null
      domain: projectDomain(input.domain, { title: input.title, content: input.content }),
      tags: input.tags,
      // 2026-10-07: 本端点原先漏写质量分 -> 落库即 0 分(列默认), 产物隐形于质量读数
      qualityScore: calcQualityScore({ type: "memory", content: input.content, title: input.title, tags: input.tags, valueScore: input.importance ?? 0.5 }),
      importance: input.importance,
      decayScore: input.decayScore,
      agentSource: sourceAgent,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
  }),
});
