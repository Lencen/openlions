// 🟡 最小 Store 实现 (agent-e 2026-07-29)
// 直接转发到 PrismaClient，不做额外抽象
// V2 重构时替换为真实 modules 实现

type PrismaClient = any;

export class PrismaFlywheelStore {
  constructor(private prisma: PrismaClient) {}

  async getStatus(): Promise<any> {
    const totalEvents = await this.prisma.flywheelEvent.count();
    const lastEvent = await this.prisma.flywheelEvent.findFirst({ orderBy: { createdAt: 'desc' } });
    const lastEventAt = lastEvent?.createdAt || null;
    const state = !lastEventAt ? 'idle' : (Date.now() - new Date(lastEventAt).getTime() < 5*60*1000 ? 'spinning' : (Date.now() - new Date(lastEventAt).getTime() < 60*60*1000 ? 'slow' : 'idle'));
    return { state, totalEvents, lastEventAt };
  }
  async getSourceTypeCounts(): Promise<any> {
    const rows = await this.prisma.$queryRaw`SELECT "sourceType", COUNT(*) as count FROM "FlywheelEvent" GROUP BY "sourceType"`;
    const result: any = {};
    for (const r of rows) result[r.sourceType] = Number(r.count);
    return result;
  }
  async getTransitionRates(): Promise<any> { return {}; }
}

export const __PLACEHOLDER__ = true;
