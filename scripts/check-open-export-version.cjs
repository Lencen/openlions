#!/usr/bin/env node
/**
 * check-open-export-version.cjs — 开源导出物的版本一致性门禁。
 * 用法: node scripts/check-open-export-version.cjs --root=/path/to/export [--source=/path/to/main]
 *
 * 检查:
 *  a) export/VERSION == source/VERSION
 *  b) export/package.json version == VERSION
 *  c) export/CHANGELOG.md 首段标题为 VERSION-open.N
 *  d) export/README.md 安装示例中的 lions-<x.y.z>.tar.gz 一律等于 VERSION
 */
"use strict";
const fs = require("fs");
const path = require("path");

const arg = (name) => {
  const p = process.argv.find((x) => x.startsWith("--" + name + "="));
  return p ? p.slice(name.length + 3) : "";
};
const root = path.resolve(arg("root") || process.cwd());
const source = path.resolve(arg("source") || path.resolve(__dirname, ".."));
const failures = [];
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const sourceVersion = fs.readFileSync(path.join(source, "VERSION"), "utf8").trim();
const exportVersion = read("VERSION").trim();
if (exportVersion !== sourceVersion) failures.push("a) VERSION: export=" + exportVersion + " source=" + sourceVersion);

const pkg = JSON.parse(read("package.json"));
if (String(pkg.version) !== exportVersion) failures.push("b) package.json version=" + pkg.version + " VERSION=" + exportVersion);

const changelog = read("CHANGELOG.md");
const firstHeading = (changelog.match(/^##\s+([^\s]+)/m) || [])[1] || "";
if (!new RegExp("^" + exportVersion.replace(/[.*+?^\$\{\}()|[\]\\]/g, "\\$&") + "-open\\.\\d+$").test(firstHeading)) {
  failures.push("c) CHANGELOG first heading=" + JSON.stringify(firstHeading) + " expected " + exportVersion + "-open.N");
}

const readme = read("README.md");
const tarballs = [...readme.matchAll(/lions-(\d+\.\d+\.\d+)\.tar\.gz/g)].map((m) => m[1]);
if (tarballs.length === 0) failures.push("d) README has no lions-<version>.tar.gz install example");
for (const v of tarballs) if (v !== exportVersion) failures.push("d) README tar.gz=" + v + " expected " + exportVersion);

if (failures.length) {
  console.error("OPEN-EXPORT-VERSION FAIL");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}
console.log("OPEN-EXPORT-VERSION OK: " + exportVersion + " (" + tarballs.length + " README install example)");
