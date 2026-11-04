/**
 * Mind API Key 校验 helper
 *
 * 功能: session 服务用 mind DB 的 AgentServicePermission 表校验 api_key
 * 方案: 用 better-sqlite3 直接查 mind DB (不跨包 PrismaClient, 避免 schema 冲突)
 *
 * D-15 (2026-09-07) 架构说明:
 *   当前单节点部署, 本机只读 mind sqlite 是可接受的耦合; 但若 mind 多实例/独立部署,
 *   必须改走 HTTP 校验 (mind 侧暴露 /api/v1/agent/verify-key), 禁止跨机直连 DB。
 *   路径必须显式配 MIND_DB_PATH (见 .env.local), 不再隐式依赖默认路径, 避免环境漂移。
 *
 * 校验流程:
 *   1. sha256(apiKey) → 查 AgentServicePermission.api_key_hash
 *   2. 验 status=ACTIVE + expires_at > now
 *   3. 返回 agent_id (从 perm.agent_id 拿)
 */
import { createHash } from "crypto";
import { one } from "./mind-pg";

// 2026-10-21 Phase 2: 改为走 mind PG（MIND_DATABASE_URL），不再直读 dev.db

// api_key → agentId+permissions 缓存 (5 分钟 TTL, 避免每次上传都查 DB)
interface CacheEntry {
  agentId: string | null;
  permissions: string[];
  /** 2026-09-18 加: 失败原因也要缓存 —— 否则命中缓存时无 error, 调用方只看到 "无效: undefined" */
  error?: string;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

export interface MindApiKeyResult {
  agentId: string | null;
  permissions?: string[];  // AgentServicePermission.permissions JSON (2026-09-03 加, 供 read:all 判定)
  error?: string;
}

export async function verifyMindApiKey(apiKey: string): Promise<MindApiKeyResult> {
  // 查缓存
  const cached = cache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) {
    // 2026-09-18 修(诊断性 bug): 失败结果原先**不带 error** 就进缓存, 命中缓存返回 {agentId:null} 无 error,
    //   调用方打印成 "mind api_key 无效: undefined" —— 把真实原因(not found / status / expired)藏了一整个 TTL,
    //   实测导致 agent-operator 的上传 401 长时间无法定位。现在 error 一并缓存并透出。
    return { agentId: cached.agentId, permissions: cached.permissions, error: cached.error };
  }

  try {
    const hash = createHash("sha256").update(apiKey).digest("hex");

    const row = (await one(
      `SELECT agent_id, status, expires_at, permissions
       FROM "AgentServicePermission"
       WHERE api_key_hash = $1`,
      hash
    )) as { agent_id: string; status: string; expires_at: string; permissions: string | null } | null;

    if (!row) {
      cache.set(apiKey, { agentId: null, permissions: [], error: "api_key not found in mind DB", expiresAt: Date.now() + CACHE_TTL_MS });
      return { agentId: null, error: "api_key not found in mind DB" };
    }

    if (row.status !== "ACTIVE") {
      cache.set(apiKey, { agentId: null, permissions: [], error: `api_key status=${row.status}`, expiresAt: Date.now() + CACHE_TTL_MS });
      return { agentId: null, error: `api_key status=${row.status}` };
    }

    const expiresAt = new Date(row.expires_at);
    if (expiresAt < new Date()) {
      cache.set(apiKey, { agentId: null, permissions: [], error: `api_key expired at ${row.expires_at}`, expiresAt: Date.now() + CACHE_TTL_MS });
      return { agentId: null, error: `api_key expired at ${row.expires_at}` };
    }

    // 校验通过
    let perms: string[] = [];
    try { perms = row.permissions ? JSON.parse(row.permissions) : []; } catch { perms = []; }
    cache.set(apiKey, { agentId: row.agent_id, permissions: perms, expiresAt: Date.now() + CACHE_TTL_MS });
    return { agentId: row.agent_id, permissions: perms };
  } catch (e: any) {
    return { agentId: null, error: `mind DB error: ${e.message}` };
  }
}
