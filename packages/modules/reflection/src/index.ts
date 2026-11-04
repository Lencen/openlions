// 🟡 最小 Store 实现 (agent-e 2026-07-29)
// 直接转发到 PrismaClient，不做额外抽象
// V2 重构时替换为真实 modules 实现

type PrismaClient = any;

export class PrismaReflectionStore {
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
      this.prisma.reflection.findMany({ where, skip: (page-1)*pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
      this.prisma.reflection.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
  async get(input: any): Promise<any> {
    return this.prisma.reflection.findUnique({ where: { id: input.id || input } });
  }
  async create(data: any): Promise<any> {
    return this.prisma.reflection.create({ data });
  }
}

export const __PLACEHOLDER__ = true;
