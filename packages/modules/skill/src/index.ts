// 🟡 最小 Store 实现 (agent-e 2026-07-29)
// 直接转发到 PrismaClient，不做额外抽象
// V2 重构时替换为真实 modules 实现

type PrismaClient = any;

export class PrismaSkillStore {
  constructor(private prisma: PrismaClient) {}

  async list(opts: any = {}): Promise<{items: any[]; total: number; page: number; pageSize: number}> {
    const page = opts.page || 1;
    const pageSize = opts.pageSize || 20;
    const where: any = {};
    // P1.3 2026-08-28: Skill 表字段是 name (不是 title), search 必须查 name/content
    if (opts.category) where.category = opts.category;
    if (opts.level) where.level = opts.level;
    if (opts.search) where.OR = [
      { name: { contains: opts.search } },
      { content: { contains: opts.search } },
    ];
    if (opts.hasContent === true) where.NOT = [{ content: null }, { content: "" }];
    if (opts.hasContent === false) where.OR = [{ content: null }, { content: "" }];
    // P1.3 2026-08-28: 动态排序 (默认更新时间倒序), 替代写死 createdAt desc
    const sortBy = opts.sortBy || "updatedAt";
    const sortOrder = opts.sortOrder || "desc";
    const orderBy: any = { [sortBy]: sortOrder };
    const [items, total] = await Promise.all([
      this.prisma.skill.findMany({ where, skip: (page-1)*pageSize, take: pageSize, orderBy }),
      this.prisma.skill.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
  async get(input: any): Promise<any> {
    return this.prisma.skill.findUnique({ where: { id: input.id || input } });
  }
  async create(data: any): Promise<any> {
    // 2026-10-08 round 58: 技能名归一(上限 20 字) —— 实测技能名 44.2% 超长
    // 2026-10-09 round 70: 改用**专用**的技能名归一 —— normalizeProductTitle 会产出 "头…尾" 省略号名,
    //   而人类口径明确"名称不能有省略"。normalizeSkillName 只做净化(去模板前缀/去括号补充/去省略号),
    //   **不做有损截断**: 截断会把 'Prisma schema设计与migration' 和 'Prisma ORM与DateTime处理' 一起
    //   塌成 "Prisma", 而写端判据是"同名即同技能" -> 会把不同技能合并掉。超长的留给语义命名(LLM)处理。
    const { normalizeSkillName } = require("@lions/product-contract");
    if (data.name !== undefined) data = { ...data, name: normalizeSkillName(data.name) };
    return this.prisma.skill.create({ data });
  }
}

export function calculateMaturityScore(skill: any): number { return 0; }

export const __PLACEHOLDER__ = true;
