/**
 * license.ts — 离线授权校验 (2026-09-10, 商业化路径前置: 打包订阅授权 + 离线部署)
 *
 * 设计:
 *   - 授权文件 = JSON payload + Ed25519 签名(厂商私钥签发, 平台内嵌公钥校验) => 离线可验证、防篡改;
 *   - 平台授权(platform): 版本/客户/到期/最大 agent 数/机器绑定;
 *   - 功能授权(features): 按功能键开关(可带到期/额度), 业务代码用 assertFeature() 判定;
 *   - 模式: LIONS_LICENSE_REQUIRED=1(交付) 时缺失/无效 => 拒绝; 开发模式(默认)缺授权 => 放行并告警;
 *   - 宽限期: 到期后仍可用 LIONS_LICENSE_GRACE_DAYS 天(默认 7), 避免客户机房续期延迟中断业务。
 */
import fs from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";

// 运行时读取(不缓存到模块层): 便于交付环境 env 覆盖 + 测试注入。
// 2026-10-27 (商业化线): 不能硬编码 ~；开源导出会把它改成 "~"，fs 不会展开。
const licenseFile = () => process.env.LIONS_LICENSE_FILE || path.join(process.env.HOME || os.homedir(), ".config", "lions", "license.json");
const graceDays = () => Number(process.env.LIONS_LICENSE_GRACE_DAYS || "7");

/** 厂商公钥(仅公钥入库; 私钥由厂商离线保管) —— 由 scripts/license-gen.mjs 生成后写入 */
export const VENDOR_PUBLIC_KEY_PEM = process.env.LIONS_LICENSE_PUBKEY || [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAOK0QYnsj27dktwLiUU+r+2bzQ+/wPVV7boymyCg3PgY=",
  "-----END PUBLIC KEY-----",
].join("\n");

export interface LicensePayload {
  v: number;
  licenseId: string;
  customer: string;
  issuedAt: string;
  expiresAt: string;
  platform: { edition: string; maxAgents?: number; binding?: string | null };
  features: Record<string, { enabled: boolean; expiresAt?: string | null; limit?: number | null }>;
  note?: string;
}
export interface LicenseStatus {
  state: "valid" | "grace" | "expired" | "invalid" | "missing" | "development";
  source: string;
  payload: LicensePayload | null;
  reason?: string;
  daysLeft?: number | null;
  required: boolean;
}

/** 规范化 JSON(键序稳定) —— 签名与校验必须用同一序列化 */
function canonical(obj: any): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonical).join(",") + "]";
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

export function machineFingerprint(): string {
  const parts: string[] = [];
  try { parts.push(fs.readFileSync("/etc/machine-id", "utf-8").trim()); } catch { /* ignore */ }
  try { parts.push(fs.readFileSync("/sys/class/dmi/id/product_uuid", "utf-8").trim()); } catch { /* ignore */ }
  parts.push(os.hostname());
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

let cached: LicenseStatus | null = null;
let cachedAt = 0;

export function licenseStatus(force = false): LicenseStatus {
  if (!force && cached && Date.now() - cachedAt < 60000) return cached;
  const required = process.env.LIONS_LICENSE_REQUIRED === "1";
  let raw = "";
  let source = licenseFile();
  try {
    if (process.env.LIONS_LICENSE_B64) { raw = Buffer.from(process.env.LIONS_LICENSE_B64, "base64").toString("utf-8"); source = "env:LIONS_LICENSE_B64"; }
    else raw = fs.readFileSync(licenseFile(), "utf-8");
  } catch {
    cached = { state: required ? "missing" : "development", source, payload: null, required, reason: required ? "未找到授权文件且 LIONS_LICENSE_REQUIRED=1" : "开发模式: 未安装授权, 全部功能放行(交付前必须安装)" };
    cachedAt = Date.now(); return cached;
  }
  let doc: any = null;
  try { doc = JSON.parse(raw); } catch { cached = { state: "invalid", source, payload: null, required, reason: "授权文件不是合法 JSON" }; cachedAt = Date.now(); return cached; }
  const payload = doc && doc.payload;
  const signature = doc && doc.signature;
  if (!payload || !signature) { cached = { state: "invalid", source, payload: null, required, reason: "缺少 payload/signature" }; cachedAt = Date.now(); return cached; }
  let sigOk = false;
  try { sigOk = crypto.verify(null, Buffer.from(canonical(payload), "utf-8"), VENDOR_PUBLIC_KEY_PEM, Buffer.from(signature, "base64")); }
  catch (e: any) { cached = { state: "invalid", source, payload: null, required, reason: "公钥/签名格式错误: " + String(e && e.message || "").slice(0, 60) }; cachedAt = Date.now(); return cached; }
  if (!sigOk) { cached = { state: "invalid", source, payload: null, required, reason: "签名校验失败(授权被篡改或非本厂商签发)" }; cachedAt = Date.now(); return cached; }
  const exp = Date.parse(payload.expiresAt || "");
  const daysLeft = Number.isFinite(exp) ? Math.ceil((exp - Date.now()) / 86400000) : null;
  const binding = payload.platform && payload.platform.binding;
  if (binding && binding !== "any" && binding !== machineFingerprint()) { cached = { state: "invalid", source, payload, daysLeft, required, reason: "机器绑定不匹配(授权绑定到其他机器)" }; cachedAt = Date.now(); return cached; }
  const state: LicenseStatus["state"] = daysLeft == null ? "invalid" : daysLeft >= 0 ? "valid" : (daysLeft >= -graceDays() ? "grace" : "expired");
  cached = { state, source, payload, daysLeft, required, reason: state === "grace" ? "已过期, 处于宽限期(" + graceDays() + " 天)" : state === "expired" ? "已过期且超出宽限期" : undefined };
  cachedAt = Date.now();
  return cached;
}

/** 功能授权判定: 开发模式放行; 交付模式按 features 校验(含功能级到期) */
export function hasFeature(key: string, opts?: { fresh?: boolean }): { ok: boolean; reason: string } {
  // 2026-10-27（平台数据线 TOCTOU 要求）: 默认走 60s 缓存；执行前的**二次校验必须 fresh**，
  //   否则"入口校验通过 → 中间 license 被撤销 → 执行前再验"依然是旧的缓存值，等于没验。
  const st = licenseStatus(opts?.fresh === true);
  if (st.state === "development") return { ok: true, reason: "开发模式" };
  if (st.state === "missing" || st.state === "invalid") return { ok: false, reason: st.reason || "授权无效" };
  if (st.state === "expired") return { ok: false, reason: "授权已过期" };
  const f = st.payload && st.payload.features ? st.payload.features[key] : null;
  if (!f || f.enabled !== true) return { ok: false, reason: "功能未授权: " + key };
  if (f.expiresAt) { const t = Date.parse(f.expiresAt); if (Number.isFinite(t) && Date.now() > t) return { ok: false, reason: "功能授权已到期: " + key }; }
  return { ok: true, reason: st.state === "grace" ? "宽限期内" : "已授权" };
}

export function requireFeature(key: string, opts?: { fresh?: boolean }): { ok: true } | { ok: false; status: number; body: any } {
  const r = hasFeature(key, opts);
  if (r.ok) return { ok: true };
  return { ok: false, status: 402, body: { error: "LICENSE_REQUIRED", feature: key, reason: r.reason, license: licenseStatus().state } };
}
