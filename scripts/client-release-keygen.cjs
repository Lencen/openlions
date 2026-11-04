#!/usr/bin/env node
/**
 * client-release-keygen.cjs — 客户端发布签名密钥初始化 / 轮换（R3，2026-10-29）
 * 2026-11-04 修正：与 client-release-signing.ts 使用**同一把钥匙/同一套 key id**。
 *
 * 存储：
 *   $LIONS_HOME/config/signing/lions-client-signing.pem        0600  PKCS8 Ed25519
 *   $LIONS_HOME/config/signing/lions-client-signing.pub        0644  raw 32B
 *   $LIONS_HOME/config/signing/lions-client-signing.fingerprint 0644  sha256(raw32) 全量
 *   $LIONS_HOME/config/signing/keys/<keyId>.pub                0644  轮换后旧公钥（验历史包）
 *
 * key_id = sha256(raw 32 字节公钥) 前 16 位 hex（与 client-release-signing.ts 一致）。
 * 私钥只在服务进程可读；本脚本只打印 key_id 与指纹，绝不打印私钥。
 *
 * 用法：
 *   node scripts/client-release-keygen.cjs                 # 生成（已存在则拒绝，避免误轮换）
 *   node scripts/client-release-keygen.cjs --rotate        # 轮换：旧公钥存 keys/<old>.pub
 *   node scripts/client-release-keygen.cjs --list          # 列出当前 key_id/指纹
 *   node scripts/client-release-keygen.cjs --selftest
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const HOME = process.env.LIONS_HOME || ROOT;
const DIR = path.join(HOME, "config", "signing");
const PEM = path.join(DIR, "lions-client-signing.pem");
const PUB = path.join(DIR, "lions-client-signing.pub");
const FP = path.join(DIR, "lions-client-signing.fingerprint");

function raw32(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32);
}
function idOf(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
function readCurrent() {
  if (!fs.existsSync(PEM)) return null;
  try {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(PEM, "utf8"));
    const publicKey = crypto.createPublicKey(privateKey);
    const raw = raw32(publicKey);
    return { keyId: idOf(raw), fingerprint: crypto.createHash("sha256").update(raw).digest("hex") };
  } catch { return null; }
}
function generate(rotate) {
  const cur = readCurrent();
  if (cur && !rotate) {
    console.log("签名密钥已存在，拒绝覆盖（避免误轮换）：key_id=" + cur.keyId);
    console.log("如需轮换：node scripts/client-release-keygen.cjs --rotate");
    return 1;
  }
  if (cur && rotate) {
    const oldPub = path.join(DIR, "keys", cur.keyId + ".pub");
    fs.mkdirSync(path.dirname(oldPub), { recursive: true, mode: 0o700 });
    if (fs.existsSync(PUB)) fs.copyFileSync(PUB, oldPub);
    console.log("旧公钥已保留：" + oldPub + "（历史包仍可验签）");
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = raw32(publicKey);
  const fp = crypto.createHash("sha256").update(raw).digest("hex");
  const id = fp.slice(0, 16);
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PEM, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(PUB, raw, { mode: 0o644 });
  fs.writeFileSync(FP, fp + "\n", { mode: 0o644 });
  console.log("已生成签名密钥");
  console.log("  key_id     = " + id);
  console.log("  private    = " + PEM + "  (0600)");
  console.log("  public     = " + PUB + "   (raw 32B)");
  console.log("  fingerprint= " + fp);
  console.log("注意：私钥内容不会、也不应被打印或导出；LIONS_SIGNING_KEY_PATH 指向 private 文件。");
  return 0;
}
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    let bad = 0;
    const t = (n, c) => { console.log((c ? "PASS" : "FAIL") + "  " + n); if (!c) bad++; };
    t("raw32 长度 32", raw32(crypto.generateKeyPairSync("ed25519").publicKey).length === 32);
    t("keyId 16 hex", /^[0-9a-f]{16}$/.test(idOf(Buffer.alloc(32, 1))));
    t("当前 key 可读或不存在", readCurrent() !== undefined);
    console.log(bad === 0 ? "SELFTEST OK (3 断言)" : "SELFTEST FAILED");
    return bad === 0 ? 0 : 1;
  }
  if (argv.includes("--list")) {
    const cur = readCurrent();
    if (!cur) { console.log("(尚无密钥；运行不带参数生成)"); return 0; }
    console.log("key_id=" + cur.keyId + "  fingerprint=" + cur.fingerprint);
    return 0;
  }
  return generate(argv.includes("--rotate"));
}
process.exit(main());
