import { prisma } from "@/lib/prisma";
import { llmCalls5h } from "./llm-calls-5h";

/**
 * agent-quota.ts — 任务每日额度的**单一权威源** (2026-09-14, 用户要求: 后台可配置 + 自适应)。
 *
 * 背景(为什么要有这个模块): 额度此前是**消费端 .env 的自律值**(TASK_DAILY_MAX, 默认 60) ——
 *   我(agent-d)在 2026-09-10 写认领循环时硬编码了 20, 09-11 改成可配默认 60。
 *   服务端**完全没有这个概念**, 于是三个后果:
 *     1) 7 台机器各一份, "谁被限住、被什么限住"在看板上看不见;
 *     2) 打满后整段时间不干活, 队列积压却无人知晓(实测 09-14 四个 agent 同一天 60/60 全部停摆);
 *     3) 额度是纯自律, 客户端改一行就能绕过, 不是平台策略。
 *
 * 现在: 额度登记在 **AgentRegistry.profile.quota**(与 capabilityTier 共用同一个 profile —— 同一套
 *   "注册表即权威"的观念, 不新增表), 由服务端在**认领接口**裁决并回传; 消费端的 TASK_DAILY_MAX
 *   退化为"服务端不可达时的本地兜底"。
 *
 * 两档模式:
 *   fixed    : 固定 dailyLimit, 不做任何浮动(需要可预测的 agent 用这档)。
 *   adaptive : 由三个信号动态调整 —— **任务余量**(backlog) / **接口消耗**(llm_calls_5h) / **队列老化**;
 *              并有硬地板 floor > 0 —— 用户明确要求"不想因为上限到了就不工作"。
 */

export type QuotaMode = "fixed" | "adaptive";

export interface QuotaBasis {
  /** 任务余量: 当前可认领的 PENDING 任务数 */
  backlog: number;
  /** 队列老化: 最老 PENDING 的年龄(小时) */
  oldestPendingHours: number;
  /** 接口消耗: 平台滚动 5 小时 LLM 调用数(与指标 PL-COST 同口径) */
  llmCalls5h: number;
  /** 订阅目标上限(PL-COST 的 target, 非硬上限) */
  llmBudget5h: number;
  urgency: number;
  costFactor: number;
  aging: number;
}

export interface AgentQuota {
  agentId: string;
  mode: QuotaMode;
  /** 注册表里登记的基准额度 */
  baseLimit: number;
  /** 本次生效额度(adaptive 下可能不等于 baseLimit) */
  limit: number;
  floor: number;
  ceiling: number;
  /** 今日已认领数(服务端口径: TaskStateTransition -> IN_PROGRESS by actor=agent:<id>) */
  used: number;
  remaining: number;
  basis: QuotaBasis;
  source: "registry" | "default";
  /** 人话说明: 生效额度是怎么来的 */
  reason: string;
}

/** 未登记 agent 的默认额度(用户定: 所有 agent 默认 100)。 */
export const DEFAULT_DAILY_LIMIT = Number(process.env.TASK_QUOTA_DEFAULT || 100);
/** 平台 LLM 调用预算(与 PL-COST target 一致): 用于 costFactor 的分子分母。 */
export const LLM_BUDGET_5H = Number(process.env.TASK_QUOTA_LLM_BUDGET_5H || 4800);
/**
 * 三个因子叠乘的**显式上限**(用户要求可解释、不过冲): 生效额度最多为基准的 N 倍。
 * 为什么需要: 连续函数叠乘实测会给出 100→229(2.3 倍)这种不好解释、也不好预测的读数;
 *   自适应应当"能说明白为什么是这么多", 否则后台改配置的人无法预判自己的改动效果。
 */
export const MAX_FACTOR = Number(process.env.TASK_QUOTA_MAX_FACTOR || 2.0);

/**
 * 出厂基准(仅当注册表没有任何登记时兜底)。用户明确: 默认全 100, 执行体保持 120。
 * 注: 这**不是**硬编码策略 —— 跑一次 bootstrap 就会写进注册表, 之后以注册表为准, 后台可改。
 */
export const BOOTSTRAP_LIMITS: Record<string, number> = {
  "agent-d": 120,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 三信号 -> 额度倍数(纯函数, 便于单测; 不读库)。 */
export function adaptiveFactors(b: { backlog: number; oldestPendingHours: number; llmCalls5h: number; llmBudget5h: number }) {
  // 1) 任务余量: 队列越厚越该多干活; 队列几乎空则没必要烧额度
  // 2026-09-14 验收采纳(agent-e 边界评审): 原档位 1.5/1.25/0.6 有三处问题 ——
  //   (a) 39->40 让配额跳 25%(+ 100->99 让 1.5 跌到 1.25), 在阈值附近会造成群体性振荡;
  //   (b) "队列<=5 -> 0.6" 是**反向激励**: 干得快的 agent 反而被压低配额, 长期会诱导集体降速到 6-39 的甜区;
  //   (c) 档位非等距。
  //   改为: 阶梯收窄到 20% 以内, 且"队列几乎空"时**不再惩罚**(乘以 1.0) —— 队列空时根本没有可领的任务,
  //   配额本来就不是约束, 没有理由处罚快消费者。
  let urgency = 1.0;
  if (b.backlog >= 100) urgency = 1.4;
  else if (b.backlog >= 40) urgency = 1.2;

  // 2) 接口消耗: 平台订阅余量越足越可以多派; 逼近预算则收缩。
  //    用**离散档位**而不是连续插值 —— 连续版本实测给出 1.47 这种"说不出所以然"的乘数,
  //    后台改配置的人无法预判效果。三档的语义分别是"订阅很空/正常/吃紧"。
  const headroom = b.llmBudget5h > 0 ? clamp((b.llmBudget5h - b.llmCalls5h) / b.llmBudget5h, 0, 1) : 1;
  let costFactor = 1.0;
  if (headroom >= 0.8) costFactor = 1.2;       // 平台 5h 调用 < 预算 20% -> 可放量
  else if (headroom <= 0.2) costFactor = 0.5;  // 已吃掉 80% -> 收缩到一半(配合地板, 仍不归零)

  // 3) 队列老化: 老任务压着说明该有人清
  // 2026-09-14 验收采纳: 加"互斥守卫" —— 队列几乎空(<=5)却说最老任务压了 24h+ 是自相矛盾的信号
  //   (说明分配器没把老任务派出去, 那是分配问题, 不该用配额来压)。此时老化因子一律取 1.0。
  let aging = 1.0;
  if (b.backlog <= 5) aging = 1.0;
  else if (b.oldestPendingHours >= 24) aging = 1.2;
  else if (b.oldestPendingHours >= 8) aging = 1.1;

  return { urgency, costFactor, aging };
}

/** 由基准额度 + 三因子算出生效额度(纯函数)。floor 保证"永不归零"。 */
export function computeLimit(baseLimit: number, f: { urgency: number; costFactor: number; aging: number }) {
  // 2026-09-14 验收采纳(agent-e "慢饿死"意见): 地板由 30% 提到 40% —— 30%(普通 agent 30 条/日)
  //   在实际单人日消费量附近, 可能被"慢饿死"; 用户明确要求"不想因为上限到了就不工作"。
  const floor = Math.max(20, Math.round(baseLimit * 0.4));
  const ceiling = Math.max(baseLimit, baseLimit * 3);
  const product = f.urgency * f.costFactor * f.aging;
  const capped = Math.min(product, MAX_FACTOR);   // 显式倍数上限: 最多 2 倍基准
  const raw = baseLimit * capped;
  const limit = Math.round(clamp(raw, floor, ceiling));
  return { limit, floor, ceiling };
}

/** 读注册表里登记的额度配置。 */
async function quotaFromRegistry(agentId: string): Promise<{ baseLimit: number; mode: QuotaMode } | null> {
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT profile FROM AgentRegistry WHERE agent_id = ? LIMIT 1", agentId);
    if (!rows || !rows.length) return null;
    const j = rows[0].profile ? JSON.parse(String(rows[0].profile)) : null;
    const q = j && j.quota;
    if (!q) return null;
    const lim = Number(q.dailyLimit);
    const mode: QuotaMode = q.mode === "fixed" ? "fixed" : "adaptive";
    if (Number.isFinite(lim) && lim > 0) return { baseLimit: Math.trunc(lim), mode };
    return { baseLimit: DEFAULT_DAILY_LIMIT, mode };
  } catch { return null; }
}

/** 今日该 agent 的认领数(服务端口径, 与健康闸门同一张表/同一个 actor 前缀)。 */
export async function usedToday(agentId: string): Promise<number> {
  try {
    const d = new Date();
    const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) n FROM TaskStateTransition WHERE toStatus='IN_PROGRESS' AND actor=? AND createdAt >= ?",
      "agent:" + agentId, startOfDay);
    return Number(rows?.[0]?.n ?? 0);
  } catch { return 0; }
}

/** 队列态势(余量 + 最老年龄), 供 adaptive 使用。 */
export async function queueState(): Promise<{ backlog: number; oldestPendingHours: number }> {
  try {
    const open: any[] = await prisma.$queryRawUnsafe(
      "SELECT COUNT(*) n, MIN(createdAt) oldest FROM Task WHERE status='PENDING' AND (manualReview IS NOT TRUE)");
    const n = Number(open?.[0]?.n ?? 0);
    const oldest = Number(open?.[0]?.oldest ?? 0);
    const hours = oldest > 0 ? Math.max(0, (Date.now() - oldest) / 3600000) : 0;
    return { backlog: n, oldestPendingHours: Number(hours.toFixed(1)) };
  } catch { return { backlog: 0, oldestPendingHours: 0 }; }
}

/** 解析某个 agent 的生效额度。认领接口每次调用都走这里。 */
export async function resolveQuota(agentId: string): Promise<AgentQuota> {
  const reg = await quotaFromRegistry(agentId);
  const baseLimit = reg?.baseLimit ?? BOOTSTRAP_LIMITS[agentId] ?? DEFAULT_DAILY_LIMIT;
  const mode: QuotaMode = reg?.mode ?? "adaptive";
  const [used, q] = await Promise.all([usedToday(agentId), queueState()]);
  const llmCalls5h = await llmCalls5hNow();
  const factors = adaptiveFactors({ backlog: q.backlog, oldestPendingHours: q.oldestPendingHours, llmCalls5h, llmBudget5h: LLM_BUDGET_5H });
  const fixed = { limit: baseLimit, floor: baseLimit, ceiling: baseLimit };
  const calc = mode === "fixed" ? fixed : computeLimit(baseLimit, factors);
  const basis: QuotaBasis = {
    backlog: q.backlog, oldestPendingHours: q.oldestPendingHours,
    llmCalls5h, llmBudget5h: LLM_BUDGET_5H, ...factors,
  };
  const reason = mode === "fixed"
    ? "固定额度(注册表 fixed): " + baseLimit + "/日"
    : "自适应: 基准 " + baseLimit + " × 余量" + factors.urgency + " × 消耗" + factors.costFactor.toFixed(2)
      + " × 老化" + factors.aging + " = " + (factors.urgency * factors.costFactor * factors.aging).toFixed(3)
      + " 倍" + (factors.urgency * factors.costFactor * factors.aging > MAX_FACTOR ? "(已触顶 " + MAX_FACTOR + " 倍)" : "")
      + " -> " + calc.limit + " (地板 " + calc.floor + ", 上限 " + calc.ceiling + ")"
      + " | 队列余量 " + q.backlog + " 条(最老 " + q.oldestPendingHours + "h), 平台 5h 调用 " + llmCalls5h + "/" + LLM_BUDGET_5H;
  return {
    agentId, mode, baseLimit, limit: calc.limit, floor: calc.floor, ceiling: calc.ceiling,
    used, remaining: Math.max(0, calc.limit - used), basis,
    source: reg ? "registry" : "default", reason,
  };
}

/**
 * 平台滚动 5h 的 LLM 调用数(与 PL-COST 同口径)。
 *
 * 2026-10-11 PL-COST 机制修复: 委托给**唯一实现** llm-calls-5h.ts, 不再本地重复一份 SQL。
 *   旧实现本地 catch -> 0, 会把"测不到"伪装成"没用量"(对 cap 指标尤其危险), 且与 goal-gap 的口径会各自漂移。
 *   现口径 value = max(COUNT CALL_LLM, SUM LLM_USE_REAL.calls), 带 prisma->sqlite->快照兜底(永不 null)。
 */
export async function llmCalls5hNow(): Promise<number> {
  const r = await llmCalls5h();
  return r.value;
}

/** 写入/更新某个 agent 的额度配置(后台可配置的落点)。 */
export async function setAgentQuota(agentId: string, patch: { dailyLimit?: number; mode?: QuotaMode; note?: string; by?: string }) {
  const rows: any[] = await prisma.$queryRawUnsafe(
    "SELECT id, profile FROM AgentRegistry WHERE agent_id = ? LIMIT 1", agentId);
  if (!rows || !rows.length) return { ok: false, error: "AGENT_NOT_REGISTERED", agentId };
  let profile: any = {};
  try { profile = rows[0].profile ? JSON.parse(String(rows[0].profile)) : {}; } catch { profile = {}; }
  const prev = profile.quota || {};
  const next = {
    ...prev,
    ...(patch.dailyLimit != null ? { dailyLimit: Math.trunc(patch.dailyLimit) } : {}),
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(patch.note ? { note: patch.note } : {}),
    setBy: patch.by || "api:admin",
    setAt: new Date().toISOString(),
  };
  profile.quota = next;
  await prisma.$executeRawUnsafe(
    "UPDATE AgentRegistry SET profile=?, updated_at=? WHERE agent_id=?",
    JSON.stringify(profile), new Date(), agentId);
  return { ok: true, agentId, quota: next };
}

/** 全量额度表(看板用): 每个登记 agent 的额度 + 今日用量。 */
export async function listAgentQuotas(): Promise<AgentQuota[]> {
  let ids: string[] = [];
  try {
    const rows: any[] = await prisma.$queryRawUnsafe("SELECT agent_id FROM AgentRegistry WHERE status='ACTIVE'");
    ids = rows.map((r) => String(r.agent_id));
  } catch { ids = []; }
  const out: AgentQuota[] = [];
  for (const id of ids) out.push(await resolveQuota(id));
  return out;
}
