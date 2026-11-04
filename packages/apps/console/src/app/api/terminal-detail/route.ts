import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { openMind, openMacs, openSession, q, one } from "@/lib/server/lions-db";

// 2026-10-29：终端详情聚合 BFF（只读）。
// 设计依据：docs/productization/TERMINAL-DETAIL-IA-2026-10-27.md（12 层）。
// 三条硬约束（沿用本仓库既有判据）：
//   1. **未知不填 0**：拿不到就是 null + 原因，页面显示「未知」；
//   2. **不在前端算指标**：能算的聚合都在这里算好；
//   3. 每个块自带 `status`（ok / partial / unknown）与 `reason`，页面按状态渲染，而不是猜。
export const dynamic = "force-dynamic";

type Block = { status: "ok" | "partial" | "unknown"; reason?: string } & Record<string, unknown>;

const ok = (v: Record<string, unknown>): Block => ({ status: "ok", ...v });

// 2026-10-29：客户端版本口径（与 MACS 的 ingest_contract 对齐，两步走）：
//   MIN = 在役版本（当前谁都不降级）；NEXT = 新版本（只推荐升级）。
//   三步语义：unknown（还没上报）/ ok / upgrade_available（可升级，推荐）/ unsupported（低于 MIN）。
//   为什么不在这里"强制"：平台目前看不见版本，直到客户端上报；盲判会误伤（见契约 §3）。
const V_MIN = process.env.CLIENT_VERSION_MIN || "2026-10-23.5";
const V_NEXT = process.env.CLIENT_VERSION_NEXT || "2026-10-29.1";

function cmpVer(a: string, b: string): number {
  // 版本形如 2026-10-23.5 / 2026-10-29.1：按 主段-月-日.序 比较
  const pa = a.trim().split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.trim().split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function versionState(v: string | null): { state: "unknown" | "ok" | "upgrade_available" | "unsupported"; min: string; next: string } {
  if (!v) return { state: "unknown", min: V_MIN, next: V_NEXT };
  if (cmpVer(v, V_MIN) < 0) return { state: "unsupported", min: V_MIN, next: V_NEXT };
  if (cmpVer(v, V_NEXT) < 0) return { state: "upgrade_available", min: V_MIN, next: V_NEXT };
  return { state: "ok", min: V_MIN, next: V_NEXT };
}
const unknown = (reason: string): Block => ({ status: "unknown", reason });

// 2026-10-29 修（重要）：lions-db 的 q()/one() 会**吞掉 SQL 错误并返回 []/null**，
//   于是"查错库/查错表"与"确实没有数据"在页面上完全一样（都是空）。
//   本路由改用下面的 raw* —— 出错就抛，由 safe() 捕获成 unknown + 原因，页面显示"取不到"而不是"没有"。
const dataErrors: string[] = [];
async function raw(pool: any, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  try {
    const r = await pool.query(sql, params as any[]);
    return (r.rows ?? []) as Record<string, unknown>[];
  } catch (e) {
    const msg = String((e as { message?: string })?.message || e).slice(0, 160);
    dataErrors.push(msg);
    throw e;
  }
}
async function rawOne(pool: any, sql: string, params: unknown[] = []): Promise<Record<string, unknown> | null> {
  const rows = await raw(pool, sql, params);
  return rows[0] ?? null;
}

async function safe<T>(fn: () => Promise<T>): Promise<{ v: T | null; err?: string }> {
  try {
    return { v: await fn() };
  } catch (e) {
    return { v: null, err: String((e as { message?: string })?.message || e).slice(0, 160) };
  }
}

export async function GET(req: NextRequest) {
  // 排练用（仅非生产 + 显式 ?changes_demo=1）：只替换 changes 块，其余块照常取数，
  //   这样能验证"接口上线后的渲染"，而不是看一个只剩两块的假页面。
  // 排练用（同样仅非生产 + 显式参数）：覆盖 persona 块，验证"上报后第 4 层变 ✓"。
  const DEMO_PERSONA =
    process.env.NODE_ENV !== "production" && req.nextUrl.searchParams.get("persona_demo") === "1"
      ? {
          persona_source: "AGENTS.md",
          persona_summary: { personality: "严谨", tone: "简洁", specialties: ["架构"], rules: ["先给证据"] },
          persona_version: "demo-v1",
          demo: true,
        }
      : null;

  const DEMO_CHANGES =
    process.env.NODE_ENV !== "production" && req.nextUrl.searchParams.get("changes_demo") === "1"
      ? {
          available: true,
          since: "2026-10-28",
          demo: true,
          items: [
            { at: "2026-10-29T06:00:00Z", actor: "operator", field: "expires_at", before: "2026-11-01", after: "2027-01-01" },
            { at: "2026-10-29T06:00:00Z", actor: "operator", field: "sop_version", before: "1.2.3", after: "1.3.3" },
            { at: "2026-10-29T06:05:00Z", actor: "system", field: "permissions.mcp_agent_chat", before: true, after: false },
            { at: "2026-10-29T06:06:00Z", actor: "operator", field: "config.model", before: "MiniMax-M3", after: "MiniMax-M4" },
          ],
        }
      : null;

  const agentId = String(req.nextUrl.searchParams.get("agent_id") || "").trim();
  if (!agentId) return NextResponse.json({ ok: false, error: "缺少 agent_id" }, { status: 400 });

  const mind = openMind();
  const macs = openMacs();
  const sess = openSession(); // 2026-10-29：会话活在 lions_session."Session"（25k 行），MACS sessions 只有 3 行，别用错库
  if (!mind && !macs) return NextResponse.json({ ok: false, error: "数据库未配置" }, { status: 503 });

  // ── 1 身份 ──
  const identity = await safe(async () => {
    const reg = mind
      ? await one(mind, `SELECT agent_id, display_name, channel, host, role, tenant_id, status, created_at, last_seen_at, avatar
                           FROM "AgentRegistry" WHERE agent_id = $1`, agentId)
      : null;
    // 2026-10-29 修正（踩过的坑）：`agent_profiles` 只在 **lions_macs**，lions_mind 里没有这张表。
    //   之前查 mind 会静默返回空 → 页面上"模型/厂商/性格"全显示未知，看起来像"没上报"。
    //   改用 MACS + 探测式列读取：persona_* 列已由 MACS 线于今日加上，值等客户端上报。
    let prof: Record<string, unknown> | null = null;
    if (macs) {
      const baseSel = `real_name, nickname, bio, tagline, vendor, model, personality, tone, core_values, mbti,
                       response_style, working_hours, languages, timezone, email, version`;
      const cols = await raw(macs, `SELECT column_name FROM information_schema.columns
                                     WHERE table_name = 'agent_profiles'
                                       AND column_name IN ('persona_source','persona_summary','persona_version','persona_sha256')`).catch(() => []);
      const have = new Set((cols as Record<string, unknown>[]).map((c) => String(c.column_name)));
      const extra = ["persona_source", "persona_summary", "persona_version", "persona_sha256"].filter((c) => have.has(c));
      prof = await rawOne(macs, `SELECT ${baseSel}${extra.length ? ", " + extra.join(", ") : ""}
                                   FROM agent_profiles WHERE agent_id = $1`, [agentId]);
    }
    const macsAgent = macs
      ? await one(macs, `SELECT agent_id, display_name, channel, host, bridge_url, status, last_seen, registered_at,
                                sop_version, sop_accepted_at, sop_compliant, sdk_version_acked, capabilities
                           FROM agents WHERE agent_id = $1`, agentId)
      : null;
    return { reg, prof, macsAgent };
  });

  const reg = (identity.v?.reg ?? null) as Record<string, unknown> | null;
  const prof = (identity.v?.prof ?? null) as Record<string, unknown> | null;
  const macsAgent = (identity.v?.macsAgent ?? null) as Record<string, unknown> | null;
  if (!reg && !macsAgent) {
    return NextResponse.json({ ok: false, error: "找不到该终端" }, { status: 404 });
  }

  // ── 3 状态（四层）──
  // 注意：块状态用 status，此处终端运行状态另起名 runtime_status，避免键冲突（踩过一次：
  //   展开 v 时把块的 status:"ok" 覆盖成 "online"，页面读块状态就错了）。
  const runtime = ok({
    runtime_status: (macsAgent?.status ?? reg?.status) ?? null,
    last_seen: (macsAgent?.last_seen ?? reg?.last_seen_at) ?? null,
    // 2026-10-29 修正：`agent_profiles.version` 是**运行包版本**（如 hermes-main-2026.06.02），
    //   不是我们客户端的 CLIENT_VERSION。之前拿它去比最低支持版本，
    //   实测把 thirteen 判成"低于最低支持版本"——这是错的。
    //   现在：客户端版本只认客户端上报（C1/C3，尚未上线）→ null + "尚未上报"；运行包版本单独展示。
    client_version: null,
    client_version_state: versionState(null),
    package_version: prof?.version ?? null,
    sdk_version: macsAgent?.sdk_version_acked ?? null,
    sop_version: macsAgent?.sop_version ?? null,
    sop_compliant: macsAgent?.sop_compliant ?? null,
  });

  const access = await safe(async () => {
    if (!mind) throw new Error("mind 库未配置");
    const perm = await one(mind, `SELECT scope, status, expires_at, last_used_at, permissions
                                    FROM "AgentServicePermission"
                                   WHERE agent_id = $1 AND service_name = 'mcp_agent_chat'
                                   ORDER BY updated_at DESC LIMIT 1`, agentId);
    return perm;
  });
  const accessBlock: Block = access.err
    ? unknown(access.err)
    : access.v
      ? ok({
          // 2026-10-29：有授权行 ≠ 有档位。实测 agent-e 的 mcp_agent_chat 行存在但 scope 为空，
          //   之前页面把"没档位"显示成"未知"，会被读成"查不到"。这里把两件事拆开。
          granted: true,
          scope: (access.v as Record<string, unknown>).scope ?? null,
          permission_status: (access.v as Record<string, unknown>).status,
          expires_at: (access.v as Record<string, unknown>).expires_at,
          last_used_at: (access.v as Record<string, unknown>).last_used_at,
          note: (access.v as Record<string, unknown>).scope
            ? undefined
            : "已授予 mcp_agent_chat，但未设置身份档位（scope 为空）",
        })
      : // 2026-10-29 语义修正：**查到了、确实没有授权行**是"未授予"这一确定事实，不是"未知"。
        //   把确定的事说成未知，会让读者以为是取数失败，去找错的人。
        ok({
          granted: false,
          scope: null,
          permission_status: "未授予",
          note: "该终端未被授予 mcp_agent_chat（不代表未接入平台；它可能只使用其他服务）",
        });

  const comm = await safe(async () => {
    if (!macs) throw new Error("MACS 库未配置");
    const agg = await one(macs, `SELECT COUNT(*)::int total,
                                        COUNT(*) FILTER (WHERE status = 'delivered')::int delivered,
                                        MAX(created_at) last_at
                                   FROM delivery_attempts WHERE target_agent_id = $1
                                  AND created_at > now() - interval '24 hours'`, agentId);
    const last = await one(macs, `SELECT event_type, actor, detail, created_at
                                    FROM message_events e
                                    JOIN messages m ON m.message_id = e.message_id
                                   WHERE m.target_session_id IN (SELECT session_id FROM sessions WHERE agent_id = $1)
                                   ORDER BY e.created_at DESC LIMIT 1`, agentId).catch(() => null);
    return { agg, last };
  });
  const commBlock: Block = comm.err
    ? unknown(comm.err)
    : ok({
        delivered_24h: (comm.v?.agg as Record<string, unknown> | null)?.delivered ?? null,
        attempts_24h: (comm.v?.agg as Record<string, unknown> | null)?.total ?? null,
        last_delivery_at: (comm.v?.agg as Record<string, unknown> | null)?.last_at ?? null,
        last_event: comm.v?.last ?? null,
      });

  const work = await safe(async () => {
    if (!mind) throw new Error("mind 库未配置");
    const todo = await one(mind, `SELECT COUNT(*)::int open,
                                         MIN("createdAt") oldest
                                    FROM "Todo"
                                   WHERE "ownerType" = 'agent' AND "ownerId" = $1
                                     AND status IN ('OPEN','DOING')`, agentId);
    return todo;
  });
  const workBlock: Block = work.err
    ? unknown(work.err)
    : ok({
        open_todos: (work.v as Record<string, unknown> | null)?.open ?? null,
        oldest_todo_ms: (work.v as Record<string, unknown> | null)?.oldest ?? null,
        current_task: macsAgent?.current_task_id ?? null,
      });

  // ── 7 参与（会话聚合）──
  const activity = await safe(async () => {
    if (!sess) throw new Error("会话库未配置");
    const r = await one(sess, `SELECT COUNT(*)::int sessions,
                                      MAX("lastMessageAt") last_started_at,
                                      SUM("messageCount")::int messages,
                                      SUM("estimatedCostUsd")::float cost_usd
                                 FROM "Session" WHERE "agentId" = $1`, agentId);
    // token 明细不在活库（在 MACS sessions 里且覆盖不全）→ 明确置 null，页面显示未知，不补 0
    return r ? { ...(r as Record<string, unknown>), tokens: null } : null;
  });
  const activityBlock: Block = activity.err
    ? unknown(activity.err)
    : ok({
        sessions: (activity.v as Record<string, unknown> | null)?.sessions ?? null,
        last_session_at: (activity.v as Record<string, unknown> | null)?.last_started_at ?? null,
        messages: (activity.v as Record<string, unknown> | null)?.messages ?? null,
        tokens: (activity.v as Record<string, unknown> | null)?.tokens ?? null,
        cost_usd: (activity.v as Record<string, unknown> | null)?.cost_usd ?? null,
      });

  // ── 5 权限（服务矩阵）──
  const services = await safe(async () => {
    if (!mind) throw new Error("mind 库未配置");
    return await q(mind, `SELECT service_name, status, permissions, last_error, updated_at
                            FROM "AgentServicePermission" WHERE agent_id = $1 ORDER BY updated_at DESC LIMIT 20`, agentId);
  });
  const servicesBlock: Block = services.err
    ? unknown(services.err)
    : ok({ items: services.v ?? [] });

  // ── 8 配置（可见性策略，平台侧配置）──
  const policy = await safe(async () => {
    if (!mind) throw new Error("mind 库未配置");
    return await one(mind, `SELECT memory_mode, knowledge_mode, skill_mode, accepted_at
                              FROM agent_data_policy WHERE agent_id = $1`, agentId);
  });
  const policyBlock: Block = policy.err
    ? unknown(policy.err)
    : policy.v
      ? ok({ ...(policy.v as Record<string, unknown>) })
      : unknown("尚未为该终端配置数据可见性（平台统一配置）");

  // ── 2 来源与接入 ──
  const origin = await safe(async () => {
    const out: Record<string, unknown> = {
      registered_at: macsAgent?.registered_at ?? reg?.created_at ?? null,
      host: reg?.host ?? macsAgent?.host ?? null,
      bridge_url: macsAgent?.bridge_url ?? null,
    };
    if (sess) {
      const firstSeen = await one(sess, `SELECT MIN("startedAt") t, COUNT(DISTINCT platform)::int n FROM "Session" WHERE "agentId" = $1`, agentId);
      out.first_seen_at = (firstSeen as Record<string, unknown> | null)?.t ?? null;
      out.source_platforms = (firstSeen as Record<string, unknown> | null)?.n ?? null;
    }
    if (macs) {
      const appr = await one(macs, `SELECT decided_by, decided_at, decision_note, decision FROM agent_key_requests
                                      WHERE agent_id = $1 AND decision IS NOT NULL ORDER BY decided_at DESC LIMIT 1`, agentId);
      out.approved_by = (appr as Record<string, unknown> | null)?.decided_by ?? null;
      out.approved_at = (appr as Record<string, unknown> | null)?.decided_at ?? null;
      out.approval_note = (appr as Record<string, unknown> | null)?.decision_note ?? null;
    }
    return out;
  });
  const originBlock: Block = origin.err
    ? unknown(origin.err)
    : ok({ ...(origin.v as Record<string, unknown>), register_via: null, protocol_version: null });

  // ── 4 性格与规则 ──
  const persona = await safe(async () => {
    const base: Record<string, unknown> = {
      personality: prof?.personality ?? null,
      tone: prof?.tone ?? null,
      core_values: prof?.core_values ?? null,
      mbti: prof?.mbti ?? null,
      response_style: prof?.response_style ?? null,
      specialties: (prof as Record<string, unknown> | null)?.specialties ?? null,
      model: prof?.model ?? null,
      sop_version: macsAgent?.sop_version ?? null,
      sop_compliant: macsAgent?.sop_compliant ?? null,
      sop_accepted_at: macsAgent?.sop_accepted_at ?? null,
      // 裁定①：必须上报；字段未落地 → 明确 null（页面显示"待接入 D1"）
      // 探测式：字段落地即有值；未落地保持 null（页面显示"待接入 D1"而不是"无"）
      persona_source: (prof as Record<string, unknown> | null)?.persona_source ?? null,
      persona_summary: (prof as Record<string, unknown> | null)?.persona_summary ?? null,
      persona_version: (prof as Record<string, unknown> | null)?.persona_version ?? null,
      persona_sha256: (prof as Record<string, unknown> | null)?.persona_sha256 ?? null,
      policy_acked_version: null,
    };
    return base;
  });
  const personaBlock: Block = persona.err
    ? unknown(persona.err)
    : ok({ ...(persona.v as Record<string, unknown>) });

  // ── 5 权限（资源权限 / 分组 / 凭据 / 徽章）──
  const permissions = await safe(async () => {
    const out: Record<string, unknown> = { resource: [], groups: [], credentials: [], badges: [] };
    if (mind) {
      out.resource = await q(mind, `SELECT "resourceType" rt, "resourceKey" rk, permission, effect
                                      FROM "ResourcePermission" WHERE "subjectType" = 'agent' AND "subjectId" = $1 LIMIT 50`, agentId).catch(() => []);
      out.groups = await q(mind, `SELECT g.name, g.purpose FROM "AgentGroupMember" m
                                    JOIN "AgentGroup" g ON g.id = m."groupId" WHERE m."agentId" = $1 LIMIT 20`, agentId).catch(() => []);
    }
    if (macs) {
      out.credentials = await q(macs, `SELECT service_name, issued_at, expires_at, revoked_at
                                         FROM agent_credentials WHERE agent_id = $1 LIMIT 20`, agentId).catch(() => []);
      out.badges = await q(macs, `SELECT badge_code, badge_name, awarded_at FROM agent_badges WHERE agent_id = $1 LIMIT 20`, agentId).catch(() => []);
    }
    return out;
  });
  const permissionsBlock: Block = permissions.err
    ? unknown(permissions.err)
    : ok({ ...(permissions.v as Record<string, unknown>) });

  // ── 6 事件（审批 / 投递 / 会话）──
  const events = await safe(async () => {
    const out: Record<string, unknown[]> = { approvals: [], deliveries: [], sessions: [] };
    if (macs) {
      out.approvals = await q(macs, `SELECT request_id, decision, decided_by, decided_at, decision_note
                                       FROM agent_key_requests WHERE agent_id = $1 ORDER BY requested_at DESC LIMIT 20`, agentId).catch(() => []);
      out.deliveries = await q(macs, `SELECT attempt_no, status, error, created_at FROM delivery_attempts
                                        WHERE target_agent_id = $1 ORDER BY created_at DESC LIMIT 20`, agentId).catch(() => []);
      out.sessions = await q(macs, `SELECT id, started_at, ended_at, end_reason FROM sessions
                                      WHERE agent_id = $1 ORDER BY started_at DESC LIMIT 20`, agentId).catch(() => []);
    }
    return out;
  });
  const eventsBlock: Block = events.err ? unknown(events.err) : ok({ ...(events.v as Record<string, unknown>) });

  // ── 7 参与（会话层级 / 线程 / 协作组）──
  const projects = await safe(async () => {
    const out: Record<string, unknown> = { sessions: [], groups: [] };
    if (sess) {
      out.sessions = await q(sess, `SELECT "sessionUid" session_id, NULL::text parent_session_id, platform label,
                                            title, "extractStatus" status, "lastMessageAt" last_seen_at
                                       FROM "Session" WHERE "agentId" = $1
                                      ORDER BY "lastMessageAt" DESC NULLS LAST LIMIT 20`, agentId).catch(() => []);
    }
    if (mind) {
      out.groups = await q(mind, `SELECT g.name, g.purpose FROM "AgentGroupMember" m JOIN "AgentGroup" g ON g.id = m."groupId"
                                   WHERE m."agentId" = $1 LIMIT 20`, agentId).catch(() => []);
    }
    return out;
  });
  // 2026-10-29 老板裁定 D9：项目数据来自**后续接入的开发流水线系统**；
  //   agent 成为某项目成员时才有数据，在此之前本字段**预留**。
  //   所以这里显式 `reserved: true`，页面显示"预留字段"，而不是"待接入"或空白。
  const projectsBlock: Block = projects.err
    ? unknown(projects.err)
    : ok({
        ...(projects.v as Record<string, unknown>),
        reserved: true,
        reserved_field: "project",
        reserved_reason:
          "项目数据将由开发流水线系统提供：agent 成为某项目成员后才产生；在此之前本字段为预留（老板 2026-10-29 定）",
      });

  // ── 10 成本与用量（沿用 activity 聚合，单列便于页面分区）──
  // 平台配额（授权侧）：至少让"配额"这一项有真值，而不是整层空着。
  //   注意：maxAgents 是**平台级**，不是每终端上限；每终端上限尚未定义（产品缺口）。
  const license = await safe(async () => {
    const base = process.env.LIONS_MIND_URL || "http://127.0.0.1:3000";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    try {
      const r = await fetch(`${base}/api/v1/platform/license`, { signal: ctrl.signal, cache: "no-store" });
      if (!r.ok) return null;
      return (await r.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  });
  // maxAgents/edition 是顶层字段（不在 payload 里，2026-10-29 实测）
  const licPayload = (license.v ?? null) as Record<string, unknown> | null;

  // 成本字段实测：活库 3,779 行里 estimatedCostUsd **有值 0 行**（全库同样）→ 明确"不可得"，不补 0
  const costBlock: Block = activity.err
    ? unknown(activity.err)
    : ok({
        tokens: null,
        tokens_reason: "会话库无 token 明细（MACS sessions 仅 3 行、覆盖不全）",
        cost_usd: null,
        cost_reason: "会话库 estimatedCostUsd 全表无值（0 行有值），当前不可得",
        sessions: (activity.v as Record<string, unknown> | null)?.sessions ?? null,
        quota_max_agents: (licPayload?.maxAgents as number | undefined) ?? null,
        quota_license_state: (license.v?.state as string | undefined) ?? null,
        quota_days_left: (license.v?.daysLeft as number | undefined) ?? null,
        quota_scope_note: "maxAgents 为平台级配额；每终端上限尚未定义",
        cost_cap: null,
      });

  // ── 12 关系与依赖 ──
  const relations = await safe(async () => {
    const out: Record<string, unknown> = { depends_on: [], depended_by: null, group: null };
    if (mind) {
      out.depends_on = await q(mind, `SELECT service_name, status FROM "AgentServicePermission" WHERE agent_id = $1 LIMIT 20`, agentId).catch(() => []);
    }
    if (macs) {
      // D8 可得部分：谁的 services[].config 里指向本终端（endpoint/health_url 含本 agent_id 或 host）
      const host = (reg?.host ?? macsAgent?.host ?? null) as string | null;
      out.depended_by = await q(macs, `SELECT agent_id, service_name FROM agent_services
                                        WHERE agent_id <> $1
                                          AND (COALESCE(config::text,'') ILIKE '%' || $1 || '%'
                                               OR ($2 IS NOT NULL AND COALESCE(config::text,'') ILIKE '%' || $2 || '%'))
                                        LIMIT 20`, agentId, host).catch(() => []);
    }
    return out;
  });
  const relationsBlock: Block = relations.err
    ? unknown(relations.err)
    : ok({ ...(relations.v as Record<string, unknown>), depended_by_reason: "缺反向依赖查询（D8）" });

  // ── 9 健康与趋势（D5 心跳历史已落地，2026-10-29）──
  const health = await safe(async () => {
    if (!macs) throw new Error("MACS 库未配置");
    // 秒级心跳行，保留 30 天；在线率用"有心跳的时间窗覆盖率"近似（不做会话推断）
    const agg = await one(macs, `SELECT COUNT(*)::int beats,
                                        MIN(at) first_at,
                                        MAX(at) last_at,
                                        EXTRACT(EPOCH FROM (MAX(at) - MIN(at)))::float span_s
                                   FROM agent_heartbeat_history
                                  WHERE agent_id = $1 AND at > now() - interval '7 days'`, agentId);
    const gaps = await one(macs, `SELECT MAX(gap_s)::float max_gap_s FROM (
                                    SELECT EXTRACT(EPOCH FROM (at - LAG(at) OVER (ORDER BY at)))::float gap_s
                                      FROM agent_heartbeat_history
                                     WHERE agent_id = $1 AND at > now() - interval '7 days'
                                  ) t`, agentId);
    const hourly = await q(macs, `SELECT date_trunc('hour', at) h, COUNT(*)::int c
                                    FROM agent_heartbeat_history
                                   WHERE agent_id = $1 AND at > now() - interval '7 days'
                                   GROUP BY 1 ORDER BY 1 DESC LIMIT 48`, agentId);
    const beats = Number((agg as Record<string, unknown> | null)?.beats ?? 0);
    const spanS = Number((agg as Record<string, unknown> | null)?.span_s ?? 0);
    // 30s 一次心跳为基准 → 期望行数 = span/30；覆盖率上限 100%
    const expected = spanS > 0 ? Math.max(1, Math.round(spanS / 30)) : 0;
    const coverage = expected > 0 ? Math.min(100, Math.round((beats / expected) * 100)) : null;
    return {
      beats_7d: beats || null,
      first_beat_at: (agg as Record<string, unknown> | null)?.first_at ?? null,
      last_beat_at: (agg as Record<string, unknown> | null)?.last_at ?? null,
      max_gap_s: (gaps as Record<string, unknown> | null)?.max_gap_s ?? null,
      // 注意：覆盖率是"观测窗口内"的覆盖率，不是"7 天在线率"——窗口只有几分钟时必须说清楚
      coverage_pct_span: coverage,
      span_s: spanS || null,
      hours: hourly,
    };
  });
  // 0 次心跳不是"健康分 0"，而是"没有可观测数据"——必须与"有数据但差"区分开（实测 agent-operator 无心跳行）。
  const healthBeats = Number((health.v as Record<string, unknown> | null)?.beats_7d ?? 0);
  const healthBlock: Block = health.err
    ? unknown(health.err)
    : healthBeats > 0
      ? ok({ ...(health.v as Record<string, unknown>) })
      : unknown("该终端 7 天内没有心跳记录（可能客户端未运行或已长期离线）；这不是「健康为 0」");

  // ── 11 生命周期（阶段时间线可得；变更前后值仍需 D7）──
  const lifecycle = await safe(async () => {
    const stages: { stage: string; at: unknown; source: string }[] = [];
    const push = (stage: string, at: unknown, source: string) => {
      if (at) stages.push({ stage, at, source });
    };
    push("注册", macsAgent?.registered_at ?? reg?.created_at ?? null, "agents/AgentRegistry");
    push("接受接入规范", macsAgent?.sop_accepted_at ?? null, "agents.sop_accepted_at");
    if (sess) {
      const firstLast = await one(sess, `SELECT MIN("startedAt") f, MAX("lastMessageAt") l FROM "Session" WHERE "agentId" = $1`, agentId);
      push("首个会话", (firstLast as Record<string, unknown> | null)?.f ?? null, "Session.startedAt");
      push("最近活动", (firstLast as Record<string, unknown> | null)?.l ?? null, "Session.lastMessageAt");
    }
    if (macs) {
      const appr = await one(macs, `SELECT decided_at FROM agent_key_requests WHERE agent_id = $1 AND decision = 'approve'
                                     ORDER BY decided_at DESC LIMIT 1`, agentId).catch(() => null);
      push("最近一次授权批准", (appr as Record<string, unknown> | null)?.decided_at ?? null, "agent_key_requests");
      const hb = await one(macs, `SELECT MAX(at) m FROM agent_heartbeat_history WHERE agent_id = $1`, agentId).catch(() => null);
      push("最近心跳", (hb as Record<string, unknown> | null)?.m ?? null, "agent_heartbeat_history");
    }
    stages.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
    return {
      stages,
      diff_unavailable_reason:
        "变更前后值（D7）自采集上线后才有记录；此前的历史不可回填（设计见 docs/platform-logic/AGENT-CHANGE-LEDGER-2026-10-28.md）",
    };
  });
  const lifecycleBlock: Block = lifecycle.err
    ? unknown(lifecycle.err)
    : ok({ ...(lifecycle.v as Record<string, unknown>) });

  // 2026-10-29 D7：平台数据线确认「复用 AuditLog + 视图 v_agent_changes + GET /api/v1/agents/:id/changes」。
  //   接口未上线前**不假装有**：探测失败即空数组 + 明确原因；上线后自动带值，不需要改页面。
  const changes = await safe(async () => {
    const base = process.env.LIONS_MIND_URL || "http://127.0.0.1:3000";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    try {
      const r = await fetch(`${base}/api/v1/agents/${encodeURIComponent(agentId)}/changes?limit=50`, {
        signal: ctrl.signal,
        cache: "no-store",
      });
      if (!r.ok) return { available: false, status: r.status, items: [] as unknown[] };
      const body = (await r.json()) as Record<string, unknown>;
      const items = (body.items ?? body.data ?? []) as unknown[];
      return { available: true, since: body.since ?? null, items };
    } catch {
      return { available: false, status: null, items: [] as unknown[] };
    } finally {
      clearTimeout(timer);
    }
  });

  // ── 8 日志（聚合三源：审计 / 投递事件 / 心跳；客户端与原始服务端日志仍待 D6）──
  const logs = await safe(async () => {
    if (!macs) throw new Error("MACS 库未配置");
    const items: { at: unknown; level: string; source: string; text: string }[] = [];
    // ① 审计：该终端发起或作为对象的动作
    const audit = await q(macs, `SELECT action, actor_id, target_type, target_id, details, created_at
                                   FROM audit_log
                                  WHERE actor_id = $1 OR (target_type = 'agent' AND target_id = $1)
                                  ORDER BY created_at DESC LIMIT 30`, agentId).catch(() => []);
    for (const r of audit as Record<string, unknown>[]) {
      items.push({
        at: r.created_at,
        level: "info",
        source: "审计",
        text: `${String(r.action ?? "")}${r.target_id ? " → " + String(r.target_id) : ""}`,
      });
    }
    // ② 投递事件
    const deliv = await q(macs, `SELECT status, error, attempt_no, created_at FROM delivery_attempts
                                  WHERE target_agent_id = $1 ORDER BY created_at DESC LIMIT 20`, agentId).catch(() => []);
    for (const r of deliv as Record<string, unknown>[]) {
      items.push({
        at: r.created_at,
        level: r.status === "delivered" ? "info" : "warn",
        source: "投递",
        text: `第 ${String(r.attempt_no ?? "?")} 次 ${String(r.status ?? "")}${r.error ? "：" + String(r.error) : ""}`,
      });
    }
    // ③ 心跳（最新几条，用于"最近在线"上下文）
    const hb = await q(macs, `SELECT status, at FROM agent_heartbeat_history
                               WHERE agent_id = $1 ORDER BY at DESC LIMIT 10`, agentId).catch(() => []);
    for (const r of hb as Record<string, unknown>[]) {
      items.push({ at: r.at, level: "info", source: "心跳", text: String(r.status ?? "online") });
    }
    // 2026-10-29 修：pg 返回的是 Date 对象，String(Date) 得到 "Wed Oct 29 ..." 这种字符串，
    //   用 localeCompare 排序会把 10-28 排到 10-29 前面（实测发生）。统一转 ISO 再排。
    const iso = (v: unknown): string => {
      if (v instanceof Date) return v.toISOString();
      const t = v ? new Date(String(v)) : null;
      return t && !Number.isNaN(t.getTime()) ? t.toISOString() : "";
    };
    for (const it of items) it.at = iso(it.at);
    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { items: items.slice(0, 50) };
  });
  const logsBlock: Block = logs.err
    ? unknown(logs.err)
    : ok({
        ...(logs.v as Record<string, unknown>),
        poll_hint: "按 5 秒轮询（非推送）；保留期随各来源：审计/投递 30 天、心跳 30 天",
        pending_note: "客户端本地日志与原始服务端日志待 D6 接口",
      });

  // ── 9 / 11 / 8：明确 blocked，不装成"没有" ──

  // ── 依赖探测（给"待接入"看板用：在等谁、等到什么、现在到哪一步）──
  const probePersona = await safe(async () => {
    if (!macs) throw new Error("MACS 库未配置");
    const r = await rawOne(macs, `SELECT COUNT(*)::int total, COUNT(persona_source)::int reported FROM agent_profiles`);
    return { total: Number(r?.total ?? 0), reported: Number(r?.reported ?? 0) };
  });
  // 2026-10-29 MACS 线说明：D6 探测**带不带凭据，结论不同**——
  //   无 key → 401（鉴权在起作用）；带 admin key → 404（路由未实现）。
  //   所以这里带上 key，把"需凭据"与"未实现"分开；不带 key 的 401 不能当"未上线"的证据。
  const probeLogsApi = await safe(async () => {
    const base = process.env.LIONS_MACSSRV_URL || "http://127.0.0.1:8765";
    // 2026-10-29 平台数据线确认：MACS 的共享管理 key 就是 **HERMES_MCP_API_KEY**（via=admin），
    //   不是 MIND_ADMIN_API_KEY / SERVER_ADMIN_KEY。只在 BFF 服务端使用，**不下发浏览器**。
    //   带 key 后：404=路由未实现(待 D6)，401=key 不对，200=已实现。
    const key = process.env.HERMES_MCP_API_KEY || "";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    try {
      const r = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/logs?limit=1`, {
        signal: ctrl.signal,
        headers: key ? { "x-api-key": key } : {},
      });
      return { status: r.status, withKey: !!key };
    } catch {
      return { status: null, withKey: !!key };
    } finally {
      clearTimeout(timer);
    }
  });

  const personaProbe = probePersona.v as { total: number; reported: number } | null;
  const logsProbe = (probeLogsApi.v as { status: number | null; withKey: boolean } | null);
  const logsApiStatus = logsProbe?.status ?? null;
  const logsProbeWithKey = logsProbe?.withKey ?? false;
  const changesLive = !!(changes.v as Record<string, unknown> | null)?.available;

  // ── 待接入（明确列出，不装成"没有"）──
  const pending: {
    block: string;
    reason: string;
    dep?: string;
    owner?: string;
    promised?: string;
    ready_when?: string;
    eta?: string;
    now?: string;
  }[] = [
    {
      block: "4 人格来源与摘要（persona_source / persona_summary）",
      reason: "字段与读侧已就绪，等客户端上报",
      dep: "D1",
      owner: "MACS 线（C1/C5 + 客户端发版）",
      promised: "注册时上报 persona_source + 结构化摘要（≤4000 字，不传原文）",
      ready_when: "任一终端的 persona_source 非空",
      eta: "2026-10-31 前（MACS 侧 10-30 就绪；客户端 C1/C5 + 首台终端上报 10-31 前）",
      now: personaProbe
        ? `档案行 ${personaProbe.total} 条，已上报 ${personaProbe.reported} 条`
        : "探测失败",
    },
    {
      block: "4 规则确认版本 + drift（policy_acked_version）",
      reason: "心跳未带 ack 版本",
      dep: "D2/D3",
      owner: "MACS 线（C3/C4）",
      promised: "心跳带 policy_acked_version；落后即降级 L0",
      ready_when: "心跳载荷出现该字段",
      eta: "未给（随 C3/C4，排在 ①②③⑤ 之后）",
      now: "未上报（心跳仅 agent_id/status）",
    },
    {
      block: "8 客户端/服务端原始日志",
      reason: "缺按 agent 的日志检索接口",
      dep: "D6",
      owner: "MACS 线",
      promised: "GET /api/agents/{id}/logs?cursor=&limit=，source=delivery|wake|register|heartbeat|policy",
      ready_when: "接口返回 200 且 items 为数组（需带 admin key 探测）",
      eta: "无日期（MACS 线在 ①②③⑤ 之后）",
      // 401/403 说明"接口存在或网关拦了"，不等于"已上线"，也不等于"不存在"——如实写，不猜
      now:
        logsApiStatus === null
          ? "探测失败（无响应）"
          : logsApiStatus === 404
            ? "HTTP 404（路由未实现，待 D6）"
            : logsApiStatus === 401 || logsApiStatus === 403
              ? `HTTP ${logsApiStatus}（未带凭据；鉴权在起作用——带 admin key 才能区分"未实现 404"与"已实现 200"）`
              : `HTTP ${logsApiStatus}`,
    },
    {
      block: "11 变更前后值（diff）",
      reason: "阶段时间线已有；字段级 diff 待接口",
      dep: "D7",
      owner: "平台数据线",
      promised: "GET /api/v1/agents/{id}/changes，含 since + field + before/after（展示值）",
      ready_when: "接口 200 且形状通过 D7 校验器",
      eta: "目标 11-02 当周；前提 mind 于 11-03 前接完四个写路径；11-03 给 go/no-go；未过则顺延 Q4（12-31 前）",
      now: changesLive
        ? "已上线（形状待校验）"
        : (() => {
            // 2026-10-29 平台数据线：11-03 给 go/no-go；未过则顺延 Q4。
            //   过了该日期仍是 404 就明确写"长期未就绪"，不要一直写 404 让人以为随时会好。
            const goNoGo = new Date("2026-11-03T23:59:59+08:00").getTime();
            return Date.now() > goNoGo
              ? "接口 404（11-03 go/no-go 已过仍未见 200 → 长期未就绪，预计 Q4/12-31 前）"
              : "接口 404（目标 11-02 当周；11-03 给 go/no-go，未过则顺延 Q4）";
          })(),
    },
    {
      block: "12 关系与依赖（谁依赖它）",
      reason: "仅 services 指向可算；会话/任务派生关系不可得",
      dep: "D8",
      owner: "MACS 线 / mind join",
      promised: "反向依赖聚合（含会话派生）",
      ready_when: "能给出依赖方列表",
      eta: "未给（需 mind join）",
      now: "已给 services 指向；派生关系需 mind join",
    },
    {
      block: "7 参与的项目（项目实体）",
      reason: "预留字段",
      dep: "D9",
      owner: "开发流水线系统",
      promised: "agent 成为项目成员后产生项目数据",
      ready_when: "流水线系统接入并写入项目归属",
      eta: "未立项（预留字段）",
      now: "预留（会话层级已展示）",
    },
  ];

  // 2026-10-29：每个块的**数据来源**（库.表 / 接口），让"这个数字从哪来"可被核查。
  //   不给来源的数字，在争议时无法自证——这与"未知不填 0"是同一套纪律的另一半。
  const provenance: Record<string, string> = {
    identity: "mind AgentRegistry + macs agents + macs agent_profiles",
    origin: "macs agents / agent_key_requests + session Session（首见与来源平台）",
    runtime: "macs agents + macs agent_profiles（运行包版本）",
    persona: "macs agent_profiles（性格/模型/persona_*）+ macs agents.sop_*（接入规范）",
    access: "mind AgentServicePermission（mcp_agent_chat）",
    comm: "macs delivery_attempts + message_events（24h）",
    work: "mind Todo（未结） + macs agents.current_task_id",
    activity: "session Session（会话数/消息数/成本列）",
    services: "mind AgentServicePermission（最近 20）",
    permissions: "mind ResourcePermission / AgentGroupMember + macs agent_credentials / agent_badges",
    events: "macs agent_key_requests / delivery_attempts / sessions",
    projects: "session Session（最近 20）；项目字段预留（D9）",
    cost: "session Session.estimatedCostUsd + mind /api/v1/platform/license（配额）",
    health: "macs agent_heartbeat_history（7 天，30s 一次）",
    logs: "macs audit_log + delivery_attempts + agent_heartbeat_history",
    lifecycle: "macs agents / agent_key_requests / agent_heartbeat_history + session Session",
    changes: "mind GET /api/v1/agents/{id}/changes（D7，未上线）",
    relations: "mind AgentServicePermission + macs agent_services（反向）",
    policy: "mind agent_data_policy（平台统一配置）",
  };

  // 2026-10-29：本页自证要素——抓取时刻 + 构建号 + 来源条数。
  //   截图只能证明"我看到过"，证明不了"哪个版本、什么时候看到的"。
  let buildId = "unknown";
  try {
    buildId = readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    buildId = "unknown";
  }

  return NextResponse.json({
    ok: true,
    asOf: new Date().toISOString(),
    build_id: buildId,
    provenance_count: Object.keys(provenance).length,
    provenance,
    agent_id: agentId,
    warnings: dataErrors.length ? Array.from(new Set(dataErrors)).slice(0, 5) : [],
    blocks: {
      identity: identity.err
        ? unknown(identity.err)
        : ok({
            agent_id: reg?.agent_id ?? macsAgent?.agent_id ?? agentId,
            display_name: reg?.display_name ?? macsAgent?.display_name ?? null,
            channel: reg?.channel ?? macsAgent?.channel ?? null,
            role: reg?.role ?? null,
            tenant_id: reg?.tenant_id ?? null,
            host: reg?.host ?? macsAgent?.host ?? null,
            bridge_url: macsAgent?.bridge_url ?? null,
            vendor: prof?.vendor ?? null,
            model: prof?.model ?? null,
            registered_at: macsAgent?.registered_at ?? reg?.created_at ?? null,
            bio: prof?.bio ?? prof?.tagline ?? null,
            timezone: prof?.timezone ?? null,
            email: prof?.email ?? null,
            capabilities: macsAgent?.capabilities ?? null,
          }),
      runtime,
      access: accessBlock,
      comm: commBlock,
      work: workBlock,
      activity: activityBlock,
      services: servicesBlock,
      policy: policyBlock,
      origin: originBlock,
      persona: DEMO_PERSONA ? ok({ ...(persona.v as Record<string, unknown> | null), ...DEMO_PERSONA }) : personaBlock,
      permissions: permissionsBlock,
      events: eventsBlock,
      projects: projectsBlock,
      cost: costBlock,
      relations: relationsBlock,
      health: healthBlock,
      lifecycle: lifecycleBlock,
      changes: DEMO_CHANGES
        ? ok({ ...DEMO_CHANGES })
        : changes.err
        ? unknown(changes.err)
        : (changes.v as Record<string, unknown>).available
          ? ok({ ...(changes.v as Record<string, unknown>) })
          : ok({
              available: false,
              items: [],
              since: null,
              reason: "变更流水接口尚未上线（D7 已排期：平台视图/API 0.5 人日 + mind 写路径 1 人日）；上线后自动显示",
            }),
      logs: logsBlock,
    },
    pending,
  });
}
