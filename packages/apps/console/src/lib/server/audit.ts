/**
 * audit.ts — 平台写操作统一审计（0.4.39-08 批1，按 uiux 契约 2026-11-09 对齐）
 *
 * 与 uiux 判据（scripts/check-platform-write-audit.cjs）的对齐点：
 *   · 落 mind 库的 "AuditLog"（平台既有审计表，2418 行在库），**不自建新表**；
 *   · entityType: 'PlatformConfig' | 'PlatformAuth'
 *   · action: 'platform.config.{create,update,delete}' / 'platform.auth.{grant,revoke,update}' 等
 *   · actor / actorType / createdAt 必填；before/after 为 JSON **字符串**；
 *   · metadata 必含 { changeType, confirmed: true } 或 confirmToken（二次确认痕迹）；
 *   · 密钥在 before/after 内脱敏（sk-****）；完整值不落库。
 *
 * 失败策略：PLATFORM_AUDIT_ENFORCE !== "0" -> 抛错（调用方 fail-closed）；
 *          = "0" -> 只打 error 日志不阻断（表迁移/修复期）。
 *
 * 为什么不再自建 platform_audit_log：uiux 判据与平台既有审计都在 AuditLog；
 *   两个"审计源"必然漂移（今天已经吃过"两套口径"的多次亏）。
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { Pool } from "pg";
import { diffOnly, hasSecretKey, maskSecrets } from "./audit-core";

export type EntityType = "PlatformConfig" | "PlatformAuth";

export interface AuditActor {
  /** 人或 agent 标识（如 session_id / 脚本名） */
  id: string;
  /** 类别按 uiux 契约统一为 human | agent（脚本类归 agent，不再并存 user/script） */
  type: "human" | "agent";
}

export interface AuditEntry {
  entityType: EntityType;
  entityId?: string;
  action: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  actor: AuditActor;
  /** create | update | delete | grant | revoke */
  changeType: string;
  /** 二次确认：confirmed=true 或带 confirmToken */
  confirmed?: boolean;
  confirmToken?: string;
  extraMetadata?: Record<string, unknown>;
}

export interface AuditResult { ok: boolean; id?: string; error?: string }

function mindDbUrl(): string {
  if (process.env.PLATFORM_AUDIT_DB_URL) return process.env.PLATFORM_AUDIT_DB_URL;
  const conf = (process.env.HOME || "~") + "/.config/systemd/user/macs-platform.service.d/40-mind-auth.conf";
  try {
    const line = fs.readFileSync(conf, "utf8").split("\n").find((l) => l.includes("MIND_DATABASE_URL="));
    if (line) return line.split("MIND_DATABASE_URL=")[1].split("?")[0].trim();
  } catch { /* ignore */ }
  return process.env.MIND_DATABASE_URL || "";
}

let pool: Pool | null = null;
function getPool(): Pool | null {
  const url = mindDbUrl();
  if (!url) return null;
  if (!pool) pool = new Pool({ connectionString: url, max: 2 });
  return pool;
}

/** 仅供自测：重置连接池（生产 env 不变，无热更需求） */
export function _resetAuditPoolForTest(): void {
  try { void pool?.end(); } catch { /* ignore */ }
  pool = null;
}

function newId(): string {
  return "audit_" + Date.now() + "_" + randomBytes(4).toString("hex").slice(0, 8);
}

/**
 * 写一条平台写操作审计。
 * 调用方应在**业务写入之前**调用（本批 model-config 就是先审计后落盘），fail-closed 才有意义。
 */
export async function writeAudit(e: AuditEntry): Promise<AuditResult> {
  const enforce = String(process.env.PLATFORM_AUDIT_ENFORCE ?? "1") !== "0";
  const fail = (msg: string): AuditResult => {
    if (enforce) throw new Error("AUDIT_WRITE_FAILED: " + msg);
    console.error("[audit] 降级（PLATFORM_AUDIT_ENFORCE=0）: " + msg);
    return { ok: false, error: msg };
  };

  if (!e.actor || !e.actor.id || !e.actor.type) return fail("actor 缺失（who 必填）");
  if (!e.action) return fail("action 缺失（what 必填）");
  if (!e.changeType) return fail("changeType 缺失");
  const confirmed = e.confirmed === true || !!e.confirmToken;
  if (!confirmed) return fail("缺二次确认（confirmed / confirmToken）");

  const diff = diffOnly(e.before, e.after);
  const beforeStr = diff.keys.length && Object.keys(diff.from).length ? JSON.stringify(maskSecrets(diff.from)) : "";
  const afterStr = diff.keys.length && Object.keys(diff.to).length ? JSON.stringify(maskSecrets(diff.to)) : "";
  // create 允许 before 空；delete 允许 after 空（uiux 判据按 changeType 认）
  if (!beforeStr && !afterStr) return fail("before 与 after 都为空（无可审计变更）");

  // 2026-11-09（uiux 复核阻断）：metadata 也必须脱敏 —— 首版只脱 before/after，
  //   而失败补偿审计把 attemptedBefore/attemptedAfter 原样塞进 metadata -> 审计表自己成了泄露源。
  //   规则：metadata 全量过 maskSecrets；confirmToken 是凭证，只落短哈希（可关联、不可还原）。
  const tokenHash = e.confirmToken
    ? "sha256:" + createHash("sha256").update(String(e.confirmToken)).digest("hex").slice(0, 12)
    : undefined;
  // 注意：只对 extraMetadata 做深度脱敏，**不能对整个 metadata 对象做**——
  //   否则结构字段名的键名（secretMasked 含 SECRET、diffKeys 含 KEY、confirmToken 含 TOKEN）
  //   会被 regex 误判成"密钥键"而整列被替换成 ****（实测踩过，导致 diffKeys 丢失）。
  const metadata = JSON.stringify(Object.assign(
    {
      changeType: e.changeType,
      confirmed: e.confirmed === true,
      confirmToken: tokenHash,
      secretMasked: hasSecretKey(diff.keys),
      diffKeys: diff.keys,
    },
    (maskSecrets(e.extraMetadata || {}) as Record<string, unknown>)
  ));

  const p = getPool();
  if (!p) return fail("审计库未配置（PLATFORM_AUDIT_DB_URL / MIND_DATABASE_URL 都取不到）");

  try {
    const id = newId();
    await p.query(
      'INSERT INTO "AuditLog" (id, "entityType", "entityId", action, actor, "actorType", before, after, metadata, "createdAt")' +
      " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())",
      [id, e.entityType, e.entityId || null, e.action, e.actor.id, e.actor.type, beforeStr || null, afterStr || null, metadata]
    );
    return { ok: true, id };
  } catch (err) {
    return fail(String((err as Error)?.message || err).slice(0, 300));
  }
}
