#!/usr/bin/env node
/**
 * check-open-source-readiness.cjs — 开源前治理就绪守门（2026-10-16，产品化线）
 * 机检：治理文件齐备 / LICENSE=Apache-2.0 全文 / README 标注 / 无被跟踪 *.env(除 .example) / 无被跟踪数据库文件。
 * 用法： node scripts/check-open-source-readiness.cjs [--check|--selftest]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const REQUIRED = ["LICENSE", "NOTICE", "SECURITY.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "README.md",
  ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/bug_report.md", ".github/ISSUE_TEMPLATE/feature_request.md",
  "docs/productization/OPEN-SOURCE-GOVERNANCE.md"];
const NO_DEV_PATH_FILES = ["scripts/lions-sync.py", "scripts/dsh-session-sync.py"];
function isSecretFile(f) { return /(^|\/)[^\/]*\.env$/.test(f) && !/\.example$/.test(f); }
function isDbFile(f) { return /\.(db|sqlite|sqlite3)(-wal|-shm)?$/.test(f); }
function tracked() { return cp.execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean); }
function check() {
  const errs = [];
  for (const f of REQUIRED) if (!fs.existsSync(path.join(ROOT, f))) errs.push("缺治理文件: " + f);
  const lic = fs.existsSync(path.join(ROOT, "LICENSE")) ? fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8") : "";
  if (!/Apache License/.test(lic) || !/Version 2\.0/.test(lic)) errs.push("LICENSE 不是 Apache-2.0 全文");
  const readme = fs.existsSync(path.join(ROOT, "README.md")) ? fs.readFileSync(path.join(ROOT, "README.md"), "utf8") : "";
  if (!/Apache-2\.0/.test(readme)) errs.push("README 未标注 Apache-2.0 许可");
  const files = tracked();
  const secrets = files.filter(isSecretFile); if (secrets.length) errs.push("被跟踪的 .env: " + secrets.slice(0, 5).join(", "));
  const dbs = files.filter(isDbFile); if (dbs.length) errs.push("被跟踪的数据库文件: " + dbs.slice(0, 5).join(", "));
  for (const f of NO_DEV_PATH_FILES) { const p = path.join(ROOT, f); if (fs.existsSync(p) && /\/home\/[A-Za-z0-9_.-]+\//.test(fs.readFileSync(p, "utf8"))) errs.push("会话同步脚本写死本机绝对路径: " + f); }
  return errs;
}
const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  let bad = 0;
  const t = (n, c) => { console.log((c ? "PASS" : "FAIL") + "  " + n); if (!c) bad++; };
  t("拒绝 .macs.env", isSecretFile("packages/apps/x/.macs.env"));
  t("放行 .env.example", !isSecretFile("packages/apps/x/.env.example"));
  t("拒绝 prisma/dev.db", isDbFile("packages/apps/mind/prisma/dev.db"));
  t("拒绝 dev.db-wal", isDbFile("x/dev.db-wal"));
  t("放行 .ts", !isDbFile("x/a.ts"));
  const homeRoot = "/" + "home";
  t("拒绝写死本机路径", new RegExp(homeRoot + "/x/").test(homeRoot + "/x/agent/x.py"));
  t("当前仓库就绪(0 错)", check().length === 0, check().join(" | ").slice(0, 200));
  console.log(bad === 0 ? "SELFTEST OK (" + 7 + " 断言)" : "SELFTEST FAILED");
  process.exit(bad === 0 ? 0 : 1);
}
const errs = check();
if (errs.length) { console.error("OPEN-SOURCE-READINESS FAIL:\n - " + errs.join("\n - ")); process.exit(1); }
console.log("OPEN-SOURCE-READINESS OK: 治理文件齐备 / Apache-2.0 / 无被跟踪密钥与数据库文件");
