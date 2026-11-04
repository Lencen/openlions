// 🟡 最小 Store 实现 (agent-e 2026-07-29)
// 直接转发到 PrismaClient，不做额外抽象
// V2 重构时替换为真实 modules 实现

type PrismaClient = any;

export class PrismaPracticeStore {
  constructor(private prisma: PrismaClient) {}

  async list(opts: any = {}): Promise<{items: any[]; total: number; page: number; pageSize: number}> {
    const page = opts.page || 1;
    const pageSize = opts.pageSize || 20;
    const where: any = {};
    if (opts.tier) where.tier = opts.tier;
    if (opts.domain) where.domain = opts.domain;
    // 2026-09-14 fix (落地 task=cmu0boli90hc41j76ge6pihck):
    //   原写法 `{ content: { contains } }` 引用了 Practice 上**不存在**的列(content 是 Knowledge/Skill 的列),
    //   Prisma 直接抛 `Unknown argument content` -> practice.list search 恒 500 ->
    //   mcp-server `mind_query` 的 practice 轴**每次关键词检索都报错**(实测: 见 scripts/finding-premise-check.cjs memory-recall)。
    //   Practice 的正文列是 description; theme 是可检索的主题词。
    if (opts.search) where.OR = [
      { title: { contains: opts.search } },
      { description: { contains: opts.search } },
      { theme: { contains: opts.search } },
    ];
    const [items, total] = await Promise.all([
      this.prisma.practice.findMany({ where, skip: (page-1)*pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
      this.prisma.practice.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
  async get(input: any): Promise<any> {
    return this.prisma.practice.findUnique({ where: { id: input.id || input } });
  }
  async create(data: any): Promise<any> {
    // 2026-10-08 round 55: single-exit gate -- outcome + type 投影
    const { projectPracticeOutcome, normalizeEnumToken, calcQualityScore, normalizeProductTitle } = require("@lions/product-contract");
    // 2026-10-08 round 58: 标题归一(实测 Practice 31.3% 新行标题超长)
    if (data.title !== undefined) data = { ...data, title: normalizeProductTitle(data.title, { max: 30 }) };
    data = { ...data, outcome: projectPracticeOutcome(data.outcome), type: normalizeEnumToken(data.type) ?? data.type };
    // round 56a: qualityScore 兜底
    if (data.qualityScore == null || data.qualityScore === 0) {
      data = { ...data, qualityScore: calcQualityScore({ type: "practice", content: data.description || data.title || "", title: data.title, theme: data.theme, type2: data.type, outcome: data.outcome, difficulty: data.difficulty }) };
    }
    // ===== 2026-10-09 round 72-D 认知闸(人类裁决的"定义"). observe=只记不拦; enforce=真拦 =====
    //   为什么先 observe: 生产者还没全部升级(实测 Memory 的 summary 只 37%、scenario 0%),
    //   直接 enforce 会拒掉大部分新产物。切换: COGNITIVE_GATE_MODE=enforce
    try {
      const _g = require("@lions/product-contract");
      const _v = _g.checkPracticeCompleteness(data);
      if (!_v.ok) {
        // 2026-10-09 round 72-I: 前缀区分 observe/reject(切 enforce 后"被拒多少条"是唯一代价读数)
        const _enforce = typeof _g.cognitiveGateMode === "function" && _g.cognitiveGateMode() === "enforce";
        console.warn("[cognitive-gate:" + (_enforce ? "reject" : "observe") + "] practice " + _v.reason);
        if (_enforce) {
          return null; // 调用方需处理(与 V3 闸同语义)
        }
      }
    } catch (_e) { /* 闸自身异常绝不阻断写入 */ }
    return this.prisma.practice.create({ data });
  }
}

export const __PLACEHOLDER__ = true;
