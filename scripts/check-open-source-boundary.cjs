#!/usr/bin/env node
/**
 * check-open-source-boundary.cjs — 开源边界守门（人类 2026-10-16 定：方案 B）
 * 机检：① 每个包都被分类且仅一类；② 开源包不得依赖闭源包。
 * 用法： node scripts/check-open-source-boundary.cjs [--check|--selftest]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "scripts", "open-source-boundary.json");

function readManifest() { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
function pkgDirs() {
  const out = [];
  const scan = (base) => { if (!fs.existsSync(base)) return; for (const name of fs.readdirSync(base)) { const p = path.join(base, name); if (fs.existsSync(path.join(p, "package.json"))) out.push(path.relative(ROOT, p)); } };
  scan(path.join(ROOT, "packages", "apps")); scan(path.join(ROOT, "packages", "modules")); scan(path.join(ROOT, "packages", "core"));
  for (const p of ["packages/configs", "packages/ui"]) if (fs.existsSync(path.join(ROOT, p, "package.json"))) out.push(p);
  return out;
}
function internalDeps(dir) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
  const d = Object.assign({}, j.dependencies, j.devDependencies);
  return Object.keys(d).filter((k) => k.startsWith("@lions/"));
}
function nameToDir() { const m = {}; for (const d of pkgDirs()) { try { const j = JSON.parse(fs.readFileSync(path.join(ROOT, d, "package.json"), "utf8")); if (j.name) m[j.name] = d; } catch (_e) {} } return m; }

function check() {
  const man = readManifest(); const errs = [];
  const open = new Set(man.open), closed = new Set(man.closed);
  const dirs = pkgDirs();
  for (const d of dirs) { const inOpen = open.has(d), inClosed = closed.has(d); if (inOpen && inClosed) errs.push("同时列为开/闭源: " + d); if (!inOpen && !inClosed) errs.push("未分类的包: " + d); }
  const n2d = nameToDir();
  for (const d of dirs) { if (!open.has(d)) continue; for (const dep of internalDeps(d)) { const target = n2d[dep]; if (target && closed.has(target)) errs.push("开源包依赖闭源包: " + d + " -> " + target + " (" + dep + ")"); } }
  return errs;
}

if (process.argv.slice(2).includes("--selftest")) {
  let bad = 0; const t = (n, c) => { console.log((c ? "PASS" : "FAIL") + "  " + n); if (!c) bad++; };
  const man = readManifest();
  t("清单含 open/closed 两类", Array.isArray(man.open) && Array.isArray(man.closed) && man.open.length > 0 && man.closed.length > 0);
  t("macs 为闭源", man.closed.indexOf("packages/apps/mcp-agent-chat-server") >= 0);
  t("console 为开源", man.open.indexOf("packages/apps/console") >= 0);
  t("当前仓库就绪(0 错)", check().length === 0, check().join(" | ").slice(0, 200));
  console.log(bad === 0 ? "SELFTEST OK (4 断言)" : "SELFTEST FAILED");
  process.exit(bad === 0 ? 0 : 1);
}
const errs = check();
if (errs.length) { console.error("OPEN-SOURCE-BOUNDARY FAIL:\n - " + errs.join("\n - ")); process.exit(1); }
console.log("OPEN-SOURCE-BOUNDARY OK: " + readManifest().open.length + " 开源 / " + readManifest().closed.length + " 闭源，无跨边界依赖");
