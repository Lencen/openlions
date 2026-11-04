// 🟡 最小 Store 实现 (agent-e 2026-07-29)
// 直接转发到 PrismaClient，不做额外抽象
// V2 重构时替换为真实 modules 实现

type PrismaClient = any;

export class PrismaTaskStore {
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
      this.prisma.task.findMany({ where, skip: (page-1)*pageSize, take: pageSize, orderBy: { createdAt: 'desc' } }),
      this.prisma.task.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }
  async get(input: any): Promise<any> {
    return this.prisma.task.findUnique({ where: { id: input.id || input } });
  }
  async create(data: any): Promise<any> {
    return this.prisma.task.create({ data });
  }
}

export const __PLACEHOLDER__ = true;

// ==================== agent-x #6: `delegate_task` 原地接力 (失败自动重派) ====================
// 平台侧重派策略/包装; 详见 src/delegate-relay.ts 顶部注释与 docs/platform-logic/delegate-relay-2026-09-24.md。
export {
  DELEGATE_TASK_TOOL,
  stableDelegationId,
  truncateUtf8,
  extractPartial,
  extractError,
  defaultIsSuccess,
  buildRedispatchRequest,
  runDelegateTaskWithRelay,
  wrapDelegateTask,
  dispatchDelegateInBackground,
} from "./delegate-relay";
export type {
  DelegateRequest,
  DelegateResult,
  DelegateAdditionalContext,
  DelegateRelayPolicy,
  DelegateRelayOutcome,
  DelegateEscalation,
  RelayAttempt,
  RelayStatus,
  BackgroundDispatch,
} from "./delegate-relay";
