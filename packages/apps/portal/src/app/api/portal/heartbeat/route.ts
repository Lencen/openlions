import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
// 2026-10-15 架构收口(DB-ACCESS-RULE §3.1): 本路由 2 处读走**驱动级只读**句柄(mind-read);
//   写(last_seen_at)已转发 mind `/api/v1/agents/seen` —— portal 对生产库只剩只读。
import { q as mindQuery, asDate } from "@/lib/mind-read";
import { GUIDE_VERSION, resolvePlatformBase } from "@/lib/platform-guide";
import { silentQuery } from "@/lib/dbLog";
import { callMind } from "@/lib/mind-client";

// ═══════════════════════════════════════════════════════════════════════════════════════
// POST /api/portal/heartbeat
// Body: { agentId, host? }
// ═══════════════════════════════════════════════════════════════════════════════════════
// 2026-10-15 (安全问题 4): 本路由原先**无鉴权**, 且只要目标 agent 是 ACTIVE 就把该 agent 的
//   全部 `api_key_plain`(明文服务密钥)返回给**任何**调用者 —— 监听 `*:3006`, 一个 curl 即可
//   拖走某 agent 的全部业务密钥(实测库内 57 条 ACTIVE 授权、50 条带明文)。
//   另: `last_seen_at` 返回的是**客户端自己** `new Date().toISOString()`, 不是库里的值 ——
//   调用方无法判断写是否真的成功(库写失败也照样返回一个"刚刚"的时间)。
//
// 收口原则 = "停止匿名泄露 + 调用者归属 + 不打断现役客户端":
//   · 匿名(无凭据)调用: **仍 200**, 仍返回 status/approved/guide_version/platform_base ——
//     因为 7 台在役 responder 的 `check_guide_version()` 每小时只读 `guide_version`, 且跑的是
//     **已部署的旧版客户端**(不会因服务端改动自动升级), 任何"必须鉴权才可用"的改法都会立刻打断它们;
//   · 匿名调用不再返回任何 `api_key_plain`: `services` 恒为 `{}` + 明确 warning 说明如何鉴权;
//   · 支持两种凭据(二选一, 都能定位"调用者是哪个 agent"):
//       Authorization: Bearer <lions token>  -> sha256 -> AgentRegistry.token_hash (且 status=ACTIVE)
//       X-API-Key: <服务密钥>                -> sha256 -> AgentServicePermission.api_key_hash
//                                                (且 status=ACTIVE 且未过期)
//   · **归属校验**: 凭据只能读**它自己那个 agent** 的数据; 拿 A 的身份请求 B -> **403**;
//   · 写 last_seen: 默认**保持与现役客户端兼容**(匿名也照样回写, 与改动前一致); 需要强制时用
//     环境变量 `PORTAL_HEARTBEAT_WRITE_REQUIRES_AUTH=1` 打开(见下方变量说明与交付报告的灰度步骤);
//   · `last_seen_at` 语义修正: 返回 **mind `/api/v1/agents/seen` 响应里的真实值**(写成功时),
//     写被跳过/失败时返回**库里读到的真实值**(而不是客户端本地时间); 另附 `last_seen_at_source`。
//
// 兼容性论证(为什么 7 个现役 responder 不会断):
//   `scripts/macs-responder/macs_responder.py` 的 `check_guide_version()`: 只发
//   `Content-Type: application/json` + body `{agentId}`, **不带任何 Authorization/X-API-Key**
//   -> 走匿名分支 -> 200 + `guide_version` -> 行为与改动前逐字一致(它对其余字段一无所用)。
//   已部署的 `~/macs-responder/macs_responder.py` 同样只读 `guide_version`(实测同一形态)。
// ═══════════════════════════════════════════════════════════════════════════════════════

/** 与 mind `src/server/lib/service-auth.ts` / portal ingest 同口径: 明文 -> sha256 hex */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * 是否要求"回写 last_seen"必须通过身份校验。
 * **默认关闭**(关闭 = 与改动前一致: 匿名也回写), 保证 7 台在役 responder 的心跳语义不变。
 * 打开(PORTAL_HEARTBEAT_WRITE_REQUIRES_AUTH=1/true/yes/on)后: 匿名调用只读不写,
 *   响应里 `last_seen_written=false` + warning 明示。灰度步骤见交付报告。
 */
function writeRequiresAuth(): boolean {
  const v = String(process.env.PORTAL_HEARTBEAT_WRITE_REQUIRES_AUTH || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

type CallerKind = "anonymous" | "bearer" | "api_key";

interface Caller {
  kind: CallerKind;
  /** 凭据归属的 agent_id(匿名时 null) */
  agentId: string | null;
  /** X-API-Key 命中时是命中的 service_name */
  serviceName: string | null;
}

const ANONYMOUS: Caller = { kind: "anonymous", agentId: null, serviceName: null };

/**
 * 识别调用者。**不抛**:
 *   · 未提供任何凭据 -> anonymous(invalid=false)
 *   · 提供了凭据但无一命中/非 ACTIVE/已过期 -> invalid=true (路由回 401)
 *   · 只读库失败 -> dbError=true (路由回 503, 不静默降级成匿名 —— 否则合法调用会被"悄悄剥掉密钥")
 */
async function identifyCaller(
  req: NextRequest,
): Promise<{ caller: Caller; invalid: boolean; dbError: boolean }> {
  const authHeader = (req.headers.get("authorization") || "").trim();
  const bearer = /^bearer\s+/i.test(authHeader) ? authHeader.replace(/^bearer\s+/i, "").trim() : "";
  const xKey = (req.headers.get("x-api-key") || "").trim();

  if (!bearer && !xKey) return { caller: ANONYMOUS, invalid: false, dbError: false };

  let dbError = false;

  // ① Authorization: Bearer <lions token> -> AgentRegistry.token_hash
  if (bearer) {
    const tokenHash = sha256Hex(bearer);
    const rows = await silentQuery<any[]>(
      () => mindQuery(`SELECT agent_id, status FROM AgentRegistry WHERE token_hash = ?`, tokenHash),
      [],
      "heartbeat.auth.token",
      () => { dbError = true; },
    );
    if (dbError) return { caller: ANONYMOUS, invalid: true, dbError: true };
    const row = rows[0];
    if (row && row.status === "ACTIVE") {
      return {
        caller: { kind: "bearer", agentId: String(row.agent_id), serviceName: null },
        invalid: false,
        dbError: false,
      };
    }
  }

  // ② X-API-Key <服务密钥> -> AgentServicePermission.api_key_hash (+ACTIVE+未过期)
  if (xKey) {
    const keyHash = sha256Hex(xKey);
    const rows = await silentQuery<any[]>(
      () =>
        mindQuery(
          `SELECT agent_id, service_name, status, expires_at FROM AgentServicePermission WHERE api_key_hash = ?`,
          keyHash,
        ),
      [],
      "heartbeat.auth.apikey",
      () => { dbError = true; },
    );
    if (dbError) return { caller: ANONYMOUS, invalid: true, dbError: true };
    const row = rows[0];
    // expires_at 在库里是 DATETIME(毫秒整数); Number(Date 对象) 同样是毫秒 —— 两种解码都兜住
    const notExpired = row ? Number(row.expires_at) > Date.now() : false;
    if (row && row.status === "ACTIVE" && notExpired) {
      return {
        caller: {
          kind: "api_key",
          agentId: String(row.agent_id),
          serviceName: row.service_name ? String(row.service_name) : null,
        },
        invalid: false,
        dbError: false,
      };
    }
  }

  return { caller: ANONYMOUS, invalid: true, dbError: false };
}

// - 更新 last_seen_at (2026-10-15 起: 转发 mind `POST /api/v1/agents/seen`, 不再直连写库)
// - 返回 agent 状态 (PENDING/ACTIVE/INACTIVE)
// - ACTIVE + **已通过身份校验**: 返回该 agent 自己的服务密钥(明文)
// - 返回最新 guide version (agent 发现变了就重新拉 /api/portal/guide)
// 2026-09-22 改 silentQuery: prisma 失败时落 logs/portal-dev.log 并返回 503,
//   避免历史(db 异常)被错判成 404 "agent not registered"。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { agentId, host } = body;

  if (!agentId) {
    return NextResponse.json({ ok: false, error: "missing agentId" }, { status: 400 });
  }
  const safeAgent = String(agentId);

  // ① 调用者身份(匿名是**一等公民**: 现役 responder 每小时只取 guide_version, 不带凭据)
  const ident = await identifyCaller(req);
  if (ident.dbError) {
    return NextResponse.json({ ok: false, error: "data_unavailable" }, { status: 503 });
  }
  if (ident.invalid) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_credential",
        message:
          "Authorization( Bearer <lions token> )或 X-API-Key(<你自己的 AgentServicePermission 服务密钥>)无效、已撤销或已过期; 未通过校验的调用者不返回服务密钥。",
      },
      { status: 401 },
    );
  }
  const caller = ident.caller;
  const authenticated = caller.kind !== "anonymous";

  // ② agent 必须已注册(与改造前一致: 未注册 404 / 读库异常 503)
  let dbError: string | null = null;
  const rows = await silentQuery<any[]>(
    () =>
      mindQuery(
        `SELECT agent_id, status, host, last_seen_at FROM AgentRegistry WHERE agent_id = ?`,
        safeAgent,
      ),
    [],
    "heartbeat.lookup",
    () => { dbError = "data_unavailable"; },
  );
  if (dbError) {
    return NextResponse.json({ ok: false, error: "data_unavailable" }, { status: 503 });
  }
  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: "agent not registered" }, { status: 404 });
  }
  const regStatus = rows[0]?.status || "PENDING";
  const dbLastSeen = asDate(rows[0]?.last_seen_at);

  // ③ 归属校验: 凭据只能读**它自己**那个 agent 的东西。拿 A 的身份要 B 的数据 -> 403。
  if (authenticated && caller.agentId !== safeAgent) {
    return NextResponse.json(
      {
        ok: false,
        error: "forbidden",
        message: "身份校验通过, 但凭据只允许访问其自身 agent 的数据。",
        caller_agent_id: caller.agentId,
      },
      { status: 403 },
    );
  }

  const warnings: string[] = [];

  // ④ 心跳回写 last_seen_at(2026-10-15 架构收敛: 转发 mind `POST /api/v1/agents/seen`)
  //    失败**非致命**: 心跳的主职是"返回状态/服务密钥/guide 版本", 写时间戳是附带效果。
  //    `PORTAL_HEARTBEAT_WRITE_REQUIRES_AUTH` 打开时, 匿名调用被跳过(默认关闭 = 现役兼容)。
  const writeBlocked = writeRequiresAuth() && !authenticated;
  let lastSeenWritten = false;
  // 默认 = 库里读到的真实值(而不是客户端本地时间)
  let lastSeenAt: string | null = dbLastSeen ? dbLastSeen.toISOString() : null;
  let lastSeenSource: "mind" | "db" | "unknown" = "db";

  if (writeBlocked) {
    warnings.push(
      "last_seen_at 未更新: PORTAL_HEARTBEAT_WRITE_REQUIRES_AUTH 已开启, 回写心跳要求身份校验(本次为匿名调用)。",
    );
  } else {
    // 超时 2s: 心跳被 agent 高频轮询, 不能让 mind 的故障把等待放大到默认 4s
    const seen = await callMind("/api/v1/agents/seen", { agentId: safeAgent }, { timeoutMs: 2000 });
    if (!seen.ok) {
      warnings.push(`last_seen_at 未更新: ${seen.error || `agents/seen HTTP ${seen.status}`}`);
      console.error(`[portal] heartbeat seen forward 失败(非致命): ${seen.error || seen.status}`);
    } else {
      lastSeenWritten = true;
      // 语义修正: 返回 **mind 响应的真实值**, 而不是客户端本地 `new Date()`
      const v = (seen.data as any)?.last_seen_at;
      if (typeof v === "string" && v) {
        lastSeenAt = v;
        lastSeenSource = "mind";
      } else {
        // 写成功但 mind 没回时间戳: 不把"库里的旧值"冒充成新值
        lastSeenAt = null;
        lastSeenSource = "unknown";
      }
    }
  }

  // ⑤ ACTIVE 且**已通过身份校验**才拿服务密钥(明文); 匿名恒为 {}。
  const services: Record<string, string> = {};
  if (!authenticated) {
    warnings.push(
      regStatus === "ACTIVE"
        ? "未通过身份校验: 不再匿名返回明文服务密钥(services 为空)。请带 Authorization: Bearer <lions token> 或 X-API-Key: <你自己的服务密钥> 重新调用。"
        : "未通过身份校验: 本响应只含 status/approved/guide_version; 需要服务密钥请带 Authorization: Bearer <lions token> 或 X-API-Key: <你自己的服务密钥>。",
    );
  } else if (regStatus === "ACTIVE") {
    let permsError = false;
    // 2026-10-15 钥匙治理(item 3): **明文只在发放后 1 小时内可读** —— 读取侧必须与 mind 端
    //   `readablePlaintext()` 同口径, 否则"库内已清空"了、这里还在把老明文发出去。
    //   判据 = `api_key_plain` 非空 且 `idempotent_until`(由 mind 的单一实现在发放时写 = 发放时刻+1h)
    //   是一个**将来**到期的时间戳。存量老行(`idempotent_until IS NULL`)一律视为**不可读**。
    //   已有机器要重取密钥: 走 (a) 管理员按服务重发 / (b) refresh-service-key / (c) 管理员重新签发领取券。
    const plainNowMs = Date.now();
    const perms = await silentQuery<any[]>(
      () =>
        mindQuery(
          `SELECT p.service_name, p.api_key_plain
           FROM AgentServicePermission p
           WHERE p.agent_id = ? AND p.status = 'ACTIVE'
             AND p.api_key_plain IS NOT NULL
             AND p.idempotent_until IS NOT NULL
             AND p.idempotent_until > ?`,
          safeAgent,
          plainNowMs,
        ),
      [],
      "heartbeat.perms",
      () => { permsError = true; },
    );
    if (permsError) {
      warnings.push("服务密钥查询失败(data_unavailable), 请稍后重试。");
    } else {
      const returned = new Set<string>();
      for (const p of perms) {
        if (p?.service_name && p?.api_key_plain) {
          services[p.service_name] = p.api_key_plain;
          returned.add(String(p.service_name));
        }
      }
      if (returned.size === 0) {
        warnings.push(
          "本 agent 当前没有\"发放 1 小时内\"的明文缓存(2026-10-15 钥匙治理: 明文只在发放后 1 小时内保留)。" +
          "需要密钥请走: ①已装机器继续用本机已落盘的 key ②管理员按服务重发 ③POST /api/v1/agent/refresh-service-key 轮换取新 key ④管理员签发一次性领取券后调 /api/v1/agent/claim-service-key。",
        );
      }
    }
  }

  const base = resolvePlatformBase(host || rows[0]?.host || "");

  return NextResponse.json({
    ok: true,
    agent_id: agentId,
    status: regStatus,
    approved: regStatus === "ACTIVE",
    services,
    warning: warnings.length ? warnings.join(" ") : null,
    platform_base: base,
    guide_version: GUIDE_VERSION,
    guide_url: base.portal + "/api/portal/guide?format=json",
    // 语义修正: 真实值 + 来源(写成功时是 mind 返回值; 跳过/失败时是库里的值; 可能为 null)
    last_seen_at: lastSeenAt,
    last_seen_at_source: lastSeenSource,
    last_seen_written: lastSeenWritten,
    // 归属可观测: 调用方自己就能确认"我是以什么身份、以哪个 agent 的身份拿到这份数据"
    authenticated,
    auth_via: authenticated ? caller.kind : null,
    caller_agent_id: caller.agentId,
  });
}
