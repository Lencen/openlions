/**
 * client-release-signing.ts — 发布签名（R3，2026-10-29；2026-10-30 对齐密钥约定）
 *
 * 密钥约定（由负责人确定，**不要硬编码**）：
 *   - 私钥路径：`LIONS_SIGNING_KEY_PATH`，缺省 `~/.config/macs/signing/lions-client-signing.pem`（0600，PKCS8 Ed25519）
 *   - 公钥：同目录 `*.pub`（raw 32 字节）
 *   - **key_id = sha256(raw 32 字节公钥) 前 16 位 hex**（与负责人给定值一致，已复算核对）
 *   - 指纹文件：同目录 `*.fingerprint`（完整 sha256），读取而不是硬编码
 *
 * 四条硬要求（设计 §3）：
 *   1. 私钥只在服务进程可读（0600）；不入库/不进仓库/不进构建机；
 *   2. 不导出、不打印 —— 本模块没有"取私钥"的对外能力，只提供 sign/verify；
 *   3. 每次签名写审计（who/when/release_id/key_id）；
 *   4. 轮换：`LIONS_SIGNING_KEY_PATH` 指向新私钥即可；旧公钥要留着才能验历史包。
 *
 * 红线：**对最终字节签名**（调用方先重算 sha256 比对，再签同一份 Buffer）。
 */
import { createHash, sign as cryptoSign, verify as cryptoVerify, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_KEY = join(homedir(), ".config", "macs", "signing", "lions-client-signing.pem");

export function signingKeyPath(): string {
  return process.env.LIONS_SIGNING_KEY_PATH || DEFAULT_KEY;
}

/** Ed25519 公钥的 raw 32 字节（SPKI DER 尾部 32 字节） */
function rawPublicKey(pub: KeyObject): Buffer {
  const der = pub.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32);
}

/** key_id = sha256(raw 32 字节公钥) 前 16 位 hex（负责人约定，已复算核对） */
export function keyIdOf(pub: KeyObject): string {
  return createHash("sha256").update(rawPublicKey(pub)).digest("hex").slice(0, 16);
}

/** 完整指纹：sha256(raw 32 字节公钥) 全量 hex；优先读同目录 `.fingerprint` 文件 */
export function fingerprintOf(pub: KeyObject): string {
  const computed = createHash("sha256").update(rawPublicKey(pub)).digest("hex");
  try {
    const f = join(dirname(signingKeyPath()), basenameNoExt(signingKeyPath()) + ".fingerprint");
    if (existsSync(f)) {
      const declared = readFileSync(f, "utf8").trim();
      // 文件与私钥不匹配时以**计算值**为准（避免拿错指纹去对外声明）
      if (declared && declared !== computed) {
        console.warn("[client-release-signing] WARN .fingerprint 与私钥不一致，以计算值为准");
      }
    }
  } catch { /* 读不到指纹文件不阻塞签名 */ }
  return computed;
}

function basenameNoExt(p: string): string {
  const b = p.split("/").pop() || "key";
  return b.replace(/\.(pem|key)$/i, "");
}

export interface SigningKey {
  keyId: string;
  fingerprint: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** 读取签名密钥。**调用方不得外泄返回值**（无任何路由暴露私钥）。 */
export function loadSigningKey(): SigningKey | null {
  const p = signingKeyPath();
  if (!existsSync(p)) return null;
  try {
    const privateKey = createPrivateKey(readFileSync(p, "utf8"));
    const publicKey = createPublicKey(privateKey);
    return { keyId: keyIdOf(publicKey), fingerprint: fingerprintOf(publicKey), privateKey, publicKey };
  } catch {
    return null;
  }
}

/** 按 key id 取公钥（验历史包用）。从当前密钥推导；轮换后如需验旧包，把旧公钥放 `<keyId>.pub` 于同目录。 */
export function loadPublicKeyById(keyId: string): KeyObject | null {
  if (!/^[0-9a-f]{16}$/i.test(String(keyId || ""))) return null; // 防路径穿越
  const dir = dirname(signingKeyPath());
  const candidate = join(dir, "keys", keyId + ".pub");
  try {
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate);
      // raw 32B → SPKI DER（Ed25519 前缀 302a300506032b6570032100）
      const prefix = Buffer.from("302a300506032b6570032100", "hex");
      return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
    }
  } catch { /* 落回当前密钥 */ }
  const cur = loadSigningKey();
  if (cur && cur.keyId === keyId) return cur.publicKey;
  return null;
}

/** 对**最终字节**签名（detached, base64）。 */
export function signBytes(buf: Buffer): { signature: string; keyId: string; fingerprint: string; signedAt: string } | { error: string } {
  const key = loadSigningKey();
  if (!key) return { error: "SIGNING_KEY_NOT_CONFIGURED" };
  const sig = cryptoSign(null, buf, key.privateKey); // Ed25519 → algorithm null
  return { signature: sig.toString("base64"), keyId: key.keyId, fingerprint: key.fingerprint, signedAt: new Date().toISOString() };
}

export function verifyBytes(buf: Buffer, signatureB64: string, keyId: string): { valid: boolean; reason?: string } {
  const pub = loadPublicKeyById(keyId);
  if (!pub) return { valid: false, reason: "UNKNOWN_KEY_ID" };
  try {
    const ok = cryptoVerify(null, buf, pub, Buffer.from(String(signatureB64 || ""), "base64"));
    return ok ? { valid: true } : { valid: false, reason: "SIGNATURE_MISMATCH" };
  } catch (e: any) {
    return { valid: false, reason: "VERIFY_ERROR: " + String((e && e.message) || e).slice(0, 80) };
  }
}
