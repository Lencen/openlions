// asset-policy.ts — 资产可见性策略（2026-10-26）
//
// 三级配置：
//   1) 平台级（per 资产类型）：public | private | agent_choice
//   2) agent 注册时选择：public | private | inherit（inherit = 跟随平台；平台非 agent_choice 时只能跟随）
//   3) 单条写入（仅当平台=agent_choice 时生效）：private | shared | global
//
// 强制优先级：
//   平台 public  -> 该类资产一律 public（agent 选 private 会被拒绝注册；写入的 private 被忽略）
//   平台 private -> 该类资产一律 private（agent 选 public 会被拒绝注册）
//   平台 agent_choice -> 用 agent 注册时的选择；agent 可在写入时逐条覆盖
//
// 存储：两张表（未进 Prisma schema，避免为此动 client 生成；稳定后再提升建模）
//   platform_asset_policy(asset_type PK, mode)
//   agent_data_policy(agent_id PK, memory_mode, knowledge_mode, skill_mode, accepted_at)
import { prisma } from "@/lib/prisma";

export type AssetKind = "memory" | "knowledge" | "skill";
export type PlatformMode = "public" | "private" | "agent_choice";
export type AgentChoice = "public" | "private";
export type Visibility = "private" | "shared" | "global";

const KINDS: AssetKind[] = ["memory", "knowledge", "skill"];
const CACHE_MS = 30_000;
let platformCache: { at: number; map: Record<AssetKind, PlatformMode> } | null = null;
const agentCache = new Map<string, { at: number; modes: Record<AssetKind, AgentChoice> }>();

function normalizeVisibility(v: unknown): Visibility | null {
  const s = String(v ?? "").toLowerCase();
  return s === "private" || s === "shared" || s === "global" ? (s as Visibility) : null;
}

/** 平台/agent 策略变更后必须调用：清掉进程内缓存，避免 30s 内读到旧值。 */
export function invalidatePolicyCache(agentId?: string | null): void {
  platformCache = null;
  if (agentId) agentCache.delete(String(agentId));
  else agentCache.clear();
}

export async function getPlatformPolicy(force = false): Promise<Record<AssetKind, PlatformMode>> {
  const now = Date.now();
  if (!force && platformCache && now - platformCache.at < CACHE_MS) return platformCache.map;
  const map: Record<AssetKind, PlatformMode> = { memory: "agent_choice", knowledge: "agent_choice", skill: "agent_choice" };
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>("SELECT asset_type, mode FROM platform_asset_policy");
    for (const r of rows || []) {
      const k = String(r.asset_type) as AssetKind;
      const m = String(r.mode) as PlatformMode;
      if (KINDS.includes(k) && ["public", "private", "agent_choice"].includes(m)) map[k] = m;
    }
  } catch {
    // 表不存在/查询失败：退化为 agent_choice（不改变现有行为，存量行本就是公共）
  }
  platformCache = { at: now, map };
  return map;
}

export async function getAgentPolicy(agentId: string | null | undefined): Promise<Record<AssetKind, AgentChoice>> {
  const id = String(agentId || "").trim();
  const def: Record<AssetKind, AgentChoice> = { memory: "public", knowledge: "public", skill: "public" };
  if (!id) return def;
  const hit = agentCache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.modes;
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      "SELECT memory_mode, knowledge_mode, skill_mode FROM agent_data_policy WHERE agent_id = $1", id);
    const r = (rows || [])[0];
    const modes: Record<AssetKind, AgentChoice> = {
      memory: r?.memory_mode === "private" ? "private" : "public",
      knowledge: r?.knowledge_mode === "private" ? "private" : "public",
      skill: r?.skill_mode === "private" ? "private" : "public",
    };
    agentCache.set(id, { at: Date.now(), modes });
    return modes;
  } catch {
    return def;
  }
}

/** 注册时校验：agent 想选什么 vs 平台允许什么。平台非 agent_choice 时只能跟随。 */
export function evaluateRegistrationChoice(
  platform: PlatformMode,
  requested: unknown
): { ok: true; mode: AgentChoice } | { ok: false; code: string; message: string } {
  const want = String(requested ?? "").toLowerCase();
  const explicit = want === "public" || want === "private" ? (want as AgentChoice) : null;
  if (platform === "public") {
    if (explicit === "private") {
      return { ok: false, code: "DATA_POLICY_REJECTED", message: "平台已将该类资产设为全平台公开，不接受 private 注册选择" };
    }
    return { ok: true, mode: "public" };
  }
  if (platform === "private") {
    if (explicit === "public") {
      return { ok: false, code: "DATA_POLICY_REJECTED", message: "平台已将该类资产设为私有，不接受 public 注册选择" };
    }
    return { ok: true, mode: "private" };
  }
  return { ok: true, mode: explicit ?? "public" };
}

/**
 * 纯函数版可见性决策（可单测，不碰数据库）：
 *   无 owner -> global；平台 public -> global；平台 private -> private；
 *   agent_choice -> 请求值优先，否则 agent 选择（private/public）。
 */
export function decideVisibility(
  platform: PlatformMode,
  agentMode: AgentChoice,
  requested: unknown,
  hasOwner: boolean
): { visibility: Visibility; source: "platform" | "agent" | "request" } {
  if (!hasOwner) return { visibility: "global", source: "platform" };
  if (platform === "public") return { visibility: "global", source: "platform" };
  if (platform === "private") return { visibility: "private", source: "platform" };
  const req = normalizeVisibility(requested);
  if (req) return { visibility: req, source: "request" };
  return { visibility: agentMode === "private" ? "private" : "global", source: "agent" };
}

/** 写入时决定可见性：平台 public/private 强制覆盖，agent_choice 时用 agent 选择 + 可选逐条覆盖。 */
export async function resolveWriteVisibility(
  actor: { agentId?: string | null } | null | undefined,
  kind: AssetKind,
  requested?: unknown
): Promise<{ visibility: Visibility; ownerAgentId: string | null; source: "platform" | "agent" | "request" }> {
  const platform = (await getPlatformPolicy())[kind];
  const agentId = actor && actor.agentId ? String(actor.agentId) : null;
  const ownerAgentId = agentId; // 归属仍由身份决定（无身份 = 公共行）
  const mode = ownerAgentId ? (await getAgentPolicy(ownerAgentId))[kind] : "public";
  const decided = decideVisibility(platform, mode, requested, !!ownerAgentId);
  return { visibility: decided.visibility, ownerAgentId, source: decided.source };
}

/** 注册成功后落库（幂等 upsert）。 */
export async function persistAgentPolicy(agentId: string, modes: Record<AssetKind, AgentChoice>): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      "INSERT INTO agent_data_policy (agent_id, memory_mode, knowledge_mode, skill_mode, accepted_at) VALUES ($1,$2,$3,$4, now()) " +
      "ON CONFLICT (agent_id) DO UPDATE SET memory_mode=$2, knowledge_mode=$3, skill_mode=$4, accepted_at=now()",
      agentId, modes.memory, modes.knowledge, modes.skill);
    agentCache.delete(agentId);
  } catch { /* 策略落库失败不阻断注册（保守：退化为默认 public） */ }
}

/** 给注册/诊断接口用的完整策略描述。 */
export async function describePolicies(agentId?: string | null) {
  const platform = await getPlatformPolicy();
  const agent = agentId ? await getAgentPolicy(agentId) : null;
  return { platform, agent };
}
