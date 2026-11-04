/**
 * agent-memory-snapshot.ts — cronjob 执行期上下文: 主 agent 核心 memory 快照捕获+注入
 * (2026-09-23, uos20 #5 机制修复, 待办 todo_uos20fb_1790047372341_5)
 *
 * 背景(由待办升级任务驱动, operator 拍板"你继续处理吧"):
 *   uos20 P1 #5: cronjob 执行时没有主 agent 的上下文, 平台改进任务由 system executor
 *   (cron:v16:improving-tasks) 跑, 看不到主 agent 沉淀的核心 memory —— 执行期上下文断层。
 *   方案(平台记忆已拍板的设计决策):
 *     - 双段机制: 快照捕获段(capture) + 执行期注入段(注入 TaskExecution.metadata.agentMemorySnapshot)
 *     - 冻结快照: 每轮 cron 捕获一次, 该轮多次 task 执行共享同一快照(创建时一次快照多次执行一致)
 *     - 快照粒度: 全量(核心层条目的完整 content, 不截摘要; 但按 count + 总字符双重有界, 保证 metadata 可落库)
 *     - 跨 agent 类型: 默认用 cronjob 所属主 agent(env MAIN_AGENT_ID, 默认 agent-operator 平台主运营 agent)
 *     - schemaVersion 字段: worker 读取时校验, 失败回退只读最小集并打日志
 *   "核心 memory" 口径: Memory 表活性行(supersededBy IS NULL) + 核心层(tier ∈ {HOT, GLOBAL})
 *     + importance 降序(重要者优先) + updatedAt 降序决胜 —— 即主 agent 的热工作记忆核心集。
 *
 * 纯查询层 + 纯函数, 不写库; 供 improving-tasks-cron(调度器) / execute-improving-task(注入点) / 探针复用。
 */
import { prisma } from "@/lib/prisma";

export const AGENT_MEMORY_SNAPSHOT_SCHEMA_VERSION = 1;
export const AGENT_MEMORY_SNAPSHOT_DEFAULT_LIMIT = 50;
export const AGENT_MEMORY_SNAPSHOT_MAX_CHARS = 50_000;

export interface AgentMemorySnapshotEntry {
  id: string;
  title: string | null;
  tier: string | null;
  theme: string | null;
  importance: number | null;
  qualityScore: number | null;
  sourceType: string | null;
  content: string;
}

export interface AgentMemorySnapshot {
  schemaVersion: number;
  agentId: string;
  capturedAt: string;
  count: number;
  entries: AgentMemorySnapshotEntry[];
}

/** 主 agent 标识: env MAIN_AGENT_ID 覆盖, 默认平台主运营 agent(agent-operator, 平台待办协调者) */
export function mainAgentId(): string {
  return String(process.env.MAIN_AGENT_ID || "agent-operator").trim();
}

/**
 * 快照捕获段(冻结): 捕获主 agent 核心 memory。
 * 失败不抛异常 —— 返回空 entries(带 schemaVersion 的合法结构), 由调用方决定是否注入。
 * 双重有界: count(limit, 默认 50, 最大 200) + 总字符(maxChars, 默认 50K, 与 MEMORY_SEED_MAX_TOKENS 同量级),
 *   保证 metadata JSON 落库不超限(稳定性约束)。
 */
export async function captureAgentMemorySnapshot(opts: {
  agentId?: string;
  limit?: number;
  maxChars?: number;
} = {}): Promise<AgentMemorySnapshot> {
  const agentId = opts.agentId || mainAgentId();
  const limit = Math.max(1, Math.min(opts.limit ?? AGENT_MEMORY_SNAPSHOT_DEFAULT_LIMIT, 200));
  const maxChars = Math.max(1000, opts.maxChars ?? AGENT_MEMORY_SNAPSHOT_MAX_CHARS);

  const rows = await prisma.memory.findMany({
    where: { supersededBy: null, tier: { in: ["HOT", "GLOBAL"] } },
    select: {
      id: true, title: true, tier: true, theme: true,
      importance: true, qualityScore: true, sourceType: true, content: true,
    },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
    take: limit,
  }).catch((e: unknown) => {
    console.warn(`[agent-memory-snapshot] 捕获主 agent 核心 memory 失败(非致命, 返回空快照): ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    return [] as Array<{ id: string; title: string | null; tier: string | null; theme: string | null; importance: number | null; qualityScore: number | null; sourceType: string | null; content: string }>;
  });

  // 全量 content + 总字符有界: 依序填充, 余量不足时截断最后一条
  const entries: AgentMemorySnapshotEntry[] = [];
  let used = 0;
  for (const r of rows) {
    const content = String(r.content || "");
    const room = maxChars - used;
    if (room <= 0) break;
    const slice = content.slice(0, room);
    entries.push({
      id: r.id,
      title: r.title ?? null,
      tier: r.tier ?? null,
      theme: r.theme ?? null,
      importance: r.importance ?? null,
      qualityScore: r.qualityScore ?? null,
      sourceType: r.sourceType ?? null,
      content: slice,
    });
    used += slice.length;
  }

  return {
    schemaVersion: AGENT_MEMORY_SNAPSHOT_SCHEMA_VERSION,
    agentId,
    capturedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };
}

/** 序列化为 metadata JSON 内的 agentMemorySnapshot 键值(执行期注入段写入用) */
export function serializeAgentMemorySnapshot(snap: AgentMemorySnapshot): string {
  return JSON.stringify({ agentMemorySnapshot: snap });
}

/**
 * 执行期读取段(worker 侧): 从 TaskExecution.metadata 取出并校验 agentMemorySnapshot。
 * 校验失败(缺键 / schemaVersion 不匹配 / 结构非法 / JSON 解析失败) ->
 *   回退只读最小集({schemaVersion, agentId, count:0, entries:[]})并打日志(已拍板决策 4)。
 */
export function readAgentMemorySnapshot(metadataJson?: string | null): AgentMemorySnapshot {
  try {
    if (!metadataJson) throw new Error("metadata 为空");
    const meta = JSON.parse(metadataJson);
    const snap = meta && typeof meta === "object" ? (meta as Record<string, unknown>).agentMemorySnapshot : null;
    if (!snap || typeof snap !== "object") throw new Error("agentMemorySnapshot 键缺失");
    const s = snap as Record<string, unknown>;
    if (s.schemaVersion !== AGENT_MEMORY_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(`schemaVersion 不匹配: 期望 ${AGENT_MEMORY_SNAPSHOT_SCHEMA_VERSION}, 实际 ${String(s.schemaVersion)}`);
    }
    if (!Array.isArray(s.entries)) throw new Error("entries 非数组");
    return snap as unknown as AgentMemorySnapshot;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[agent-memory-snapshot] 快照校验失败, 回退只读最小集: ${msg.slice(0, 160)}`);
    return {
      schemaVersion: AGENT_MEMORY_SNAPSHOT_SCHEMA_VERSION,
      agentId: mainAgentId(),
      capturedAt: new Date().toISOString(),
      count: 0,
      entries: [],
    };
  }
}
