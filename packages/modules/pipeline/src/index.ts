// 🟡 最小 Store 实现 (agent-e 2026-07-29)
// 直接转发到 PrismaClient，不做额外抽象
// V2 重构时替换为真实 modules 实现

type PrismaClient = any;

export class PrismaPipelineStore {
  constructor(private prisma: PrismaClient) {}

}

export async function triggerVersionLinkage(...args: any[]): Promise<any> { return null; }
export async function processPipeline(...args: any[]): Promise<any> { return null; }
export async function runPipeline(...args: any[]): Promise<any> { return null; }
export async function scanSources(...args: any[]): Promise<any> { return { newCount: 0, total: 0 }; }

export const __PLACEHOLDER__ = true;
