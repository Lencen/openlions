/**
 * key-governance.ts — 「钥匙治理」的**单一实现** (2026-10-15 人类批准的 7 项改动: 1/2/3/5)
 * ============================================================================
 *
 * 为什么有本文件: 平台原先有 **4 处**各自发钥匙的实现(register / approve / grantServiceToAgent /
 *   grantApiKey / repairServices / refresh-service-key), 每处的 TTL、明文缓存、审计口径都不一样 ——
 *   "谁能拿到钥匙、钥匙活多久、谁能撤销谁"这件事**没有单点**。人类 2026-10-15 批准收口, 本文件是
 *   发钥匙 / 换钥匙 / 券生命周期 / 过期翻转 / 明文到期 的唯一定义; 各处只做参数绑定与审计落点。
 *
 * ── 批准后的规则(与交付报告逐条对应) ───────────────────────────────────────
 *  1) 领取券(claim ticket): register(admin 模式)/approve **不再直接发业务钥匙**, 只发一张
 *     **一次性、短 TTL(默认 15 分钟)、绑定 agent_id** 的领取券; agent 调
 *     `POST /api/v1/agent/claim-service-key`(或 tRPC `agent.claimServiceKey`)换**一次**业务钥匙;
 *     换取后券**立即作废**(CAS 单次保证), 券的生命周期留痕在 AgentRegistry.profile.claimTicket
 *     (身份行**保留**)+ AuditLog(每次签发/换取/拒绝/过期各一条)。
 *  2) 业务钥匙 TTL = **90 天**(取消 30 天档 / 1 年档 / 100 年永久档); 到期由 `expireStaleKeys()`
 *     翻成 `status='EXPIRED'`(全仓此前**没有任何**写 EXPIRED 的代码); 到期前 **30 天窗口内**
 *     由 `maybeAutoRenewKey()` 在 agent 调 mind 的鉴权路径上**原地续期**(只延长 expires_at,
 *     **不换密钥值** → agent 无感); 需要**真正轮换密钥**的走 refresh-service-key(客户端开机自调)。
 *  3) 明文缓存(api_key_plain): 只在**发放后 1 小时**内可读, 之后读取侧一律判为"没有明文",
 *     并由 `expireStaleKeys()` 物理清空。到期语义用**既有列 `idempotent_until`** 承载(见下"为什么")。
 *     ⚠ 未做 Prisma 迁移(人类约束: dev.db 1.4GB, 迁移要重建表 + 停机)。
 *  5) 撤销权限: 见 `authorizeRevokeScope()` —— 只有管理员能撤, 且默认只能撤"自己名下"的身份/服务;
 *     跨身份撤销要么用平台管理凭据(x-admin-key), 要么由 OWNER 身份显式 `allow_cross_identity`。
 *
 * ── 关键设计取舍(为什么这么做) ─────────────────────────────────────────────
 *  · **券存 `AgentRegistry.profile.claimTicket`, 不用 token_hash**: token_hash 是 portal 的
 *    `Authorization: Bearer` 通道(`packages/apps/portal/src/app/api/portal/heartbeat/route.ts` 会拿它
 *    做身份并回明文服务密钥)。把领取券塞进 token_hash 等于**新开一条能读全部服务密钥的 bearer 通道**,
 *    与"一次性、只能换钥匙"的语义相冲。存 profile(JSON 文本)则: ①不发不收任何鉴权凭据;
 *    ②比对用 sha256 后用 `UPDATE ... WHERE profile=<换取前的整串>` 做**整串 CAS** —— SQLite 单写者下
 *    这是真原子的"只能用一次"保证; ③身份行保留 → 满足"保留行供审计"。
 *  · **明文到期用 `idempotent_until`**(人类给的候选之一), 不用"updated_at + 1h": `updated_at` 是
 *    Prisma `@updatedAt`, **任何**一次 update(含每次调接口刷 `last_used_at`)**都会把它往前推** ——
 *    于是一把在被使用的钥匙其明文永远"刚发放过", 永远不过期(实测隐患)。`idempotent_until` 是显式
 *    时间戳列、只在发放/续发时写, 语义本来也是"1 小时窗口", 与"明文可读窗口"同构。
 *  · **不引入新列/不迁移**: 券 = profile JSON; 明文到期 = idempotent_until; TTL/窗口 = 常量 + env 覆盖。
 *  · **失败补偿**: 先 CAS 消费券、再发钥匙; 若发钥匙中途抛错, 用 `compensateTicket()` 把券**原样恢复**
 *    (避免"券作废了但钥匙没发"的死局), 并落一条失败审计。
 */
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "./audit-log";

// ── 常量(人类批准的口径) ────────────────────────────────────────────────
/** 业务钥匙 TTL: 90 天(取消 30 天 / 1 年 / 100 年档)。 */
export const BUSINESS_KEY_TTL_DAYS = 90;
/** 领取券 TTL: 15 分钟(批准区间 10–30 分钟)。 */
export const CLAIM_TICKET_TTL_MINUTES = 15;
/** 明文缓存可读窗口: 1 小时(批准口径: 明文只在发放后 1 小时内保留)。 */
export const PLAINTEXT_CACHE_MS = 3600 * 1000;
/** 到期前自动续期窗口: 30 天(窗口内被使用的钥匙原地延长 expires_at)。 */
export const RENEWAL_WINDOW_DAYS = 30;
/** 领取券前缀: 与业务钥匙 `sk-mind-` 明确区分, 安装器/客户端据此分流。 */
export const CLAIM_TICKET_PREFIX = "sk-claim-";
/** 单张券最多覆盖的服务数(防御性上限; 平台当前服务 < 10)。 */
export const CLAIM_TICKET_SERVICE_LIMIT = 64;

/** env 覆盖: 测试/灰度用(生产不设 = 走上面的常量)。 */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** 业务钥匙 TTL(毫秒)。`MIND_BUSINESS_KEY_TTL_DAYS` 可覆盖(测试用)。 */
export function businessKeyTtlMs(): number {
  return envInt("MIND_BUSINESS_KEY_TTL_DAYS", BUSINESS_KEY_TTL_DAYS) * 24 * 3600 * 1000;
}

/** 领取券 TTL(毫秒)。`MIND_CLAIM_TICKET_TTL_SECONDS` 优先(端到端测试把 TTL 调成 1 秒)。 */
export function claimTicketTtlMs(): number {
  const secs = Number(process.env.MIND_CLAIM_TICKET_TTL_SECONDS);
  if (Number.isFinite(secs) && secs > 0) return Math.floor(secs) * 1000;
  return envInt("MIND_CLAIM_TICKET_TTL_MINUTES", CLAIM_TICKET_TTL_MINUTES) * 60 * 1000;
}

/** 自动续期窗口(毫秒)。 */
export function renewalWindowMs(): number {
  return envInt("MIND_RENEWAL_WINDOW_DAYS", RENEWAL_WINDOW_DAYS) * 24 * 3600 * 1000;
}

// ── 生成 / 摘要(绝不外泄明文; 审计只落 sha256 前 8 位) ──────────────────
export function generateBusinessKey(): string {
  return `sk-mind-${randomBytes(32).toString("hex")}`;
}

export function generateClaimTicket(): string {
  return `${CLAIM_TICKET_PREFIX}${randomBytes(32).toString("hex")}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** 审计/日志用的指纹: sha256 前 8 位(**不是**钥匙本身, 不可反推)。 */
export function keyFingerprint(key: string): string {
  return hashApiKey(key).slice(0, 8);
}

export function isClaimTicket(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(CLAIM_TICKET_PREFIX);
}

// ── 领取券元数据(存 AgentRegistry.profile.claimTicket) ─────────────────
export type ClaimTicketStatus = "ISSUED" | "REDEEMED" | "EXPIRED" | "REVOKED" | "SUPERSEDED";

export interface ClaimTicketMeta {
  v: 1;
  status: ClaimTicketStatus;
  /** sha256(ticket) 全量(16 进制)。券本身就是凭据, 这里只存摘要。 */
  hash: string;
  /** 便于人读/审计的短指纹。 */
  hash8: string;
  issued_at: string;
  expires_at: string;
  expires_at_ms: number;
  services: string[];
  issued_by: string;
  redeemed_at?: string;
  redeemed_keys?: Array<{ service: string; action: "issued" | "reused"; key_fp: string; expires_at: string }>;
  /** 生命周期留痕(每次状态变化追加一条)。 */
  history?: Array<{ at: string; action: string; by: string; note?: string }>;
}

/** 解析身份行 profile 里的领取券元数据(容错: 解析失败/结构不对 -> null)。 */
export function readClaimTicket(profileRaw: string | null | undefined): ClaimTicketMeta | null {
  if (!profileRaw) return null;
  let obj: any;
  try {
    obj = JSON.parse(String(profileRaw));
  } catch {
    return null;
  }
  const t = obj && obj.claimTicket;
  if (!t || typeof t !== "object" || typeof t.hash !== "string" || !Array.isArray(t.services)) return null;
  return t as ClaimTicketMeta;
}

/** 把领取券元数据合并回 profile JSON(**保留** capabilityTier 等其他人写的键)。 */
export function mergeClaimTicket(profileRaw: string | null | undefined, meta: ClaimTicketMeta): string {
  let obj: any = {};
  if (profileRaw) {
    try {
      const parsed = JSON.parse(String(profileRaw));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed;
    } catch {
      obj = {};
    }
  }
  obj.claimTicket = meta;
  return JSON.stringify(obj);
}

// ── 明文读取口径(单一判据) ───────────────────────────────────────────────
/**
 * 明文缓存是否仍在可读窗口内。
 * 判据 = `api_key_plain` 非空 **且** `idempotent_until` 是一个**将来**的时间戳。
 * ⚠ 旧行(`idempotent_until IS NULL`, 2026-10-15 前的存量)一律视为**不可读** ——
 *   它们的明文没有可复算的发放时间, 按批准口径"只在发放后 1 小时内保留"只能判为已过期。
 *   物理清空由 `expireStaleKeys()`(带 includeLegacyPlain) 或一次性清理脚本负责。
 */
export function isPlaintextReadable(perm: { api_key_plain?: string | null; idempotent_until?: Date | number | null }, now: number = Date.now()): boolean {
  if (!perm || !perm.api_key_plain) return false;
  const until = perm.idempotent_until;
  if (until === null || until === undefined) return false;
  const ms = until instanceof Date ? until.getTime() : Number(until);
  return Number.isFinite(ms) && ms > now;
}

/** 读取侧取明文: 窗口外/无值 -> null(调用方据此走续发/换发路径)。 */
export function readablePlaintext(perm: { api_key_plain?: string | null; idempotent_until?: Date | number | null }, now: number = Date.now()): string | null {
  return isPlaintextReadable(perm, now) ? String(perm.api_key_plain) : null;
}

// ── 领取券: 签发 / 换取 / 作废 / 过期 ────────────────────────────────────
export interface IssueClaimTicketArgs {
  agentId: string;
  services: string[];
  actor: string;
  actorType: string;
  reason?: string;
}

export interface IssueClaimTicketResult {
  ticket: string;
  expires_at: string;
  ttl_seconds: number;
  services: string[];
  hash8: string;
}

/**
 * 签发一张一次性领取券(**作废该 agent 此前任何未换取的券**)。
 * 写点: AgentRegistry.profile.claimTicket (prisma.agentRegistry.update → 列 profile)。
 * 明文**不落库**: 券值只在本次响应里出现一次; 丢了就重新签(旧券随之作废)。
 */
export async function issueClaimTicket(args: IssueClaimTicketArgs): Promise<IssueClaimTicketResult> {
  const now = Date.now();
  const ttlMs = claimTicketTtlMs();
  const ticket = generateClaimTicket();
  const hash = hashApiKey(ticket);
  const expiresMs = now + ttlMs;
  const services = args.services.slice(0, CLAIM_TICKET_SERVICE_LIMIT);

  const row = await prisma.agentRegistry.findUnique({ where: { agent_id: args.agentId }, select: { profile: true } });
  if (!row) throw new Error(`agent ${args.agentId} not found (issueClaimTicket)`);

  const prev = readClaimTicket(row.profile);
  const history: ClaimTicketMeta["history"] = [];
  if (prev && (prev.status === "ISSUED" || prev.status === "REDEEMED")) {
    history.push({ at: new Date(now).toISOString(), action: "SUPERSEDED", by: args.actor, note: `prev hash8=${prev.hash8} prev_status=${prev.status}` });
  }
  const meta: ClaimTicketMeta = {
    v: 1,
    status: "ISSUED",
    hash,
    hash8: hash.slice(0, 8),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(expiresMs).toISOString(),
    expires_at_ms: expiresMs,
    services,
    issued_by: args.actor,
    history: history.length ? history : undefined,
  };
  // ⚠ 写法约束(为守门识别力, 见 scripts/check-agent-heartbeat-provenance.cjs): profile 的组装
  //   **必须**先算好、再作为单一值放进 `data: { profile }` —— 不要把 `{...meta, status: "..."}`
  //   这种**含 status 字面量**的对象字面量嵌进 data 块里: 守门的列名提取器会把嵌套对象的 `status:`
  //   当成 AgentRegistry.status **列**的写入, 于是 key-governance 会被误列进"status 写者清单",
  //   把"status 只有一个写者"这个不变量信号冲淡。下面的 `nextProfile` 变量就是为此存在的。
  const nextProfile = mergeClaimTicket(row.profile, meta);
  await prisma.agentRegistry.update({
    where: { agent_id: args.agentId },
    data: { profile: nextProfile },
  });
  await recordAudit({
    entityType: "AGENT", entityId: args.agentId,
    action: "CLAIM_TICKET_ISSUED",
    actor: args.actor, actorType: args.actorType,
    before: prev ? JSON.stringify({ claimTicket: { status: prev.status, hash8: prev.hash8 } }) : null,
    after: JSON.stringify({ claimTicket: { status: "ISSUED", hash8: meta.hash8, expires_at: meta.expires_at, services } }),
    metadata: { ttl_seconds: Math.floor(ttlMs / 1000), ticket_hash8: meta.hash8, prev_hash8: prev?.hash8 || null, reason: args.reason || null },
  });
  return { ticket, expires_at: meta.expires_at, ttl_seconds: Math.floor(ttlMs / 1000), services, hash8: meta.hash8 };
}

export interface RedeemClaimTicketArgs {
  agentId: string;
  ticket: string;
  actor?: string;
  actorType?: string;
  /** true = 对已存在且明文可读的 ACTIVE 钥匙**沿用**(不轮换, 避免打断在跑客户端)。 */
  reuseWhenPossible?: boolean;
}

export type RedeemClaimTicketResult =
  | {
      ok: true;
      agent_id: string;
      ticket_hash8: string;
      redeemed_at: string;
      services: Record<string, { status: string; api_key?: string; token_id?: string; endpoint?: string; expires_at?: string; permissions?: string[]; key_fp?: string; error?: string }>;
      business_key_ttl_days: number;
    }
  | { ok: false; code: "DENIED" | "EXPIRED" | "CONFLICT" | "NOT_FOUND"; message: string };

/**
 * 用领取券换一次业务钥匙。
 * 单次性 = 整串 CAS(`UPDATE ... WHERE agent_id=? AND profile=<换取前的整串>`)。
 * 顺序: 校验 → 发钥匙 → CAS 消费券(失败则补偿, 券保持可用) —— 保证"券作废"与"钥匙已发"同时成立。
 */
export async function redeemClaimTicket(args: RedeemClaimTicketArgs): Promise<RedeemClaimTicketResult> {
  const now = Date.now();
  const row = await prisma.agentRegistry.findUnique({ where: { agent_id: args.agentId }, select: { profile: true, status: true } });
  if (!row) return { ok: false, code: "NOT_FOUND", message: `agent ${args.agentId} 不存在` };
  const profileBefore = row.profile;
  const meta = readClaimTicket(profileBefore);
  // 无券 / 券形态不符 -> 拒绝(不区分"没签过"与"签过但不符", 防枚举)
  if (!meta || hashApiKey(args.ticket) !== meta.hash) {
    await recordAudit({
      entityType: "AGENT", entityId: args.agentId,
      action: "CLAIM_TICKET_REDEEM_DENIED",
      actor: args.actor || args.agentId, actorType: args.actorType || "agent_self",
      before: null, after: JSON.stringify({ reason: "hash_mismatch_or_absent" }),
      metadata: { agent_status: row.status },
    });
    return { ok: false, code: "DENIED", message: "领取券无效(未签发/已被换取/已作废)" };
  }
  if (meta.status !== "ISSUED") {
    await recordAudit({
      entityType: "AGENT", entityId: args.agentId,
      action: "CLAIM_TICKET_REDEEM_DENIED",
      actor: args.actor || args.agentId, actorType: args.actorType || "agent_self",
      before: JSON.stringify({ status: meta.status, hash8: meta.hash8 }), after: null,
      metadata: { reason: `ticket_status_${meta.status}` },
    });
    return { ok: false, code: "DENIED", message: `领取券已${meta.status === "REDEEMED" ? "被换取" : "作废"}(一次性凭据, 不可复用)` };
  }
  if (meta.expires_at_ms <= now) {
    // 组装与写分开(见上方"写法约束"): data 块里只出现 profile 一个列名
    const expiredProfile = mergeClaimTicket(profileBefore, { ...meta, status: "EXPIRED", history: [...(meta.history || []), { at: new Date(now).toISOString(), action: "EXPIRED", by: "system" }] });
    await prisma.agentRegistry.update({
      where: { agent_id: args.agentId },
      data: { profile: expiredProfile },
    }).catch(() => undefined);
    await recordAudit({
      entityType: "AGENT", entityId: args.agentId,
      action: "CLAIM_TICKET_REDEEM_DENIED",
      actor: args.actor || args.agentId, actorType: args.actorType || "agent_self",
      before: JSON.stringify({ status: "ISSUED", hash8: meta.hash8 }), after: JSON.stringify({ status: "EXPIRED" }),
      metadata: { reason: "ticket_expired", expires_at: meta.expires_at },
    });
    return { ok: false, code: "EXPIRED", message: `领取券已过期(${meta.expires_at}), 请管理员重新签发` };
  }

  // 发钥匙(默认沿用可读明文, 避免把在跑客户端打断)
  const issued = await issueBusinessKeysForAgent({
    agentId: args.agentId,
    serviceNames: meta.services,
    actor: args.actor || args.agentId,
    actorType: args.actorType || "agent_self",
    reuseWhenPossible: args.reuseWhenPossible !== false,
    allowRevokedRevival: false,
  });

  // CAS 消费券: profile 整串匹配才生效 —— 并发第二发必然 0 行
  const redeemedAt = new Date();
  const metaAfter: ClaimTicketMeta = {
    ...meta,
    status: "REDEEMED",
    redeemed_at: redeemedAt.toISOString(),
    redeemed_keys: Object.entries(issued).filter(([, v]) => v.status === "issued" || v.status === "reused")
      .map(([service, v]) => ({ service, action: v.status as "issued" | "reused", key_fp: v.key_fp || "", expires_at: v.expires_at || "" })),
    history: [...(meta.history || []), { at: redeemedAt.toISOString(), action: "REDEEMED", by: args.actor || args.agentId }],
  };
  const redeemedProfile = mergeClaimTicket(profileBefore, metaAfter);
  const cas = await prisma.agentRegistry.updateMany({
    where: { agent_id: args.agentId, profile: profileBefore as string },
    data: { profile: redeemedProfile, updated_at: redeemedAt },
  });
  if (cas.count !== 1) {
    // 并发/被其他写者改动: 券未被消费, 但钥匙可能已轮换 -> 明确报冲突, 让调用方重试(重试会命中幂等沿用)
    await recordAudit({
      entityType: "AGENT", entityId: args.agentId,
      action: "CLAIM_TICKET_REDEEM_DENIED",
      actor: args.actor || args.agentId, actorType: args.actorType || "agent_self",
      before: null, after: null,
      metadata: { reason: "cas_failed", note: "profile 在换取过程中被其他写者改动(并发); 券仍有效, 可重试" },
    });
    return { ok: false, code: "CONFLICT", message: "换取过程中身份行被并发修改, 请重试(券仍有效)" };
  }

  const redeemedKeys = metaAfter.redeemed_keys || [];
  await recordAudit({
    entityType: "AGENT", entityId: args.agentId,
    action: "CLAIM_TICKET_REDEEMED",
    actor: args.actor || args.agentId, actorType: args.actorType || "agent_self",
    before: JSON.stringify({ claimTicket: { status: "ISSUED", hash8: meta.hash8, services: meta.services } }),
    after: JSON.stringify({ claimTicket: { status: "REDEEMED", hash8: meta.hash8 }, services: redeemedKeys }),
    metadata: { ticket_hash8: meta.hash8, issued_count: redeemedKeys.filter((k) => k.action === "issued").length, reused_count: redeemedKeys.filter((k) => k.action === "reused").length, business_key_ttl_days: Math.floor(businessKeyTtlMs() / (24 * 3600 * 1000)) },
  });

  return {
    ok: true,
    agent_id: args.agentId,
    ticket_hash8: meta.hash8,
    redeemed_at: redeemedAt.toISOString(),
    services: issued,
    business_key_ttl_days: Math.floor(businessKeyTtlMs() / (24 * 3600 * 1000)),
  };
}

/** 作废某 agent 上未换取的券(注册重签/撤销身份时调用)。**不抛**(best-effort)。 */
export async function revokeClaimTicket(agentId: string, actor: string, actorType: string, note: string): Promise<boolean> {
  try {
    const row = await prisma.agentRegistry.findUnique({ where: { agent_id: agentId }, select: { profile: true } });
    const meta = readClaimTicket(row?.profile);
    if (!row || !meta || meta.status !== "ISSUED") return false;
    const now = Date.now();
    const revokedProfile = mergeClaimTicket(row.profile, { ...meta, status: "REVOKED", history: [...(meta.history || []), { at: new Date(now).toISOString(), action: "REVOKED", by: actor, note }] });
    await prisma.agentRegistry.update({
      where: { agent_id: agentId },
      data: { profile: revokedProfile },
    });
    await recordAudit({
      entityType: "AGENT", entityId: agentId,
      action: "CLAIM_TICKET_REVOKED",
      actor, actorType,
      before: JSON.stringify({ claimTicket: { status: "ISSUED", hash8: meta.hash8 } }),
      after: JSON.stringify({ claimTicket: { status: "REVOKED" } }),
      metadata: { ticket_hash8: meta.hash8, note },
    });
    return true;
  } catch (e: any) {
    console.error("[key-governance] revokeClaimTicket failed:", e?.message || e);
    return false;
  }
}

// ── 业务钥匙: 签发 / 轮换 ────────────────────────────────────────────────
export interface IssuedKeyEntry {
  status: "issued" | "reused" | "skipped" | "failed";
  api_key?: string;
  token_id?: string;
  endpoint?: string;
  expires_at?: string;
  permissions?: string[];
  key_fp?: string;
  error?: string;
}

function safeJsonArray(s: string | null | undefined, fallback: string[]): string[] {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 给 (agent, service) 发一把业务钥匙, 或(允许时)**沿用**仍可读的既有明文。
 * 写点: AgentServicePermission upsert(api_key_hash/api_key_plain/token_id/expires_at/permissions/config/status/idempotent_until)。
 */
export async function issueBusinessKeyForService(opts: {
  agentId: string;
  serviceName: string;
  actor: string;
  actorType: string;
  reuseWhenPossible: boolean;
  allowRevokedRevival: boolean;
}): Promise<IssuedKeyEntry> {
  const now = Date.now();
  const meta = await prisma.agentService.findUnique({ where: { name: opts.serviceName } });
  if (!meta || meta.status !== "ACTIVE" || !meta.enabled) {
    return { status: "skipped", error: `service ${opts.serviceName} 不存在或未启用` };
  }
  const existing = await prisma.agentServicePermission.findUnique({
    where: { agent_id_service_name: { agent_id: opts.agentId, service_name: opts.serviceName } },
  });
  if (existing && existing.status === "REVOKED" && !opts.allowRevokedRevival) {
    return { status: "skipped", error: `service ${opts.serviceName} 已被撤销(REVOKED), 需管理员显式重新授权` };
  }
  if (existing && existing.status === "ACTIVE" && new Date(existing.expires_at).getTime() > now && opts.reuseWhenPossible) {
    const plain = readablePlaintext(existing, now);
    if (plain) {
      return {
        status: "reused", api_key: plain, token_id: existing.token_id,
        endpoint: meta.endpoint, expires_at: new Date(existing.expires_at).toISOString(),
        permissions: safeJsonArray(existing.permissions, []), key_fp: keyFingerprint(plain),
      };
    }
  }
  const apiKey = generateBusinessKey();
  const expiresAt = new Date(now + businessKeyTtlMs());
  const plainUntil = new Date(now + PLAINTEXT_CACHE_MS);
  const permissions = existing?.permissions ?? JSON.stringify(safeJsonArray(meta.available_perms, []));
  const config = existing?.config ?? (meta.default_config || "");
  await prisma.agentServicePermission.upsert({
    where: { agent_id_service_name: { agent_id: opts.agentId, service_name: opts.serviceName } },
    create: {
      agent_id: opts.agentId, service_name: opts.serviceName,
      api_key_hash: hashApiKey(apiKey), api_key_plain: apiKey, token_id: `tk_${randomBytes(8).toString("hex")}`,
      expires_at: expiresAt, permissions, config, status: "ACTIVE", idempotent_until: plainUntil,
    },
    update: {
      api_key_hash: hashApiKey(apiKey), api_key_plain: apiKey, token_id: `tk_${randomBytes(8).toString("hex")}`,
      expires_at: expiresAt, permissions, config, status: "ACTIVE", idempotent_until: plainUntil,
    },
  });
  await recordAudit({
    entityType: "AGENT", entityId: opts.agentId,
    action: existing ? "ISSUE_SERVICE_KEY_ROTATED" : "ISSUE_SERVICE_KEY",
    actor: opts.actor, actorType: opts.actorType,
    before: existing ? JSON.stringify({ service_name: opts.serviceName, status: existing.status, expires_at: new Date(existing.expires_at).toISOString(), key_fp: existing.api_key_hash.slice(0, 8) }) : null,
    after: JSON.stringify({ service_name: opts.serviceName, status: "ACTIVE", expires_at: expiresAt.toISOString(), key_fp: keyFingerprint(apiKey) }),
    metadata: { ttl_days: Math.floor(businessKeyTtlMs() / (24 * 3600 * 1000)), plaintext_cache_seconds: Math.floor(PLAINTEXT_CACHE_MS / 1000), reused: false },
  });
  return { status: "issued", api_key: apiKey, expires_at: expiresAt.toISOString(), endpoint: meta.endpoint, permissions: safeJsonArray(permissions, []), key_fp: keyFingerprint(apiKey) };
}

/** 批量签发/沿用(register 幂等沿用 / 换取券 / approve 都走这里)。 */
export async function issueBusinessKeysForAgent(opts: {
  agentId: string;
  serviceNames: string[];
  actor: string;
  actorType: string;
  reuseWhenPossible: boolean;
  allowRevokedRevival: boolean;
}): Promise<Record<string, IssuedKeyEntry>> {
  const out: Record<string, IssuedKeyEntry> = {};
  const seen = new Set<string>();
  for (const rawName of opts.serviceNames) {
    const name = String(rawName || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    try {
      out[name] = await issueBusinessKeyForService({ ...opts, serviceName: name });
    } catch (e: any) {
      out[name] = { status: "failed", error: String(e?.message || e).slice(0, 200) };
    }
  }
  return out;
}

/**
 * refresh-service-key 的核心: **轮换**密钥(新密钥值) + 续期 90 天 + 明文窗口 1 小时 + 审计。
 * 修复的两处既有缺陷: ①旧实现只换 hash 不改 expires_at("轮换不续期"); ②全文件零审计。
 */
export async function refreshBusinessKey(opts: {
  agentId: string;
  serviceName: string;
  actor: string;
  actorType: string;
}): Promise<{ ok: true; api_key: string; token_id: string; expires_at: string; key_fp: string; endpoint: string } | { ok: false; code: number; message: string }> {
  const meta = await prisma.agentService.findUnique({ where: { name: opts.serviceName } });
  if (!meta) return { ok: false, code: 404, message: `未知服务 ${opts.serviceName}` };
  const existing = await prisma.agentServicePermission.findUnique({
    where: { agent_id_service_name: { agent_id: opts.agentId, service_name: opts.serviceName } },
  });
  if (!existing) return { ok: false, code: 404, message: `该 agent 尚未被授予 ${opts.serviceName}` };
  if (existing.status === "REVOKED") return { ok: false, code: 403, message: `该 agent 的 ${opts.serviceName} 已被吊销; 请联系管理员重新授权` };

  const now = Date.now();
  const apiKey = generateBusinessKey();
  const expiresAt = new Date(now + businessKeyTtlMs());
  const tokenId = `tk_${randomBytes(8).toString("hex")}`;
  await prisma.agentServicePermission.update({
    where: { id: existing.id },
    data: {
      api_key_hash: hashApiKey(apiKey), api_key_plain: apiKey, token_id: tokenId,
      expires_at: expiresAt, status: "ACTIVE", idempotent_until: new Date(now + PLAINTEXT_CACHE_MS),
    },
  });
  await recordAudit({
    entityType: "AGENT", entityId: opts.agentId,
    action: "REFRESH_SERVICE_KEY",
    actor: opts.actor, actorType: opts.actorType,
    before: JSON.stringify({ service_name: opts.serviceName, status: existing.status, expires_at: new Date(existing.expires_at).toISOString(), key_fp: existing.api_key_hash.slice(0, 8) }),
    after: JSON.stringify({ service_name: opts.serviceName, status: "ACTIVE", expires_at: expiresAt.toISOString(), key_fp: keyFingerprint(apiKey) }),
    metadata: { rotated: true, extended: true, ttl_days: Math.floor(businessKeyTtlMs() / (24 * 3600 * 1000)), previous_expires_at: new Date(existing.expires_at).toISOString() },
  });
  return { ok: true, api_key: apiKey, token_id: tokenId, expires_at: expiresAt.toISOString(), key_fp: keyFingerprint(apiKey), endpoint: meta.endpoint };
}

// ── 到期翻转 / 明文清理 / 券过期 ────────────────────────────────────────
export interface ExpireStaleResult {
  expired_keys: number;
  cleared_plaintext: number;
  expired_tickets: number;
}

/**
 * 唯一的"到期收口"实现:
 *  · ACTIVE 且 expires_at<=now 的业务钥匙 -> status='EXPIRED'(此前全仓无此写点);
 *  · 明文缓存过窗口 -> api_key_plain=NULL(**物理清空**); 存量行(idempotent_until IS NULL)
 *    只在 includeLegacyPlain=true 时清(把"是否批量动存量行"留给人类的一次性清理步骤);
 *  · 未换取的券过 TTL -> profile.claimTicket.status='EXPIRED' + 审计。
 * expires_at 在库里**混合存储**(Prisma 写整数毫秒 / 裸 SQL 写 ISO 文本, 实测 44 整 + 17 文本),
 *   所以按 `typeof()` 分流比较 —— 只写一种比较会漏掉另一种。
 */
export async function expireStaleKeys(opts: { includeLegacyPlain?: boolean; actor?: string; actorType?: string } = {}): Promise<ExpireStaleResult> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const expiredKeys = await prisma.$executeRaw`
    UPDATE AgentServicePermission
       SET status = 'EXPIRED', updated_at = ${now}
     WHERE status = 'ACTIVE'
       AND (
         (typeof(expires_at) IN ('integer','real') AND expires_at <= ${now})
         OR (typeof(expires_at) = 'text' AND expires_at <= ${nowIso})
       )
  `;

  const cleared = opts.includeLegacyPlain
    ? await prisma.$executeRaw`
        UPDATE AgentServicePermission
           SET api_key_plain = NULL, idempotent_until = NULL, updated_at = ${now}
         WHERE api_key_plain IS NOT NULL
           AND (idempotent_until IS NULL OR idempotent_until <= ${now})
      `
    : await prisma.$executeRaw`
        UPDATE AgentServicePermission
           SET api_key_plain = NULL, idempotent_until = NULL, updated_at = ${now}
         WHERE api_key_plain IS NOT NULL
           AND idempotent_until IS NOT NULL
           AND idempotent_until <= ${now}
      `;

  // 券过期(逐 agent; 只有 profile 里带 claimTicket 的行会被改, 量级 = 待接入 agent 数)
  let expiredTickets = 0;
  const rows = await prisma.agentRegistry.findMany({ select: { agent_id: true, profile: true } });
  for (const r of rows) {
    const meta = readClaimTicket(r.profile);
    if (!meta || meta.status !== "ISSUED" || meta.expires_at_ms > now) continue;
    const expiredTicketProfile = mergeClaimTicket(r.profile, { ...meta, status: "EXPIRED", history: [...(meta.history || []), { at: nowIso, action: "EXPIRED", by: "system:expire-stale-keys" }] });
    const wrote = await prisma.agentRegistry.updateMany({
      where: { agent_id: r.agent_id, profile: r.profile as string },
      data: {
        profile: expiredTicketProfile,
        updated_at: new Date(now),
      },
    });
    if (wrote.count === 1) {
      expiredTickets++;
      await recordAudit({
        entityType: "AGENT", entityId: r.agent_id,
        action: "CLAIM_TICKET_EXPIRED",
        actor: opts.actor || "system", actorType: opts.actorType || "system",
        before: JSON.stringify({ claimTicket: { status: "ISSUED", hash8: meta.hash8, expires_at: meta.expires_at } }),
        after: JSON.stringify({ claimTicket: { status: "EXPIRED" } }),
        metadata: { ticket_hash8: meta.hash8 },
      });
    }
  }

  const result: ExpireStaleResult = { expired_keys: Number(expiredKeys || 0), cleared_plaintext: Number(cleared || 0), expired_tickets: expiredTickets };
  if (result.expired_keys || result.cleared_plaintext || result.expired_tickets) {
    await recordAudit({
      entityType: "AGENT", entityId: "-",
      action: "EXPIRE_STALE_KEYS",
      actor: opts.actor || "system", actorType: opts.actorType || "system",
      before: null, after: JSON.stringify(result),
      metadata: { include_legacy_plain: !!opts.includeLegacyPlain },
    });
  }
  return result;
}

// ── 到期前自动续期(agent 无感) ──────────────────────────────────────────
/**
 * 窗口内(默认到期前 30 天)被使用的钥匙: **原地**延长 expires_at(+90 天)。
 *  · 只改 expires_at —— **不换密钥值**, 客户端无感(符合"到期前自动换发（agent 无感）");
 *  · 密钥值轮换仍需客户端调 refresh-service-key(boot 时自动), 二者分工见交付报告;
 *  · `MIND_AUTO_RENEW_OFF=1` 可一键关掉(灰度/回滚)。
 * fire-and-forget 调用方必须 try/catch(它位于鉴权热路径)。
 */
export async function maybeAutoRenewKey(perm: {
  id: string; agent_id: string; service_name: string; expires_at: Date | number;
  status?: string | null;
}, opts: { actor?: string; actorType?: string } = {}): Promise<boolean> {
  const off = String(process.env.MIND_AUTO_RENEW_OFF || "").trim().toLowerCase();
  if (off === "1" || off === "true" || off === "yes" || off === "on") return false;
  if (perm.status && perm.status !== "ACTIVE") return false;
  const now = Date.now();
  const expMs = perm.expires_at instanceof Date ? perm.expires_at.getTime() : Number(perm.expires_at);
  if (!Number.isFinite(expMs) || expMs <= now) return false;
  const remaining = expMs - now;
  if (remaining > renewalWindowMs()) return false;
  const newExpiry = new Date(now + businessKeyTtlMs());
  await prisma.agentServicePermission.update({
    where: { id: perm.id },
    data: { expires_at: newExpiry, updated_at: new Date(now) },
  });
  await recordAudit({
    entityType: "AGENT", entityId: perm.agent_id,
    action: "AUTO_RENEW_KEY",
    actor: opts.actor || "system", actorType: opts.actorType || "system",
    before: JSON.stringify({ service_name: perm.service_name, expires_at: new Date(expMs).toISOString() }),
    after: JSON.stringify({ service_name: perm.service_name, expires_at: newExpiry.toISOString() }),
    metadata: { remaining_days: Math.floor(remaining / (24 * 3600 * 1000)), ttl_days: Math.floor(businessKeyTtlMs() / (24 * 3600 * 1000)), secret_rotated: false, note: "原地续期(不换密钥值), 真正的密钥轮换走 refresh-service-key" },
  });
  return true;
}

// ── 撤销权限模型(item 5) ────────────────────────────────────────────────
export type ActorKind = "root_admin" | "identity_admin";

export interface Actor {
  kind: ActorKind;
  /** 平台管理凭据(x-admin-key)为 null; 身份管理员为自己的 agent_id */
  agentId: string | null;
  role: string | null;
}

/**
 * 撤销权限判据(纯函数, 可逐条测):
 *  1) 调用者必须是管理员 —— root_admin(x-admin-key) 或 identity_admin(role ∈ ADMIN|OWNER);
 *     **普通服务钥匙(EDITOR/VIEWER/NULL)一律拒绝**(修掉"任何一把有效 service key 都能撤销任意 agent")。
 *  2) 默认只能撤**自己名下**的身份/服务:
 *     · identity_admin: target === self → 允许; target !== self → 需要 `allow_cross_identity=true`
 *       **且** role=OWNER(ADMIN 无权跨身份, 缩小爆炸半径);
 *     · root_admin: 平台管理员凭据本身就是"显式撤他人"的动作(它没有"自己名下"的服务身份),
 *       允许跨身份并**逐条审计**(actorType=admin_key + cross_identity=true)。
 */
export function authorizeRevokeScope(
  actor: Actor | null | undefined,
  targetAgentId: string,
  allowCrossIdentity: boolean,
): { ok: true; crossIdentity: boolean } | { ok: false; code: "FORBIDDEN"; message: string } {
  if (!actor || (actor.kind === "identity_admin" && !actor.agentId)) {
    return { ok: false, code: "FORBIDDEN", message: "撤销操作需要管理员凭据(x-admin-key)或 ADMIN/OWNER 身份的服务钥匙" };
  }
  if (actor.kind === "root_admin") {
    return { ok: true, crossIdentity: true };
  }
  const role = (actor.role || "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    return { ok: false, code: "FORBIDDEN", message: `撤销操作需要管理员权限(当前 role=${actor.role || "NULL"}); 普通服务钥匙不能撤销任何身份/服务` };
  }
  const isSelf = actor.agentId === targetAgentId;
  if (isSelf) return { ok: true, crossIdentity: false };
  if (!allowCrossIdentity) {
    return { ok: false, code: "FORBIDDEN", message: `跨身份撤销被拒: ${actor.agentId} 只能撤销自己名下的身份/服务; 确需撤销 ${targetAgentId} 请显式传 allow_cross_identity=true(仅 OWNER)` };
  }
  if (role !== "OWNER") {
    return { ok: false, code: "FORBIDDEN", message: `跨身份撤销被拒: role=${role} 无权跨身份(仅 OWNER 可显式跨身份撤销)` };
  }
  return { ok: true, crossIdentity: true };
}
