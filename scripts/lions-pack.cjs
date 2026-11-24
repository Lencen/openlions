#!/usr/bin/env node
/**
 * lions-pack.cjs — 产出可交付发布产物 + 清单（产品化 S0-1）
 * =================================================================
 *
 * 做什么:
 *   从**干净 git 树**打包"运行产品所需的全部 tracked 文件"，生成:
 *     dist/lions-<version>.tar.gz
 *     dist/lions-<version>.manifest.json   (schema lions-release-package/1)
 *   tar 根目录里**同时**放一份 manifest.json（"包内清单"，随包走）：
 *     安装侧 lions-install 的 resolveGitInfo() 读的是 <releaseDir>/manifest.json（平名、release 树根），
 *     dist/ 那份进不了发行树 —— 2026-11-23 实测 /opt/lions/releases/0.6.6-pg 根下没有 manifest.json，
 *     于是门禁③「manifest.gitSha == HEAD」**没有对象可测**（不是判 FAIL，是判不了）。
 *     修法落在这里（让清单随包走），不是另写打包器、更不是在安装侧"读不到就编一个"。
 *
 * 为什么用 tracked 文件:
 *   业务数据(1.4G 账本 / 5.8G 会话库)、密钥(.env)、构建产物(.next*)、node_modules、日志、备份
 *   都不在 tracked 文件里 —— 于是"只打包 tracked"天然满足"产物不含数据与密钥"这条硬要求，
 *   比手写排除清单更可靠（清单会腐，git 索引是事实）。
 *
 * 用法:
 *   node scripts/lions-pack.cjs [--version=0.1.0] [--channel=stable] [--out=dist/] [--summary="..."] [--reproducible] [--json]
 *   node scripts/lions-pack.cjs --emit-manifest=<dir>   # 只给**已存在的发行目录**写包内 manifest.json（不打包；只写真实计算值）
 *   SOURCE_DATE_EPOCH=<sec> 也可固定 builtAt 与 tar mtime（可重复构建）
 *   node scripts/lions-pack.cjs --allow-dirty           # 明知有未跟踪文件仍 tracked-only 打包（产物会漏）
 *   node scripts/lions-pack.cjs --include-untracked     # 把未跟踪文件也纳入（本地自测）
 *
 * 默认 fail-closed：工作区若有**未跟踪的包内文件**，直接拒绝打包（它们会被 tracked-only 静默漏掉 ——
 *   2026-10-15 实测：console 需要的 `src/components/TableCopyButton.tsx` 未跟踪，导致产物构建失败）。
 *   node scripts/lions-pack.cjs --verify=dist/x.manifest.json --archive=dist/x.tar.gz
 *   node scripts/lions-pack.cjs --selftest
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SCHEMA = "lions-release-package/1";
// 包内清单（随包走的那一份）：文件名固定为 tar 根目录的 manifest.json ——
//   安装侧 lions-install.cjs 的 resolveGitInfo() 读 <releaseDir>/manifest.json（平名），改名它会读不到而回落 unavailable。
const IN_ARCHIVE_MANIFEST = "manifest.json";
const IN_ARCHIVE_SCHEMA = "lions-release-package-manifest/1";
const NODE_REQUIREMENT = ">=20";
const PNPM_REQUIREMENT = "9.15.9";

// 排除规则（在 tracked 基础上再排除"开发记录/镜像/证据/构建产物"）：
// 只打包运行产品所需内容，减小体积并去掉开发侧噪声。
const EXCLUDE_PREFIXES = [
  ".changeset/",
  "dist/",
  "tmp/",
  ".tmp/",
  "logs/",
  "backups/",
  "docs/skills-mirror/",
  "docs/worklog/",
  "docs/agent-e-verifies/",
  "docs/agent-d-verifies/",
  "docs/verification/",
  // 2026-11-02（devops 线，④"打不出包"）：运行态与开发进度目录不是产品内容。
  //   run/ 是 pid/lock/cursor/一次性探针；progress/ 是逐轮开发流水。
  //   它们会被"包内未跟踪文件"判据算进去（实测 39 条），但装到客户机器上毫无意义。
  "run/",
  "progress/",
  ".progress/",
  ".progress-2026-10-08/",
  // 2026-11-24 12:32 运营团队裁定（发布闸红 D19 P1）：两个可签包都带测试 harness 痕迹，走**路径级排除**，
  //   不做内容过滤 —— 内容过滤会让「包内字节 == HEAD 非排除区」永久 DIFF，而那条正是"不签"的判据之一。
  //   依据：这 7 个路径没有任何运行时消费者（macs-line-send.cjs 只在 hint 字符串里提到 harness 文件名，不是 require）。
  "etc/line-aliases.json",
  "docs/productization/HARNESS-LINE-2026-11-09.md",
  "docs/team/charters/macs-test-harness.md",
  "scripts/macs-harness-send.cjs",
  "scripts/check-harness-isolation.cjs",
  "scripts/check-no-test-harness-in-release.cjs",
  "scripts/fixtures/harness-target-allowlist.json",
];
// verification/ 整体排除，但保留升级要复用的静态冻结断言。
const VERIFICATION_KEEP = ["verification/round78-prerender-freeze/"];
// 任何 "*.env" / ".env*" 形态的文件都排除（`.env.example` 除外）——
//   2026-10-16 实测：仓库里有**被跟踪**的 `packages/apps/mcp-agent-chat-server/.macs.env` 与
//   `scripts/macs-client/agent-f/agent-f.env` 含非空密钥，且旧规则只认 `.env.` 前缀，导致它们进了发布包。
const ENV_LIKE_RE = /(^|\.)env(\.|$)/i;
// 根 CLIENT_VERSION 是**产物**（打包前由本脚本生成，值取 scripts/macs-responder/CLIENT_VERSION）。
// 2026-11-24 Lead 裁定："树是否干净"的唯一事实源是本文件的 dirtyState/dirtyReport，
//   判据一律 require 这里，不许自己 grep / 自己 git status 重写一份口径（口径复制 = 迟早分叉）。
const GENERATED = new Set(["CLIENT_VERSION"]);
const EXCLUDE_BASENAMES = [".env", ".env.local"];
const EXCLUDE_SUFFIXES = [".db", ".db-wal", ".db-shm", ".db-journal"];

function isExcluded(rel, closed) {
  // 开源发布（方案 B）：闭源包整目录剔除。
  if (closed && closed.some((prefix) => rel.startsWith(prefix))) return true;
  if (rel.startsWith("verification/")) {
    if (!VERIFICATION_KEEP.some((p) => rel.startsWith(p))) return true;
  }
  if (EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) return true;
  const base = rel.split("/").pop();
  if (EXCLUDE_BASENAMES.indexOf(base) >= 0) return true;
  if (ENV_LIKE_RE.test(base) && !base.endsWith(".example")) return true;
  if (EXCLUDE_SUFFIXES.some((s) => rel.endsWith(s))) return true;
  return false;
}

function sha256File(abs) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(abs));
  return h.digest("hex");
}

function listFiles(root, opts) {
  opts = opts || {};
  const args = ["ls-files", "-z"];
  if (opts.includeUntracked) args.splice(1, 0, "--cached", "--others", "--exclude-standard");
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("git ls-files 失败: " + (r.stderr || r.error));
  const all = r.stdout.split("\u0000").filter(Boolean);
  const kept = all.filter((f) => !isExcluded(f, opts.closed));
  return { all, kept, excluded: all.length - kept.length };
}

/** 从开源边界清单读闭源包前缀（方案 B）。 */
function openSourceClosedPrefixes(root) {
  const file = path.join(root, "scripts", "open-source-boundary.json");
  if (!fs.existsSync(file)) throw new Error("--open-source 需要 scripts/open-source-boundary.json（开源边界清单）");
  const man = JSON.parse(fs.readFileSync(file, "utf8"));
  return (man.closed || []).map((d) => d.replace(/\/?$/, "/"));
}

/**
 * 已跟踪但被修改的文件（2026-11-03，[team] 报 OI-16 后修）。
 * 原判据只看 untracked —— 一棵满是 " M" 的树也能打出 dirty=false 的"干净产物"，
 * 而打包读的是**工作树内容**，于是"清单说干净、内容却不是 HEAD"。
 * 与 OI-14（同号不同源码）叠加时最难查：产物自称干净、版本相同，内容却不同。
 */
function listTrackedDirty(root) {
  const r = spawnSync("git", ["status", "--porcelain", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  return r.stdout.split("\u0000").filter(Boolean)
    .filter((e) => !e.startsWith("?? "))
    .map((e) => e.slice(3).replace(/^"|"$/g, ""))
    .filter((f) => f && !isExcluded(f));
}

/** 未跟踪但属于包内的文件（会被 tracked-only 打包静默漏掉，必须 fail-closed）。 */
/**
 * 单路径的脏项三态（纯函数；自检与主流程共用，AGENTS 34②）：
 *   artifact = 打包生成的产物（根 CLIENT_VERSION），**不是脏项**
 *   excluded = 被 EXCLUDE_PREFIXES / 环境变量文件 / 库文件等口径排除
 *   dirty    = 真脏项（会让 pack fail-closed，也会让"树干净"判据变红）
 */
function dirtyState(rel) {
  if (GENERATED.has(rel)) return "artifact";
  if (isExcluded(rel)) return "excluded";
  return "dirty";
}

/**
 * 树脏报告（唯一事实源，2026-11-24 Lead 裁定）。
 * 为什么要有它：出包准入判据若自己 grep/git status 重写一遍口径，会出现两种坏结果 ——
 *   把产物当脏项 -> 永远红；把真脏项排除掉 -> 假绿放行。
 * 返回：trackedDirty（已跟踪但被改，包内）/ untracked（未跟踪但包内）/ excludedPrefixes / generated。
 */
function dirtyReport(root) {
  root = root || process.cwd();
  return {
    trackedDirty: listTrackedDirty(root),
    untracked: listUntracked(root),
    excludedPrefixes: EXCLUDE_PREFIXES.slice(),
    generated: Array.from(GENERATED)
  };
}

function listUntracked(root) {
  const r = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  // 2026-11-02（KR-3 固化）：根 CLIENT_VERSION 由本脚本在打包前**生成**，是产物不是源码，
  //   不参与"未跟踪=漏提交"的 fail-closed 判定（判定统一走 dirtyState）。
  return r.stdout.split("\u0000").filter(Boolean).filter((f) => dirtyState(f) === "dirty").filter((f) => {
    try { return fs.lstatSync(path.join(root, f)).isFile(); } catch (_e) { return false; }
  });
}

function gitMeta(root) {
  const run = (args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  const sha = run(["rev-parse", "HEAD"]);
  const ct = run(["show", "-s", "--format=%ct", "HEAD"]);
  const iso = run(["show", "-s", "--format=%cI", "HEAD"]);
  return { gitSha: sha || "UNKNOWN", commitEpoch: Number(ct) || 0, commitIso: iso || "" };
}

function collectMigrations(root) {
  const out = {};
  for (const app of ["mind", "session", "selfimproving"]) {
    const dir = path.join(root, "packages", "apps", app, "prisma", "migrations");
    if (!fs.existsSync(dir)) { out[app] = []; continue; }
    out[app] = fs.readdirSync(dir).filter((n) => n !== "migration_lock.toml").sort();
  }
  return out;
}

function resolveVersion(root, explicit) {
  if (explicit) return explicit;
  const vf = path.join(root, "VERSION");
  if (fs.existsSync(vf)) return fs.readFileSync(vf, "utf8").trim();
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0"; } catch (_e) { return "0.0.0"; }
}

function epochOverride() { const v = process.env.SOURCE_DATE_EPOCH; return v && /^\d+$/.test(v) ? Number(v) : null; }
function buildStamp(meta, opts) { const o = epochOverride(); if (o != null) return new Date(o * 1000).toISOString(); if (opts && opts.reproducible) return meta.commitIso || new Date(Number(meta.commitEpoch) * 1000).toISOString(); return new Date().toISOString(); }
function packEpoch(meta, opts) { const o = epochOverride(); if (o != null) return o; return meta.commitEpoch; }

function tarCreate(root, files, outAbs, epoch, extras) {
  const listFile = path.join(os.tmpdir(), "lions-pack-files-" + process.pid + ".txt");
  fs.writeFileSync(listFile, files.join("\n") + "\n");
  const args = ["--sort=name", "--owner=0", "--group=0", "--numeric-owner"];
  if (epoch) args.push("--mtime=@" + epoch);
  args.push("-czf", outAbs, "-C", root, "-T", listFile);
  // 额外随包文件（包内 manifest.json：只存在于临时暂存目录，不在打包树里）。
  //   GNU tar 的 -C 是**累积**的（后一个 -C 相对于前一个解析），故 extras 的目录必须给绝对路径 ——
  //   2026-11-23 实测：给相对路径得到 "tar: stage: Cannot open: No such file or directory"。
  for (const ex of extras || []) args.push("-C", path.dirname(ex.abs), ex.name);
  try {
    const r = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error("tar 失败: " + (r.stderr || r.error));
  } finally {
    try { fs.unlinkSync(listFile); } catch (_e) {}
  }
}

/** gitSha 必须是完整 40 位 sha：包内清单要拿它当门禁③的被测对象，写 "UNKNOWN" 就是假证据。 */
function assertFullGitSha(sha, where) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ""))) {
    throw new Error(where + " 拒绝写清单：gitSha 必须是完整 40 位 sha（实得 " + JSON.stringify(sha) + "）。" +
      "\n  写 UNKNOWN 会让门禁③「manifest.gitSha == HEAD」拿到一个假对象（AGENTS 21 无证据断言）。" +
      "\n  请在有 HEAD 提交的 git 树里出包/写清单。");
  }
}

/** VERSION 首行（版本号；VERSION 允许带元数据次行，如 COMMERCIAL_VERSION=...）。 */
function versionFirstLine(root, fallback) {
  const vf = path.join(root, "VERSION");
  if (!fs.existsSync(vf)) return fallback;
  const line = fs.readFileSync(vf, "utf8").split(/\r?\n/)[0].trim();
  return line || fallback;
}

/**
 * 包内 manifest.json（tar 根目录那份，随包走到发行树）—— 门禁③「manifest.gitSha == HEAD」的被测对象。
 *
 * 为什么要有它（问题不是"lions-pack 不产 manifest"，而是"清单没随包走"）：
 *   外层 dist/lions-<v>.manifest.json 只存在于 dist/，tar 解到 /opt/lions/releases/<v> 后就没了；
 *   安装侧 resolveGitInfo() 读 <releaseDir>/manifest.json 读不到 -> source=unavailable -> 门禁无对象可测。
 *   故清单必须**同时**落进 tar 根目录。
 *
 * 自指问题（本文件里写清，别让后人以为少算了一个文件）：
 *   本清单**不把自己（manifest.json）算进 files**，理由两条：
 *     ① 循环依赖：要把自身的 sha256 写进自身，内容就跟着变，只能做不动点迭代 —— 成本高且是假精确；
 *     ② 口径歧义：算进去后，"清单 files 数 == 包内文件数" 这条判据就得永远减 1，两条线各写一版就漂移。
 *   后果要写明白：tar 的**文件条目数 = fileCount + 1**（多的那个就是 manifest.json）。
 *   同理也不写 archive.sha256/archive.bytes：tar 的 sha 只能在 tar 生成之后算，写进包内清单同样是循环；
 *   归档指纹由外层 dist 清单（原 schema，archive.sha256 不动）负责。
 */
function buildInArchiveManifest(ctx) {
  assertFullGitSha(ctx.gitSha, "包内 " + IN_ARCHIVE_MANIFEST);
  const files = (ctx.files || []).map((f) => ({ path: f.path, sha256: f.sha256 }));
  return {
    schema: IN_ARCHIVE_SCHEMA,
    version: ctx.version,
    channel: ctx.channel,
    edition: ctx.edition,
    gitSha: ctx.gitSha,
    // 与安装侧 resolveGitInfo() 的 mf.gitDirty === true 对齐（内容 != HEAD 时别装作干净）。
    gitDirty: ctx.gitDirty === true,
    builtAt: ctx.builtAt,
    source: ctx.source,
    fileCount: files.length,
    selfExcluded: {
      path: IN_ARCHIVE_MANIFEST,
      note: "清单不把自己算进 files：自身 sha256 无法写进自身（循环），且算进去会让「files 数 == 包内文件数」多一个口径减 1。",
      derived: "tar 文件条目数 = fileCount + 1；归档指纹见外层 dist/lions-<version>.manifest.json 的 archive.sha256。",
    },
    files,
  };
}

/**
 * 出包前基线闸门（2026-11-03，platform-data 的 check-build-base 同口径，接进打包本身）。
 * 为什么放在 lions-pack 里而不是只放在某个构建脚本里：
 *   0.4.10 的事故形态是"打的是 14:11 的树、修的是 14:25" —— 只要还有人手工跑 pack，就必须由 pack 自己拦。
 * 名单放 scripts/build-base-requires.txt（每行一个 sha，# 注释），追加修复不需要改代码。
 */
function checkBuildBase(root) {
  const listPath = path.join(root, "scripts/build-base-requires.txt");
  if (!fs.existsSync(listPath)) return;
  const reqs = fs.readFileSync(listPath, "utf8").split("\n").map((l) => l.split("#")[0].trim()).filter(Boolean);
  if (!reqs.length) return;
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const sha = (head.stdout || "").trim();
  if (!sha) throw new Error("build-base: 取不到 git HEAD（不是 git 树？）");
  const missing = reqs.filter((r) => {
    const r2 = spawnSync("git", ["merge-base", "--is-ancestor", r, sha], { cwd: root });
    return r2.status !== 0;
  });
  const schemaPath = path.join(root, "packages/apps/mind/prisma/schema.postgres.prisma");
  const schemaText = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf8") : "";
  const LEGACY = ["todo", "todoconsumer", "acceptanceverdict", "sessionextractionstate"];
  const legacy = LEGACY.filter((m) => new RegExp("^model\\s+" + m + "\\s*\\{", "m").test(schemaText));
  if (missing.length || legacy.length) {
    throw new Error("基线不合规，拒绝打包（scripts/build-base-requires.txt）：" +
      (missing.length ? "\n  基线 " + sha.slice(0, 9) + " 不含修复: " + missing.join(",") : "") +
      (legacy.length ? "\n  schema 仍含遗留 model: " + legacy.join(",") : "") +
      "\n换基线（把修复合进来）或从正确 sha 出包；确要带伤用 --allow-dirty");
  }
}

function build(opts) {
  const root = opts.root || ROOT;
  const outDir = path.resolve(root, opts.out || "dist");
  checkBuildBase(root);
  const closed = opts.openSource ? openSourceClosedPrefixes(root) : [];
  const untracked = listUntracked(root).filter((f) => !(opts.openSource && closed.some((prefix) => f.startsWith(prefix))));
  if (!opts.includeUntracked && !opts.allowDirty) {
    if (untracked.length) {
      throw new Error("工作区有 " + untracked.length + " 个未跟踪的包内文件，会被 tracked-only 打包漏掉（发布产物将不完整）：" +
        "\n  " + untracked.slice(0, 12).join("\n  ") + (untracked.length > 12 ? "\n  …" : "") +
        "\n请先提交这些文件；确要带伤打包用 --allow-dirty（仍漏）或 --include-untracked（纳入未跟踪）");
    }
  }
  // OI-16（2026-11-03，[team] 报）：已跟踪文件的修改也必须 fail-closed，
  //   否则 dirty=false 是假的 —— 产物会带上未提交改动，而清单不体现。
  const trackedDirty = listTrackedDirty(root);
  if (trackedDirty.length && !opts.allowDirty) {
    throw new Error("工作区有 " + trackedDirty.length + " 个已跟踪文件被修改（会进产物但不进清单）：" +
      "\n  " + trackedDirty.slice(0, 12).join("\n  ") + (trackedDirty.length > 12 ? "\n  …" : "") +
      "\n要么提交，要么用 --allow-dirty（产物会标 dirty:true）");
  }
  const meta = gitMeta(root);
  // 包内清单要写 gitSha；"写不出来就写 UNKNOWN" 等于给门禁③一个假对象，故这里就 fail-closed。
  assertFullGitSha(meta.gitSha, "出包");
  const version = resolveVersion(root, opts.version);
  // 2026-11-02（devops 线，实测）：版本闭环硬约束 —— 产物标签必须等于**树里 VERSION 的内容**。
  //   事故：在干净工作树里用 --version=0.4.1 打包，但 HEAD 的 VERSION 还是 0.1.0，
  //   于是清单写 0.4.1、安装却按树内 VERSION 装成 0.1.0（lions-install 读的是树内 VERSION）。
  //   "标签一个号、内容是另一个号"正是版本无法追溯的根源，必须 fail-closed。
  if (opts.version) {
    const vf = path.join(root, "VERSION");
    // 2026-11-09（0.4.42-01 商业版 v0.1.0）：VERSION 允许带元数据行（如 COMMERCIAL_VERSION=0.1.0），
    // 版本比较只认**首行**；否则“首行 0.1.0 + 次行 COMMERCIAL_VERSION=0.1.0”会被整串比较误拒。
    const _vtxt = fs.existsSync(vf) ? fs.readFileSync(vf, "utf8") : "";
    const treeVersion = _vtxt.split(/\r?\n/)[0].trim();
    if (treeVersion && treeVersion !== String(opts.version)) {
      throw new Error("版本不一致：--version=" + opts.version + " 但树内 VERSION=" + treeVersion +
        "。发布前必须先把 VERSION 改成要发布的版本并提交（否则装出来的版本号与清单不同）。");
    }
  }
  // 2026-11-02（devops 线，实测）：/api/version 会比对"平台版本(VERSION)"与"控制台包版本
  //   (packages/apps/console/package.json)"，不一致就报 consistent=false。
  //   打包时强制两者相等，避免"版本号说了两个"。
  try {
    const pkgPath = path.join(root, "packages", "apps", "console", "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkgVer = (JSON.parse(fs.readFileSync(pkgPath, "utf8")) || {}).version;
      if (pkgVer && pkgVer !== String(version)) {
        throw new Error("版本不一致：VERSION=" + version + " 但 packages/apps/console/package.json=" + pkgVer +
          "（/api/version 会报 consistent=false；发布前必须同步）");
      }
    }
  } catch (e) {
    if (/版本不一致/.test(String(e && e.message))) throw e;
  }
  const channel = opts.channel || "stable";
  const edition = opts.edition || (opts.openSource ? "open" : "sales");
  const { all, kept, excluded } = listFiles(root, Object.assign({}, opts, { closed }));
  // 只打包常规文件：符号链接/目录（如 backups 软链）不进产物（避免 EISDIR 与不确定语义）。
  const packable = kept.filter((rel) => {
    try { return fs.lstatSync(path.join(root, rel)).isFile(); } catch (_e) { return false; }
  });
  if (edition === "sales") {
    const closedPrefixes = openSourceClosedPrefixes(root);
    const missing = closedPrefixes.filter((p) => !packable.some((f) => f.startsWith(p)));
    if (missing.length) throw new Error("sales 版缺少闭源组件（许可隔离失败）: " + missing.join(", "));
  }
  // 2026-11-02 KR-3 固化：产物根必须带 CLIENT_VERSION —— 三环境 /client/version 走 source=disk 的根因就是它缺席。
  //   值取 scripts/macs-responder/CLIENT_VERSION（单一事实源），不手填、不猜。
  const clientVerFile = path.join(root, "CLIENT_VERSION");
  const clientVerSsot = path.join(root, "scripts", "macs-responder", "CLIENT_VERSION");
  if (fs.existsSync(clientVerSsot)) {
    const cv = fs.readFileSync(clientVerSsot, "utf8").trim();
    if (cv) {
      const cur = fs.existsSync(clientVerFile) ? fs.readFileSync(clientVerFile, "utf8").trim() : "";
      if (cur !== cv) fs.writeFileSync(clientVerFile, cv + "\n");
      if (!packable.includes("CLIENT_VERSION")) packable.push("CLIENT_VERSION");
    }
  }
  // 包内清单与包内同名文件会撞车（tar 里两份 manifest.json，安装侧读到哪份不确定）—— 提前拒绝。
  if (packable.indexOf(IN_ARCHIVE_MANIFEST) >= 0) {
    throw new Error("包内已有 " + IN_ARCHIVE_MANIFEST + "（与包内清单同名冲突）；请改名或把它从包里排除");
  }
  fs.mkdirSync(outDir, { recursive: true });
  const archiveName = "lions-" + version + ".tar.gz";
  const archiveAbs = path.join(outDir, archiveName);
  // 顺序很重要：包内清单要把 files[].sha256 写进去，所以 files 必须在 tar **之前**算好
  //   （旧实现是 tar 之后算；现在提前，值不变 —— 两者读的都是工作树里同一批文件）。
  const files = packable.map((rel) => {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    return { path: rel, sha256: sha256File(abs), bytes: st.size };
  });
  const dirty = !!(opts.includeUntracked || opts.allowDirty || untracked.length > 0 || trackedDirty.length > 0);
  const source = opts.includeUntracked ? "include-untracked" : (opts.allowDirty ? "allow-dirty" : "tracked");
  const builtAt = buildStamp(meta, opts);
  const inArchive = buildInArchiveManifest({
    version: versionFirstLine(root, version),
    channel,
    edition,
    gitSha: meta.gitSha,
    gitDirty: dirty,
    builtAt,
    source,
    files,
  });
  const inArchiveText = JSON.stringify(inArchive, null, 2) + "\n";
  const inArchiveSha = crypto.createHash("sha256").update(inArchiveText).digest("hex");
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "lions-pack-inmanifest-"));
  try {
    const stagedAbs = path.join(stageDir, IN_ARCHIVE_MANIFEST);
    fs.writeFileSync(stagedAbs, inArchiveText);
    // 包内清单随 tar 一起落盘（tar 根目录）：解包后就是 <releaseDir>/manifest.json。
    tarCreate(root, packable, archiveAbs, packEpoch(meta, opts), [{ abs: stagedAbs, name: IN_ARCHIVE_MANIFEST }]);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  const archiveBytes = fs.statSync(archiveAbs).size;
  // --sign：用 gpg 生成独立签名（.asc）。发布方可离线签名后随包分发。
  let signature = null;
  if (opts.sign) {
    const ascAbs = archiveAbs + ".asc";
    const sr = spawnSync("gpg", ["--batch", "--yes", "--armor", "--detach-sign", "--output", ascAbs, archiveAbs], { encoding: "utf8" });
    if (sr.status !== 0) throw new Error("gpg 签名失败: " + (sr.stderr || sr.error));
    signature = { name: archiveName + ".asc", sha256: sha256File(ascAbs) };
  }
  const manifest = {
    schema: SCHEMA,
    version,
    channel,
    edition,
    gitSha: meta.gitSha,
    commitTime: meta.commitIso,
    builtAt,
    node: NODE_REQUIREMENT,
    pnpm: PNPM_REQUIREMENT,
    summary: opts.summary || "",
    notes: opts.notes || "",
    // 外层清单原 schema / archive.sha256 **不动**（下游按 schema 解析）；只新增一个指向包内清单的定位块。
    archive: { name: archiveName, sha256: sha256File(archiveAbs), bytes: archiveBytes },
    inArchiveManifest: { name: IN_ARCHIVE_MANIFEST, schema: IN_ARCHIVE_SCHEMA, sha256: inArchiveSha, bytes: Buffer.byteLength(inArchiveText) },
    signature,
    // fileCount / files 只算源码与资产，**不含** manifest.json 自身（自指，见 buildInArchiveManifest 注释）。
    fileCount: files.length,
    totalBytes: files.reduce((a, f) => a + f.bytes, 0),
    excludedCount: excluded,
    openSource: !!opts.openSource,
    closedPackages: opts.openSource ? closed : null,
    dirty,
    source,
    untrackedCount: untracked.length,
    migrations: collectMigrations(root),
    files,
  };
  const manifestAbs = path.join(outDir, "lions-" + version + ".manifest.json");
  fs.writeFileSync(manifestAbs, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestAbs, archiveAbs, manifest, inArchiveManifest: inArchive, trackedTotal: all.length, outDir };
}

/**
 * --emit-manifest=<dir>：只给一个**已存在的发行目录**写包内 manifest.json，不打包。
 *
 * 为什么需要它：目录安装路径（lions-install --from=<dir>）没有 tar，包内清单也就没有来源；
 *   而安装侧又不许"读不到就编一个"（那会造出假证据）。故这里提供显式开关，且**只写真实计算值**：
 *     · gitSha：git rev-parse HEAD，必须 40 位（取不到就拒绝写，绝不写 UNKNOWN）
 *     · sha256：从 <dir> 里**实际读到的字节**算
 *     · 交叉校验：<dir> 里每个文件的内容必须与源树同一路径的文件逐字节一致（否则拒绝写清单，
 *       避免把"源树 HEAD"贴到一棵来源不明的树上）；缺文件同样拒绝（不写半份清单）。
 * 版本闭环：<dir>/VERSION 首行若存在，必须与源树 VERSION 首行一致。
 */
function emitManifest(opts) {
  const root = path.resolve(opts.root || ROOT);
  if (typeof opts.dir !== "string" || !opts.dir) throw new Error("--emit-manifest 需要目录参数：--emit-manifest=<发行目录>");
  const dir = path.resolve(opts.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("--emit-manifest 目标不是已存在的目录: " + dir);
  const meta = gitMeta(root);
  assertFullGitSha(meta.gitSha, "--emit-manifest");
  const version = versionFirstLine(root, resolveVersion(root, opts.version));
  const vf = path.join(dir, "VERSION");
  if (fs.existsSync(vf)) {
    const dirVersion = fs.readFileSync(vf, "utf8").split(/\r?\n/)[0].trim();
    if (dirVersion && dirVersion !== version) {
      throw new Error("版本不一致：源树 VERSION=" + version + " 但目标目录 VERSION=" + dirVersion +
        "（拒绝给对不上的树写清单）");
    }
  }
  const edition = opts.edition || (opts.openSource ? "open" : "sales");
  if (edition !== "open" && edition !== "sales") throw new Error("--edition 只能是 open|sales（收到 " + edition + "）");
  const sameTree = root === dir;
  const dirty = listTrackedDirty(root).length > 0 || listUntracked(root).length > 0;
  const closed = opts.openSource ? openSourceClosedPrefixes(root) : [];
  const { kept } = listFiles(root, Object.assign({}, opts, { closed }));
  const missing = [];
  const mismatch = [];
  const files = [];
  for (const rel of kept) {
    if (rel === IN_ARCHIVE_MANIFEST) continue; // 自指：清单不把自己算进 files（同一口径，见 buildInArchiveManifest）
    const abs = path.join(dir, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch (_e) { missing.push(rel); continue; }
    if (!st.isFile()) continue;
    const shaTarget = sha256File(abs);
    if (!sameTree) {
      let shaSource = "";
      try { shaSource = sha256File(path.join(root, rel)); } catch (_e) { shaSource = ""; }
      if (shaSource !== shaTarget) { mismatch.push(rel); continue; }
    }
    files.push({ path: rel, sha256: shaTarget });
  }
  if (missing.length) {
    throw new Error("目标目录缺 " + missing.length + " 个包内文件，拒绝写清单（不写半份/编造）：" +
      "\n  " + missing.slice(0, 10).join("\n  ") + (missing.length > 10 ? "\n  …" : ""));
  }
  if (mismatch.length) {
    throw new Error("目标目录有 " + mismatch.length + " 个文件与源树内容不一致，拒绝把源树 gitSha 贴上去：" +
      "\n  " + mismatch.slice(0, 10).join("\n  ") + (mismatch.length > 10 ? "\n  …" : ""));
  }
  const inArchive = buildInArchiveManifest({
    version, channel: opts.channel || "stable", edition,
    gitSha: meta.gitSha, gitDirty: dirty, builtAt: new Date().toISOString(),
    source: sameTree ? (dirty ? "worktree-dirty" : "worktree") : "emit-manifest", files,
  });
  const target = path.join(dir, IN_ARCHIVE_MANIFEST);
  fs.writeFileSync(target, JSON.stringify(inArchive, null, 2) + "\n");
  return { path: target, manifest: inArchive };
}

function verify(opts) {
  const manifestAbs = path.resolve(opts.root || ROOT, opts.verify);
  const manifest = JSON.parse(fs.readFileSync(manifestAbs, "utf8"));
  const archiveAbs = path.resolve(opts.root || ROOT, opts.archive || path.join(path.dirname(manifestAbs), manifest.archive.name));
  const errors = [];
  const actualArchive = sha256File(archiveAbs);
  if (actualArchive !== manifest.archive.sha256) errors.push("archive sha256 不符: " + actualArchive + " != " + manifest.archive.sha256);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lions-pack-verify-"));
  try {
    const r = spawnSync("tar", ["-xzf", archiveAbs, "-C", tmp], { encoding: "utf8" });
    if (r.status !== 0) errors.push("解包失败: " + (r.stderr || r.error));
    for (const f of manifest.files) {
      const abs = path.join(tmp, f.path);
      if (!fs.existsSync(abs)) { errors.push("缺文件: " + f.path); continue; }
      const actual = sha256File(abs);
      if (actual !== f.sha256) errors.push("sha256 不符: " + f.path);
    }
    // 包内清单（tar 根目录的 manifest.json）：安装侧门禁③的被测对象，必须随包存在且与外层清单一致。
    const inManAbs = path.join(tmp, IN_ARCHIVE_MANIFEST);
    if (!fs.existsSync(inManAbs)) {
      errors.push("产物根缺 " + IN_ARCHIVE_MANIFEST + "（安装侧门禁③「manifest.gitSha == HEAD」将无对象可测）");
    } else {
      let im = null;
      try { im = JSON.parse(fs.readFileSync(inManAbs, "utf8")); }
      catch (e) { errors.push("包内 " + IN_ARCHIVE_MANIFEST + " 不是合法 JSON: " + e.message); }
      if (im) {
        if (!/^[0-9a-f]{40}$/.test(String(im.gitSha || ""))) errors.push("包内 gitSha 不是完整 40 位 sha: " + JSON.stringify(im.gitSha));
        else if (im.gitSha !== manifest.gitSha) errors.push("包内 gitSha 与外层清单不一致: " + im.gitSha + " != " + manifest.gitSha);
        if (im.version !== manifest.version) errors.push("包内 version 与外层清单不一致: " + im.version + " != " + manifest.version);
        if (!Array.isArray(im.files)) errors.push("包内清单缺 files[]");
        else {
          if (im.files.some((f) => f.path === IN_ARCHIVE_MANIFEST)) errors.push("包内清单把自身算进 files（自指，files 计数会多 1）");
          const expect = manifest.files.map((f) => f.path + ":" + f.sha256).sort().join("\n");
          const got = im.files.map((f) => f.path + ":" + f.sha256).sort().join("\n");
          if (expect !== got) errors.push("包内 files[] 与外层清单不一致（数量 " + im.files.length + " vs " + manifest.files.length + "，或 sha256 不同）");
        }
        if (manifest.inArchiveManifest && manifest.inArchiveManifest.sha256 && sha256File(inManAbs) !== manifest.inArchiveManifest.sha256) {
          errors.push("包内 manifest.json 的 sha256 与外层清单记录不符");
        }
      }
    }
    // 产物不得含数据/密钥/构建产物
    const listed = fs.readdirSync(tmp, { recursive: true }).map(String);
    for (const rel of listed) {
      if (isExcluded(rel) && !rel.startsWith("verification/round78")) errors.push("产物含应排除项: " + rel);
      if (rel.endsWith(".env") || /\.db(-wal|-shm|-journal)?$/.test(rel)) errors.push("产物含数据/密钥: " + rel);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: errors.length === 0, errors, files: manifest.files.length };
}

function runSelftest() {
  const results = [];
  const assert = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail || "" });
  assert("排除 .env", isExcluded("packages/apps/mind/.env") === true);
  assert("保留 .env.example", isExcluded("packages/apps/mind/.env.example") === false);
  assert("排除 *.env（含 .macs.env）", isExcluded("packages/apps/mcp-agent-chat-server/.macs.env") === true);
  assert("排除 agent-f.env", isExcluded("scripts/macs-client/agent-f/agent-f.env") === true);
  assert("排除 .env.staging", isExcluded("packages/apps/mind/.env.staging") === true);
  assert("排除数据库", isExcluded("packages/apps/mind/prisma/dev.db") === true);
  assert("排除 db-wal", isExcluded("x/dev.db-wal") === true);
  assert("排除 verification", isExcluded("verification/foo/bar.md") === true);
  assert("保留静态冻结断言", isExcluded("verification/round78-prerender-freeze/assert-not-static.cjs") === false);
  assert("排除 skills-mirror", isExcluded("docs/skills-mirror/x/SKILL.md") === true);
  assert("保留普通文档", isExcluded("docs/productization/INSTALLER-PLAN.md") === false);
  const CLOSED = ["packages/apps/mcp-agent-chat-server/", "packages/apps/portal/"];
  assert("open-source 排除闭源包", isExcluded("packages/apps/mcp-agent-chat-server/src/x.ts", CLOSED) === true);
  assert("open-source 保留开源包", isExcluded("packages/apps/mind/src/x.ts", CLOSED) === false);
  assert("open-source 保留 console", isExcluded("packages/apps/console/src/app/page.tsx", CLOSED) === false);
  assert("edition 默认 sales", resolveEdition({}) === "sales");
  assert("edition=open", resolveEdition({ edition: "open" }) === "open");
  assert("--open-source = edition open", resolveEdition({ "open-source": true }) === "open");
  let threw = false; try { resolveEdition({ edition: "bogus" }); } catch (_e) { threw = true; } assert("非法 edition 抛错", threw);
  process.env.SOURCE_DATE_EPOCH = "1700000000";
  assert("SOURCE_DATE_EPOCH 决定 builtAt", buildStamp({ commitIso: "x", commitEpoch: 0 }, {}) === new Date(1700000000 * 1000).toISOString());
  assert("SOURCE_DATE_EPOCH 决定 tar epoch", packEpoch({ commitEpoch: 1 }, {}) === 1700000000);
  delete process.env.SOURCE_DATE_EPOCH;
  assert("--reproducible 用 commitIso", buildStamp({ commitIso: "2000-01-01T00:00:00.000Z", commitEpoch: 0 }, { reproducible: true }) === "2000-01-01T00:00:00.000Z");
  assert("channelIndex 带 summary/notes", channelIndex({ channel: "stable", version: "9.9.9", summary: "s", notes: "n" }).notes === "n" && channelIndex({ channel: "stable", version: "9.9.9", summary: "s", notes: "n" }).summary === "s");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lions-pack-selftest-"));
  try {
    fs.writeFileSync(path.join(tmp, "a.txt"), "hello");
    fs.mkdirSync(path.join(tmp, "d"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "d", "b.txt"), "world");
    const h1 = sha256File(path.join(tmp, "a.txt"));
    const h2 = sha256File(path.join(tmp, "a.txt"));
    assert("sha256 稳定", h1 === h2 && h1.length === 64, h1);
    const out = path.join(tmp, "t.tar.gz");
    tarCreate(tmp, ["a.txt", "d/b.txt"], out, 1000000000);
    assert("tar 产出存在", fs.existsSync(out) && fs.statSync(out).size > 0);
    const tmp2 = path.join(tmp, "x");
    fs.mkdirSync(tmp2);
    const r = spawnSync("tar", ["-xzf", out, "-C", tmp2], { encoding: "utf8" });
    assert("tar 可解包且内容一致", r.status === 0 && fs.readFileSync(path.join(tmp2, "a.txt"), "utf8") === "hello");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 2026-11-24 13:15 运营团队裁定（a）: 自检必须证明「--help / 未知参数**不会落成一次打包**」。
  //   判据不只是 rc，还要看 dist/ 目录**内容前后不变**（rc 对了但掉了半份包同样是灾难）。
  const distDir = path.join(ROOT, "dist");
  const snap = () => {
    try { return fs.readdirSync(distDir).sort().join("|"); } catch (_e) { return "(无 dist 目录)"; }
  };
  const before = snap();
  const h = spawnSync(process.execPath, [__filename, "--help"], { encoding: "utf8", timeout: 120000 });
  assert("--help -> exit 0 且打印用法", h.status === 0 && /用法: node scripts\/lions-pack\.cjs/.test(h.stdout || ""), "rc=" + h.status);
  const bogus = spawnSync(process.execPath, [__filename, "--bogus-arg=1"], { encoding: "utf8", timeout: 120000 });
  assert("未知参数 -> exit 3（不打包）", bogus.status === 3, "rc=" + bogus.status);
  assert("--help 与未知参数前后 dist/ 内容不变（没多出包）", snap() === before, "before=" + before + " after=" + snap());
  // ③ 反向：参数门不是「恒拒」——合法参数必须真的走到打包逻辑里去。
  //   用 --root=<不存在的目录> 触发打包阶段的失败（git ls-files 失败 -> 非 0），
  //   这样既证明「参数被接受、动作确实开始了」，又**不会真的写 dist**（自检里出包是灾难）。
  const legal = spawnSync(process.execPath, [__filename, "--root=/nonexistent-lions-root-selftest"], { encoding: "utf8", timeout: 120000 });
  assert("合法参数不被参数门拦住（走到打包逻辑才失败，不是 BAD-ARG）",
    legal.status !== 3 && !/BAD-ARG/.test(legal.stderr || ""), "rc=" + legal.status);
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + (r.detail ? " :: " + r.detail : ""));
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad === 0 ? "SELFTEST OK (" + results.length + " 断言)" : "SELFTEST FAILED (" + bad + ")");
  process.exit(bad === 0 ? 0 : 1);
}

/**
 * 2026-11-24 13:15 运营团队裁定（a，T_freeze 前置）: ⛔ 未知参数/--help **绝不能落成一次打包**。
 *   实测风险：窗口内任何人顺手 `node scripts/lions-pack.cjs --help`，旧版会把它当成一次普通打包调用
 *   （help 被 parseArgv 当成未知键，后面照常 build）-> **凭空多出一份包**，正好撞"窗口内只许一次 pack"的禁令。
 *   故：先校验参数集合，未知即 exit 3；--help/-h 打印用法 exit 0；两者都在**任何计算/写盘之前**返回。
 *   2026-11-24 13:16 运营团队转发 [team] 的机械定位: 本文件 0 处 failOnUnknown，
 *   参数解析在 parseArgv —— 未知参数被静默忽略、--help 等价于「无参数 -> 直接出包」。
 *   故参数域不再就地自写一份，改用**共享工具** scripts/lib/cli-args.cjs 的 failOnUnknown（口径单一，rc=3）。
 */
const USAGE = [
  "用法: node scripts/lions-pack.cjs [选项]",
  "",
  "打包（默认动作）:",
  "  --version=<v>            版本号（默认取 package.json）",
  "  --channel=<c>            stable|beta（默认 stable）",
  "  --root=<dir>             仓库根（默认脚本所在仓）",
  "  --out=<dir>              输出目录（默认 <root>/dist）",
  "  --edition=open|sales     版别（open 需 scripts/open-source-boundary.json）",
  "  --open-source            等价于 --edition=open",
  "  --summary=<s> --notes=<s> --notes-file=<f>   清单里的说明字段",
  "  --sign                    生成签名",
  "  --reproducible            可复现模式",
  "  --include-untracked       把未跟踪文件也打进包（**签名包禁用**）",
  "  --allow-dirty             允许已跟踪文件被改动（**签名包禁用**）",
  "  --latest                  顺带写 latest.json / <channel>.json / builds.jsonl",
  "",
  "只读动作:",
  "  --selftest                跑内置断言",
  "  --verify=<manifest.json>  校验既有包与清单一致",
  "  --emit-manifest=<dir>     只生成清单到 <dir>，不打包",
  "",
  "  --help, -h                只打印本用法（exit 0，不读树、不计算、不写任何文件）",
  "  未知参数                  exit 3（不打包）",
].join("\n");
// 参数域声明（唯一来源: 下面这份 spec；failOnUnknown 与 USAGE 都按它核对）
const ARG_SPEC = {
  flags: ["--help", "-h", "--selftest", "--json", "--sign", "--reproducible", "--include-untracked",
    "--allow-dirty", "--latest", "--open-source"],
  prefixes: ["--root=", "--out=", "--version=", "--channel=", "--edition=", "--summary=", "--notes=",
    "--notes-file=", "--emit-manifest=", "--verify=", "--archive="],
};

function parseArgv(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([A-Za-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

function resolveEdition(args) {
  const e = typeof args.edition === "string" ? args.edition : (args["open-source"] ? "open" : "sales");
  if (e !== "open" && e !== "sales") throw new Error("--edition 只能是 open|sales（收到 " + e + "）");
  if (args["open-source"] && e !== "open") throw new Error("--open-source 与 --edition=sales 冲突");
  return e;
}

function channelIndex(m) {
  return { schema: "lions-channel-index/1", channel: m.channel, version: m.version, edition: m.edition, gitSha: m.gitSha, builtAt: m.builtAt, archive: m.archive, signature: m.signature, summary: m.summary, notes: m.notes || "" };
}

function main() {
  const rawArgv = process.argv.slice(2);
  // ① 先判 help（只打印用法，exit 0）：不 parse 树、不计算、不写任何文件
  if (rawArgv.some((a) => a === "--help" || a === "-h" || a === "--h")) {
    console.log(USAGE);
    return;
  }
  // ② 再判未知参数（fail-closed，exit 3）：**在写盘之前**拒绝，绝不让它退化成一次打包。
  //    用共享工具而不是就地自写一份白名单（2026-11-24 13:16 运营团队转发 [team] 定位）。
  const { failOnUnknown } = require("./lib/cli-args.cjs");
  if (!failOnUnknown("lions-pack", rawArgv, ARG_SPEC)) { console.error(USAGE); process.exit(3); }
  const args = parseArgv(rawArgv);
  if (args.help || args.h) { console.log(USAGE); return; }
  if (args.selftest) return runSelftest();
  if (args["emit-manifest"] !== undefined) {
    if (args["emit-manifest"] === true) { console.error("--emit-manifest 需要目录参数：--emit-manifest=<dir>"); process.exit(3); }
    let res;
    try {
      res = emitManifest({
        root: args.root,
        dir: args["emit-manifest"],
        version: typeof args.version === "string" ? args.version : undefined,
        channel: typeof args.channel === "string" ? args.channel : undefined,
        edition: typeof args.edition === "string" ? args.edition : undefined,
        openSource: !!args["open-source"],
      });
    } catch (e) {
      // 2 = 无法判定（无 HEAD / 目录缺文件 / 内容与源树不符 -> 不写清单），不混进业务失败
      console.error("[emit-manifest] " + (e && e.message ? e.message : e));
      process.exit(2);
    }
    if (args.json) { process.stdout.write(JSON.stringify(res.manifest, null, 2) + "\n"); return; }
    console.log("EMIT OK");
    console.log("  清单   : " + res.path);
    console.log("  gitSha : " + res.manifest.gitSha + (res.manifest.gitDirty ? "  (dirty: 内容 != HEAD)" : ""));
    console.log("  版本   : " + res.manifest.version + "  files " + res.manifest.fileCount + "（不含 manifest.json 自身）");
    return;
  }
  if (args.verify) {
    const res = verify({ root: args.root, verify: args.verify, archive: args.archive });
    if (args.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    if (!res.ok) { console.error("PACK VERIFY FAILED:"); for (const e of res.errors) console.error("  " + e); process.exit(1); }
    if (!args.json) console.log("PACK VERIFY OK: " + res.files + " 个文件 sha256 与清单一致，产物无数据/密钥");
    return;
  }
  let notes = typeof args.notes === "string" ? args.notes : "";
  if (typeof args["notes-file"] === "string") { try { notes = fs.readFileSync(path.resolve(args["notes-file"]), "utf8"); } catch (e) { console.error("读 notes-file 失败: " + e.message); process.exit(3); } }
  const edition = resolveEdition(args);
  const res = build({
    root: args.root,
    out: typeof args.out === "string" ? args.out : undefined,
    version: typeof args.version === "string" ? args.version : undefined,
    channel: typeof args.channel === "string" ? args.channel : undefined,
    summary: typeof args.summary === "string" ? args.summary : undefined,
    notes: notes || undefined,
    includeUntracked: !!args["include-untracked"],
    allowDirty: !!args["allow-dirty"],
    sign: !!args.sign,
    openSource: edition === "open",
    edition,
    reproducible: !!args.reproducible,
  });
  const base = args.root ? path.resolve(args.root) : ROOT;
  if (args.latest) {
    const idx = channelIndex(res.manifest);
    fs.writeFileSync(path.join(res.outDir, "latest.json"), JSON.stringify(idx, null, 2) + "\n");
    fs.writeFileSync(path.join(res.outDir, res.manifest.channel + ".json"), JSON.stringify(idx, null, 2) + "\n");
    // 构建日志（时间序）：同版本重构建也能区分哪一次。
    const buildLine = { version: res.manifest.version, channel: res.manifest.channel, gitSha: res.manifest.gitSha, builtAt: res.manifest.builtAt, dirty: res.manifest.dirty, source: res.manifest.source, untrackedCount: res.manifest.untrackedCount, sha256: res.manifest.archive.sha256, bytes: res.manifest.archive.bytes };
    fs.appendFileSync(path.join(res.outDir, "builds.jsonl"), JSON.stringify(buildLine) + "\n");
  }
  // 运营团队 2026-11-24 02:15（第 ⑥ 条）：**打包动作必须落一条外部日志**，PACK_REF 与包 sha256 同记。
  //   为什么：包内 manifest 的 gitSha 是**包自己说的**（自证）；若有人从 ref X 打包再把 gitSha 改写成 Y，
  //   包内那份会跟着撒谎。外部日志是唯一独立源 —— A（git log ref..HEAD=0）+ C（外部日志的 ref 与 sha256）才是两个独立量。
  //   所以这条不受 --latest 等开关控制：打一次就记一次。
  try {
    const provDir = path.join(ROOT, 'run');
    fs.mkdirSync(provDir, { recursive: true });
    fs.appendFileSync(path.join(provDir, 'pack-provenance.jsonl'), JSON.stringify({
      schema: 'lions-pack-provenance/1',
      at: new Date().toISOString(),
      ref: res.manifest.gitSha,
      gitDirty: !!res.manifest.gitDirty,
      version: res.manifest.version,
      channel: res.manifest.channel,
      edition: res.manifest.edition,
      builtAt: res.manifest.builtAt,
      archive: path.relative(ROOT, res.archiveAbs),
      bytes: res.manifest.archive.bytes,
      sha256: res.manifest.archive.sha256,
      fileCount: res.manifest.fileCount,
    }) + '\n');
  } catch (e) {
    // AGENTS 12：外部日志写不进去必须出声 —— 少了这条，包与 ref 的绑定就退回「自证」。
    console.error('WARN 打包外部日志写入失败（PACK_REF/sha256 未留痕，门④ 独立源缺失）：' + String(e && e.message || e));
  }
  if (args.json) { process.stdout.write(JSON.stringify(res.manifest, null, 2) + "\n"); return; }
  console.log("PACK OK");
  console.log("  产物   : " + path.relative(base, res.archiveAbs) + " (" + (res.manifest.archive.bytes / 1048576).toFixed(1) + " MB)");
  console.log("  清单   : " + path.relative(base, res.manifestAbs));
  console.log("  版本   : " + res.manifest.version + "  渠道: " + res.manifest.channel + "  git: " + res.manifest.gitSha.slice(0, 8));
  console.log("  文件数 : " + res.manifest.fileCount + " / tracked " + res.trackedTotal + "（排除 " + res.manifest.excludedCount + "）");
  console.log("  迁移   : mind " + res.manifest.migrations.mind.length + " / session " + res.manifest.migrations.session.length);
  console.log("  包内清单: " + IN_ARCHIVE_MANIFEST + "（tar 根）gitSha=" + res.manifest.gitSha + " files=" + res.inArchiveManifest.fileCount + "（tar 条目 = files+1）");
  console.log("  校验和 : " + res.manifest.archive.sha256);
}

if (require.main === module) main();
module.exports = { isExcluded, dirtyState, dirtyReport, GENERATED, listTrackedDirty, sha256File, listFiles, listUntracked, collectMigrations, tarCreate, build, verify, emitManifest, buildInArchiveManifest, versionFirstLine, openSourceClosedPrefixes, SCHEMA, IN_ARCHIVE_MANIFEST, IN_ARCHIVE_SCHEMA, EXCLUDE_PREFIXES };
