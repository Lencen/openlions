// 🟡 最小 Store 实现 (agent-e 2026-07-29)
// 直接转发到 PrismaClient，不做额外抽象
// V2 重构时替换为真实 modules 实现

type PrismaClient = any;

// 2026-10-09 round 72-D 遗留项: Knowledge 网状关联 observe 计数
//   与 checkKnowledgeStructure 同一条 observe 铁律 —— 先看候选命中率, 生产者升级后才谈"有关联"落库前提。
//   只做纯统计日志(不拦写), 计数用 product-contract 的统一口径避免两处格式漂移。
const RELATION_LOG_EVERY = 20;
let __relationSeen = 0;
let __relationMissing = 0;

// 2026-10-09 round 72-D 遗留项(落库): 实体索引/已存在边缓存(60s TTL)
//   每次 Knowledge.create 都取全表太贵(实体/边都小, 但写入是热路径); TTL 过期才重取。
const RELATION_CACHE_TTL_MS = 60_000;
let __entityCache: { at: number; rows: any[] } = { at: 0, rows: [] };
let __relationCache: { at: number; rows: any[] } = { at: 0, rows: [] };

export class PrismaKnowledgeStore {
  constructor(private prisma: PrismaClient) {}

  async list(opts: any = {}): Promise<{items: any[]; total: number; page: number; pageSize: number}> {
    const page = opts.page || 1;
    const pageSize = opts.pageSize || 20;
    const where: any = {};
    if (opts.tier) where.tier = opts.tier;
    if (opts.domain) where.domain = opts.domain;
    if (opts.search) where.OR = [
      { title: { contains: opts.search } },
      { content: { contains: opts.search } },
    ];
    const [items, total] = await Promise.all([
      this.prisma.knowledge.findMany({ where, skip: (page-1)*pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
      this.prisma.knowledge.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
  async get(input: any): Promise<any> {
    return this.prisma.knowledge.findUnique({ where: { id: input.id || input } });
  }
  async create(data: any): Promise<any> {
    // 2026-10-08 round 55: single-exit gate -- Knowledge.category 受控投影(实测曾 462 种)
    const { projectCategory, calcQualityScore, normalizeProductTitle } = require("@lions/product-contract");
    // 2026-10-08 round 58: 标题归一(去模板前缀 + 保头保尾压缩) —— 实测 Knowledge 33.9% 新行标题超长
    if (data.title !== undefined) data = { ...data, title: normalizeProductTitle(data.title, { max: 30 }) };
    const _cat = projectCategory(data.category, "knowledge");
    if (_cat !== null) data = { ...data, category: _cat };
    // round 56a: qualityScore 兜底
    if (data.qualityScore == null || data.qualityScore === 0) {
      data = { ...data, qualityScore: calcQualityScore({ type: "knowledge", content: data.content || "", title: data.title, category: data.category, tags: data.tags ? String(data.tags) : null, confidence: data.confidence ?? 0.5, reinforceCount: 0 }) };
    }
    // ===== 2026-10-09 round 72-D 认知闸(人类裁决的"定义"). observe=只记不拦; enforce=真拦 =====
    //   为什么先 observe: 生产者还没全部升级(实测 Memory 的 summary 只 37%、scenario 0%),
    //   直接 enforce 会拒掉大部分新产物。切换: COGNITIVE_GATE_MODE=enforce
    try {
      const _g = require("@lions/product-contract");
      const _v = _g.checkKnowledgeStructure(data);
      if (!_v.ok) {
        // 2026-10-09 round 72-I: 前缀区分 observe/reject(切 enforce 后"被拒多少条"是唯一代价读数)
        const _enforce = typeof _g.cognitiveGateMode === "function" && _g.cognitiveGateMode() === "enforce";
        console.warn("[cognitive-gate:" + (_enforce ? "reject" : "observe") + "] knowledge " + _v.reason);
        if (_enforce) {
          return null; // 调用方需处理(与 V3 闸同语义)
        }
      }
      // ===== round 72-D 遗留项: 网状关联候选 observe(只计数, 不拦) =====
      //   dist 未重建时可能是旧版导出 -> typeof 守卫, 绝不因关联抽取缺位而影响写入。
      if (typeof _g.extractKnowledgeRelations === "function") {
        const _rel = _g.extractKnowledgeRelations({ title: data.title, content: data.content, tags: data.tags });
        __relationSeen++;
        if (_rel && _rel.stats && _rel.stats.missing) __relationMissing++;
        if (__relationSeen === 1 || __relationSeen % RELATION_LOG_EVERY === 0) {
          const _line = typeof _g.knowledgeRelationObserveLineFromCounts === "function"
            ? _g.knowledgeRelationObserveLineFromCounts(__relationMissing, __relationSeen)
            : `[cognitive-gate/relation] missing=${__relationMissing}/total=${__relationSeen}`;
          console.warn(_line);
        }
        // ===== round 72-D 遗留项(落库): 候选 -> KnowledgeRelation =====
        //   name->KnowledgeEntity.id 映射/去重/@@unique 冲突策略全在 product-contract 纯函数;
        //   这里只做"取索引 + 注 adapter"。默认 write(加性旁路: 只新增边, 失败只计 failed 不阻断);
        //   降级/退出: KNOWLEDGE_RELATION_WRITE=observe。认知闸(拦写)仍默认 observe, 未接 enforce。
        if (typeof _g.planKnowledgeRelationWrites === "function") {
          const _write = typeof _g.knowledgeRelationWriteMode === "function" && _g.knowledgeRelationWriteMode() === "write";
          const _t = Date.now();
          if (_t - __entityCache.at > RELATION_CACHE_TTL_MS) {
            __entityCache = { at: _t, rows: await this.prisma.$queryRawUnsafe('SELECT id, name, aliases, type FROM "KnowledgeEntity"') };
          }
          if (_t - __relationCache.at > RELATION_CACHE_TTL_MS) {
            __relationCache = { at: _t, rows: await this.prisma.$queryRawUnsafe('SELECT sourceId, targetId, relationType, weight FROM "KnowledgeRelation"') };
          }
          const _plan = _g.planKnowledgeRelationWrites(_rel, __entityCache.rows, {
            projection: "cooccur",
            existingRelations: __relationCache.rows,
          });
          if (_write && _plan && _plan.writes && _plan.writes.length > 0 && typeof _g.applyKnowledgeRelationPlan === "function") {
            const _adapter = {
              nextRelationId: () => `kr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              insertRelation: async (row: any) => {
                // ON CONFLICT: @@unique(sourceId,targetId,relationType) 兜底(缓存可能过期 -> 不盲插报错)
                await this.prisma.$executeRawUnsafe(
                  `INSERT INTO "KnowledgeRelation" (id, sourceId, targetId, relationType, weight) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT (sourceId, targetId, relationType) DO UPDATE SET weight = max(weight, excluded.weight)`,
                  row.id, row.sourceId, row.targetId, row.relationType, row.weight,
                );
              },
              updateRelationWeight: async (row: any) => {
                await this.prisma.$executeRawUnsafe(
                  `UPDATE "KnowledgeRelation" SET weight = max(weight, ?) WHERE sourceId = ? AND targetId = ? AND relationType = ?`,
                  row.weight, row.sourceId, row.targetId, row.relationType,
                );
              },
            };
            const _res = await _g.applyKnowledgeRelationPlan(_plan, _adapter, { mode: "write" });
            __relationCache = { at: 0, rows: [] }; // 写入后失效, 避免 TTL 内重复分类
            if (_res && _res.failed) console.warn(`[cognitive-gate/relation] apply failed=${_res.failed}`);
          }
          if (__relationSeen === 1 || __relationSeen % RELATION_LOG_EVERY === 0) {
            const _planLine = typeof _g.knowledgeRelationPlanObserveLine === "function"
              ? _g.knowledgeRelationPlanObserveLine(_plan)
              : `[cognitive-gate/relation-plan] writes=${_plan && _plan.writes ? _plan.writes.length : 0}`;
            console.warn(_planLine);
          }
        }
      }
    } catch (_e) { /* 闸自身异常绝不阻断写入 */ }
    return this.prisma.knowledge.create({ data });
  }
  async incrementUsage(input: any): Promise<any> {
    return this.prisma.knowledge.update({ where: { id: input.id }, data: { usageCount: { increment: 1 } } });
  }
  async getGraph(limit: number = 100): Promise<any> { return { nodes: [], edges: [] }; }
}

export function extractTags(text: string): string[] { return []; }
export function extractDomain(text: string): string { return ""; }

export const __PLACEHOLDER__ = true;
