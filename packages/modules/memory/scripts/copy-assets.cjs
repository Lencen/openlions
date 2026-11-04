#!/usr/bin/env node
/**
 * copy-assets.cjs — 把 tsc 不会产出的非 TS 资产复制进 dist（产品化 S0-1，2026-10-15）
 * =====================================================================================
 * 为什么: `@lions/modules-memory/src/index.ts` 用 require("./lib/product-format-rules.cjs")，
 *   而 tsc **不复制 .cjs/.json 等非 TS 文件** -> 全新构建出的 dist/lib/ 缺该文件，
 *   app 构建时报 `Can't resolve './lib/product-format-rules.cjs'`（实测：console/mind 都因此失败）。
 *   本脚本在 `tsc` 之后把 src/lib/*.cjs 复制到 dist/lib/，使"从零构建"成立。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src", "lib");
const distDir = path.join(root, "dist", "lib");
if (!fs.existsSync(srcDir)) { console.log("[copy-assets] 无 src/lib，跳过"); process.exit(0); }
fs.mkdirSync(distDir, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(srcDir)) {
  if (!/\.(cjs|json|sql)$/.test(f)) continue;
  fs.copyFileSync(path.join(srcDir, f), path.join(distDir, f));
  n++;
}
console.log("[copy-assets] 复制 " + n + " 个非 TS 资产 -> dist/lib");
