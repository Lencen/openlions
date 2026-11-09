/**
 * 商业版 v0.1 entitlement/license 核心（0.4.40-05）
 *
 * 设计见 docs/productization/COMMERCIAL-V0.1-ENTITLEMENT-2026-11-09.md
 *   license.json = { payload: <base64(json claims)>, signature: <base64(Ed25519(payload))> }
 *   公钥只从服务端 env LIONS_LICENSE_PUBLIC_KEY 读取，不联网、不下发浏览器。
 *   验签失败/过期/缺 entitlement 一律 fail-closed；open 版无 license。
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

export type LicenseEdition = "internal" | "commercial" | "open";

export interface LicenseClaims {
  tenantId: string;
  edition: LicenseEdition;
  entitlements: string[];
  issuedAt?: string;
  expiresAt?: string;
  graceDays?: number;
}

export interface VerifiedLicense extends LicenseClaims {
  raw: string;
}

export interface LicenseResult {
  ok: boolean;
  reason?: string;
  license?: VerifiedLicense;
}

const INTERNAL_TENANT = "selfonline";
const ALL = ["*"];

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

function parsePayload(payloadB64: string): LicenseClaims | null {
  try {
    const raw = Buffer.from(payloadB64, "base64").toString("utf8");
    const p = JSON.parse(raw) as LicenseClaims;
    if (!p || typeof p.tenantId !== "string" || !p.tenantId) return null;
    if (p.edition !== "internal" && p.edition !== "commercial" && p.edition !== "open") return null;
    if (!Array.isArray(p.entitlements)) return null;
    return p;
  } catch {
    return null;
  }
}

/** 纯校验：不读 env，便于测试。publicKeyPem 为空 -> 失败。 */
export function verifyLicenseWithKey(raw: string, publicKeyPem: string, now: Date = new Date()): LicenseResult {
  if (!raw.trim()) return { ok: false, reason: "license 为空" };
  if (!publicKeyPem.trim()) return { ok: false, reason: "未配置 LIONS_LICENSE_PUBLIC_KEY" };
  let doc: { payload?: string; signature?: string };
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "license 不是合法 JSON" };
  }
  if (!doc.payload || !doc.signature) return { ok: false, reason: "license 缺 payload/signature" };
  const claims = parsePayload(doc.payload);
  if (!claims) return { ok: false, reason: "license payload 非法" };
  try {
    const key = createPublicKey(publicKeyPem);
    const ok = cryptoVerify(null, Buffer.from(canonicalJson(claims), "utf8"), key, Buffer.from(doc.signature, "base64"));
    if (!ok) return { ok: false, reason: "license 签名不匹配" };
  } catch (e) {
    return { ok: false, reason: "license 验签异常: " + String((e as Error)?.message || e) };
  }
  if (claims.expiresAt) {
    const exp = new Date(claims.expiresAt).getTime();
    if (!Number.isFinite(exp)) return { ok: false, reason: "expiresAt 非法" };
    const graceMs = Math.max(0, Number(claims.graceDays || 0)) * 24 * 3600 * 1000;
    if (now.getTime() > exp + graceMs) return { ok: false, reason: "license 已过期（含宽限）" };
  }
  return { ok: true, license: { ...claims, raw } };
}

/** 生产入口：公钥从服务端 env 读。 */
export function verifyLicense(raw: string, now: Date = new Date()): LicenseResult {
  return verifyLicenseWithKey(raw, String(process.env.LIONS_LICENSE_PUBLIC_KEY || ""), now);
}

/** selfonline 内部租户：商业全量授权，但只在 internal 版允许直接构造。 */
export function internalLicense(tenantId = INTERNAL_TENANT): VerifiedLicense {
  return { tenantId, edition: "internal", entitlements: ALL.slice(), raw: "internal:selfonline" };
}

export function hasEntitlement(license: VerifiedLicense | null | undefined, key: string): boolean {
  if (!license) return false;
  if (license.edition === "open") return false;
  if (license.edition === "internal") return true;
  return license.entitlements.includes("*") || license.entitlements.includes(key);
}

/** 供 API 中间件使用：返回 null 表示放行，否则给 403 响应体。 */
export function denyReason(license: VerifiedLicense | null | undefined, key: string): string | null {
  if (!license) return "NO_LICENSE";
  if (license.edition === "open") return "OPEN_EDITION";
  if (!hasEntitlement(license, key)) return "ENTITLEMENT_MISSING:" + key;
  return null;
}

