#!/usr/bin/env node
/**
 * scan-open-source-sensitive.cjs — 开源前敏感扫描（密钥/密码/SSH/用户名/IP/邮箱/绝对路径）。
 * 输出**脱敏**（不打印原值）；secret/credential 为硬阻断，pii 为需脱敏。
 * 用法：node scripts/scan-open-source-sensitive.cjs [--root=DIR] [--json] [--selftest]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const RULES = [
  { cat: "secret", id: "private-key", re: /-----BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY-----/g },
  { cat: "secret", id: "aws-ak", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { cat: "secret", id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { cat: "secret", id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // sk-LABEL-ALLOW: 守门 id / 文档标签（sk-generalization / sk-decomp / sk-vs- / sk-bootst 等）不是密钥
  { cat: "secret", id: "sk-key", re: /\bsk-(?!generalization|decomp|vs-|bootst|success|v3|resolved|granularity)[A-Za-z0-9_-]{24,}\b/g },
  { cat: "secret", id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { cat: "credential", id: "ssh-pub", re: /\bssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/=]{20,}/g },
  { cat: "credential", id: "db-url-pass", re: /(?:mysql|postgres|postgresql|mongodb):\/\/[^\s:@]+:(?!\$\{?|\*\*\*|<|占位)[^\s@]+@/g },
  // 2026-11-04: 变量名/配置键不是密钥。排除 process.env / cred.* / decodeURIComponent / fs.readFileSync / String(...)
  //   这类"从环境或已有凭据取值"的赋值；真正的字面量密码仍会被抓到。
  { cat: "credential", id: "password-assign", re: /\b(?:password|passwd|pwd)\s*[:=]\s*["\x27]?(?!<|占位|placeholder|xxx|\*\*\*|process\.|cred\.|decodeURIComponent|fs\.readFileSync|String\()[^\s"\x27]{6,}/gi },
  { cat: "credential", id: "key-assign", re: /\b(?:api[_-]?key|secret|token)\s*[:=]\s*["\x27]?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/gi },
  { cat: "pii", id: "home-path", re: /\/home\/[A-Za-z0-9._-]+/g },
  { cat: "pii", id: "users-path", re: /\/Users\/[A-Za-z0-9._-]+/g },
  { cat: "pii", id: "private-ip", re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g },
  { cat: "pii", id: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { cat: "pii", id: "username", re: /\b(?:lencen|[operator]|operator|agent-x-E500|[host])\b/gi },
];
const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|db|db-wal|db-shm|woff2?|ttf|otf|mp4|webm)$/i;
function mask(v) { const s = String(v); return s.slice(0, 3) + "***(" + s.length + ")"; }
function walk(dir, base, out) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
  for (const e of ents) {
    if (e.name === ".git" || e.name === "node_modules" || /^\.next/.test(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = base ? base + "/" + e.name : e.name;
    if (e.isDirectory()) walk(abs, rel, out); else out.push(rel);
  }
}
function files(root) {
  try { const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); if (out) return out.split("\u0000").filter(Boolean); } catch (_e) {}
  const out = []; walk(root, "", out); return out;
}
function scan(root, prefixes) {
  const hits = []; let list = files(root);
  if (prefixes && prefixes.length) list = list.filter((r) => prefixes.some((p) => r === p || r.startsWith(p.replace(/\/$/, "") + "/")));
  for (const rel of list) {
    if (SKIP_EXT.test(rel)) continue;
    // 扫描器自身含 selftest 的假密钥/私钥样例，不能把自身当泄露。
    if (rel === "scripts/scan-open-source-sensitive.cjs") continue;
    const abs = path.join(root, rel);
    let st; try { st = fs.statSync(abs); } catch (_e) { continue; }
    if (st.size > 2 * 1024 * 1024) continue;
    let text; try { text = fs.readFileSync(abs, "utf8"); } catch (_e) { continue; }
    if (text.indexOf("\u0000") >= 0) continue;
    for (const r of RULES) {
      r.re.lastIndex = 0; let m;
      while ((m = r.re.exec(text)) !== null) {
        // 版权署名/公开贡献者是公开信息（2026-11-04 人类确认 Lencen），不是内部操作员泄露。
        //   只放行首字母大写的公开署名；小写 lencen 仍按内部操作员 id 拦截。
        if (r.id === "username" && (rel === "NOTICE" || rel === "LICENSE")) continue;
        if (r.id === "username" && m[0] === "Lencen") continue;
        if (r.id === "email" && /^iamlencen@qq\.com$/i.test(m[0])) continue;
        hits.push({ cat: r.cat, id: r.id, file: rel, value: mask(m[0]) });
        if (hits.length > 5000) return hits;
      }
    }
  }
  return hits;
}
function summarize(hits) {
  const byCat = {}; const byId = {}; const byFile = {};
  for (const h of hits) { byCat[h.cat] = (byCat[h.cat] || 0) + 1; byId[h.id] = (byId[h.id] || 0) + 1; byFile[h.file] = (byFile[h.file] || 0) + 1; }
  const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15);
  return { total: hits.length, byCat, byId, topFiles: top };
}
function selftest() {
  let bad = 0; const t = (n, c, d) => { console.log((c ? "PASS" : "FAIL") + "  " + n + (d ? " :: " + d : "")); if (!c) bad++; };
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "scan-os-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, "a.txt"), "-----BEGIN RSA PRIVATE KEY-----\nAKIAABCDEFGHIJKLMNOP\n/home/alice/x\n192.168.1.5\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "sk-mind-abcdefghijklmnopqrstuvwx\n");
  const saved = process.cwd;
  const r = scan(dir);
  t("检出私钥/AK/路径/IP", r.some((h) => h.id === "private-key") && r.some((h) => h.id === "aws-ak") && r.some((h) => h.id === "home-path") && r.some((h) => h.id === "private-ip"), JSON.stringify(summarize(r)));
  t("检出高熵 sk-", r.some((h) => h.id === "sk-key"));
  t("输出脱敏", r.every((h) => h.value.indexOf("***") >= 0));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad === 0 ? "SELFTEST OK (3 断言)" : "SELFTEST FAILED (" + bad + ")");
  process.exit(bad === 0 ? 0 : 1);
}
function main() {
  const a = process.argv.slice(2);
  if (a.includes("--selftest")) return selftest();
  const rootArg = a.find((x) => x.indexOf("--root=") === 0);
  const root = rootArg ? path.resolve(rootArg.slice(7)) : ROOT;
  const pathsArg = a.find((x) => x.indexOf("--paths=") === 0);
  const prefixes = pathsArg ? pathsArg.slice(8).split(/[\s,]+/).filter(Boolean) : null;
  const hits = scan(root, prefixes); const s = summarize(hits);
  if (a.includes("--json")) process.stdout.write(JSON.stringify(s, null, 2) + "\n");
  else {
    console.log("== 敏感扫描（脱敏）==");
    for (const [k, v] of Object.entries(s.byCat)) console.log(k + ": " + v);
    console.log("明细: " + JSON.stringify(s.byId));
    console.log("Top 文件:");
    for (const [f, n] of s.topFiles) console.log("  " + n + "  " + f);
  }
  const hard = (s.byCat.secret || 0) + (s.byCat.credential || 0);
  process.exit(hard > 0 ? 1 : 0);
}
main();
