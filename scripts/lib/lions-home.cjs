#!/usr/bin/env node
/**
 * lions-home.cjs — LIONS 安装根解析的**唯一事实来源**（产品化 S0-1，2026-10-15）
 * ==================================================================================
 *
 * 为什么要有它（可交付性第 1 块地基）:
 *   平台过去的运行路径写死了本机绝对路径 `~/lions`（tracked 文件里 1500+ 文件命中），
 *   于是"陌生人装不上、装到别的目录就跑不起来"。产品化第一件事就是把"安装根"变成一个可解析的变量。
 *
 * 解析优先级（高 -> 低）:
 *   1) 显式 options.home
 *   2) 环境变量 LIONS_HOME
 *   3) options.fallback（调用方给的已知根）
 *   4) **本脚本所在仓库根**（scripts/lib/../../）—— 对任何安装根都成立，等价于旧默认 ~/lions
 *   5) LEGACY_DEFAULT_HOME 兜底
 *
 * 兼容原则（重要）:
 *   不设任何变量时，解析结果与平台现状完全一致（线上实例 ~/lions），行为零变化。
 *   新布局（releases/ + data/ + install.json）与旧布局（库在 packages/apps/<app>/prisma/dev.db）并存，
 *   由 isLegacyLayout()/resolveDbPath() 判定，绝不猜测、绝不迁移。
 *
 * 用法:
 *   const H = require("./lib/lions-home.cjs");
 *   H.resolveHome(); H.dataDir(home); H.resolveDbPath(home, "mind");
 *   node scripts/lib/lions-home.cjs show [--home=DIR] [--json]
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** 本脚本所在仓库根（任何安装根下都成立） */
const SELF_HOME = path.resolve(__dirname, "..", "..");
/** 历史默认安装根（向后兼容用；不要在新代码里再写这个字面量） */
const LEGACY_DEFAULT_HOME = "~/lions";

function nonEmpty(v) {
  return typeof v === "string" && v.trim() !== "";
}

/** 解析安装根。见文件头注释。 */
function resolveHome(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  if (nonEmpty(opts.home)) return path.resolve(opts.home);
  if (nonEmpty(env.LIONS_HOME)) return path.resolve(env.LIONS_HOME);
  if (nonEmpty(opts.fallback)) return path.resolve(opts.fallback);
  // 仓库根自识别（比硬编码更稳，且对副本/新装根同样正确）
  if (fs.existsSync(path.join(SELF_HOME, "packages", "apps"))) return SELF_HOME;
  return path.resolve(LEGACY_DEFAULT_HOME);
}

function releasesDir(home) { return path.join(home, "releases"); }
function currentLink(home) { return path.join(home, "current"); }
function dataDir(home) { return path.join(home, "data"); }
function appDataDir(home, app) { return path.join(home, "data", app); }
function configDir(home) { return path.join(home, "config"); }
function logsDir(home) { return path.join(home, "logs"); }
function runDir(home) { return path.join(home, "run"); }
function backupsDir(home) { return path.join(home, "backups"); }
function installRecordPath(home) { return path.join(home, "install.json"); }
function channelPath(home) { return path.join(home, "channel.json"); }
function legacyDbPath(home, app) { return path.join(home, "packages", "apps", app, "prisma", "dev.db"); }

function readInstallRecord(home) {
  const p = installRecordPath(home);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_e) { return { _unparsable: true }; }
}

/** 是否旧布局：没有安装记录且旧位置存在活库。 */
function isLegacyLayout(home) {
  if (fs.existsSync(installRecordPath(home))) return false;
  return fs.existsSync(legacyDbPath(home, "mind"));
}

/** 解析某 app 的库路径（新布局优先于旧布局仅当有安装记录）。 */
function resolveDbPath(home, app) {
  const rec = readInstallRecord(home);
  if (rec && !rec._unparsable) return path.join(appDataDir(home, app), "dev.db");
  const legacy = legacyDbPath(home, app);
  if (fs.existsSync(legacy)) return legacy;
  return path.join(appDataDir(home, app), "dev.db");
}

/** 一次给出全部路径 + 布局判定，供 doctor / 安装器 / 升级器复用。 */
function describe(home, apps) {
  const appList = apps || ["mind", "session", "selfimproving"];
  const dbs = {};
  for (const a of appList) dbs[a] = resolveDbPath(home, a);
  return {
    home: home,
    selfHome: SELF_HOME,
    legacyDefaultHome: LEGACY_DEFAULT_HOME,
    layout: isLegacyLayout(home) ? "legacy" : "managed",
    dirs: {
      releases: releasesDir(home),
      current: currentLink(home),
      data: dataDir(home),
      config: configDir(home),
      logs: logsDir(home),
      run: runDir(home),
      backups: backupsDir(home),
    },
    installRecord: installRecordPath(home),
    channel: channelPath(home),
    databases: dbs,
  };
}

function parseArgv(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([A-Za-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  const cmd = args._[0] || "show";
  if (cmd !== "show") {
    console.error("用法: node scripts/lib/lions-home.cjs show [--home=DIR] [--json]");
    process.exit(3);
  }
  const home = resolveHome({ home: typeof args.home === "string" ? args.home : undefined });
  const d = describe(home);
  if (args.json) {
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
    return;
  }
  const L = [];
  L.push("LIONS 安装根解析 — lions-home.cjs");
  L.push("  安装根 : " + d.home);
  L.push("  布局   : " + d.layout + (d.layout === "legacy" ? "（库在 packages/apps/*/prisma/）" : "（库在 data/）"));
  L.push("  脚本根 : " + d.selfHome);
  L.push("");
  for (const [k, v] of Object.entries(d.dirs)) L.push("  " + k.padEnd(9) + ": " + v);
  L.push("");
  for (const [k, v] of Object.entries(d.databases)) L.push("  库 " + k.padEnd(14) + ": " + v);
  process.stdout.write(L.join("\n") + "\n");
}

module.exports = {
  SELF_HOME,
  LEGACY_DEFAULT_HOME,
  resolveHome,
  releasesDir,
  currentLink,
  dataDir,
  appDataDir,
  configDir,
  logsDir,
  runDir,
  backupsDir,
  installRecordPath,
  channelPath,
  legacyDbPath,
  readInstallRecord,
  isLegacyLayout,
  resolveDbPath,
  describe,
};

if (require.main === module) main();
