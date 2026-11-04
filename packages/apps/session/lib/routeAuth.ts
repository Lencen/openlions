/**
 * v1 API 双轨鉴权 helper (2026-09-02)
 *
 * 对齐 upload 端点的 V3 auth, 让已接入 agent 用自己的 sk-mind-* 密钥读平台数据:
 *   ① 固定 key 白名单 (LIONS_UPLOAD_API_KEYS, 默认 lions-session-dev-key)
 *      — mind puller / 管理工具用, 可跨 agent 读写 (agentId 由请求方指定)
 *   ② sk-mind-* agent key — 查 mind DB AgentServicePermission (见 mindAuth.ts),
 *      返回该 key 对应的 agent_id, 读取范围限定为该 agent 自有数据
 */
import { requireSecret } from "./secret";
import { verifyMindApiKey } from "@/lib/mindAuth";

export type AuthOutcome =
  | { ok: true; via: "whitelist"; agentId: null; permissions: null }
  | { ok: true; via: "mind"; agentId: string; permissions: string[] }
  | { ok: false; error: string };

export async function authorizeApiKey(apiKey: string | null): Promise<AuthOutcome> {
  if (!apiKey) {
    return { ok: false, error: "X-API-Key 缺失或无效" };
  }
  const raw = requireSecret("LIONS_UPLOAD_API_KEYS");
  const allowed = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (allowed.includes(apiKey)) {
    return { ok: true, via: "whitelist", agentId: null, permissions: null };
  }
  if (apiKey.startsWith("sk-mind-")) {
    const result = await verifyMindApiKey(apiKey);
    if (!result.agentId) {
      return { ok: false, error: `mind api_key 无效: ${result.error}` };
    }
    return { ok: true, via: "mind", agentId: result.agentId, permissions: result.permissions || [] };
  }
  return { ok: false, error: "X-API-Key 缺失或无效" };
}

/** agent key 是否被授权跨 agent 读会话 (lions_session perm 含 read:all, 管理员在 console 授权) */
export function canReadAll(auth: AuthOutcome): boolean {
  // 2026-10-14: AuthOutcome 是判别联合, 失败分支 {ok:false, error} 上**没有** via/permissions,
  //   原实现直接取 auth.via 只在"调用方已确保 ok"的前提下偶然成立 —— 属真实的类型脱节, 不是声明缺失。
  //   显式短路失败分支后语义与运行期完全一致: 失败结果上 auth.via 本就是 undefined,
  //   原表达式同样返回 false。两个调用点 (app/api/v1/sessions/route.ts:121、
  //   app/api/v1/sessions/[sessionUid]/route.ts:82) 都在 `if (!auth.ok) return` 之后,
  //   因此这里的兜底返回 false 是行为等价且更安全。
  if (!auth.ok) return false;
  return auth.via === "mind" && (auth.permissions || []).includes("read:all");
}
