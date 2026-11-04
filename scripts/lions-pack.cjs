#!/usr/bin/env node
/**
 * lions-pack.cjs — 产出可交付发布产物 + 清单（产品化 S0-1）
 * =================================================================
 *
 * 做什么:
 *   从**干净 git 树**打包"运行产品所需的全部 tracked 文件"，生成:
 *     dist/lions-<version>.tar.gz
 *     dist/lions-<version>.manifest.json   (schema lions-release-package/1)
 *
 * 为什么用 tracked 文件:
 *   业务数据(1.4G 账本 / 5.8G 会话库)、密钥(.env)、构建产物(.next*)、node_modules、日志、备份
 *   都不在 tracked 文件里 —— 于是"只打包 tracked"天然满足"产物不含数据与密钥"这条硬要求，
 *   比手写排除清单更可靠（清单会腐，git 索引是事实）。
 *
 * 用法:
 *   node scripts/lions-pack.cjs [--version=0.1.0] [--channel=stable] [--out=dist/] [--summary="..."] [--reproducible] [--json]
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
  "docs/agent-x-verifies/",
  "docs/agent-x-verifies/",
  "docs/verification/",
  // 2026-11-02（devops 线，④"打不出包"）：运行态与开发进度目录不是产品内容。
  //   run/ 是 pid/lock/cursor/一次性探针；progress/ 是逐轮开发流水。
  //   它们会被"包内未跟踪文件"判据算进去（实测 39 条），但装到客户机器上毫无意义。
  "run/",
  "progress/",
  ".progress/",
  ".progress-2026-10-08/",
];
// verification/ 整体排除，但保留升级要复用的静态冻结断言。
const VERIFICATION_KEEP = ["verification/round78-prerender-freeze/"];
// 任何 "*.env" / ".env*" 形态的文件都排除（`.env.example` 除外）——
//   2026-10-16 实测：仓库里有**被跟踪**的 `packages/apps/mcp-agent-chat-server/.macs.env` 与
//   `scripts/macs-client/agent-x/agent-f.env` 含非空密钥，且旧规则只认 `.env.` 前缀，导致它们进了发布包。
const ENV_LIKE_RE = /(^|\.)env(\.|$)/i;
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
 * 已跟踪但被修改的文件（2026-11-03，flywheel-line 报 OI-16 后修）。
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
function listUntracked(root) {
  const r = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  // 2026-11-02（KR-3 固化）：根 CLIENT_VERSION 由本脚本在打包前**生成**（值取 scripts/macs-responder/CLIENT_VERSION），
  //   它是产物的一部分而不是源码，故不参与"未跟踪=漏提交"的 fail-closed 判定。
  const GENERATED = new Set(["CLIENT_VERSION"]);
  return r.stdout.split("\u0000").filter(Boolean).filter((f) => !GENERATED.has(f)).filter((f) => !isExcluded(f)).filter((f) => {
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

function tarCreate(root, files, outAbs, epoch) {
  const listFile = path.join(os.tmpdir(), "lions-pack-files-" + process.pid + ".txt");
  fs.writeFileSync(listFile, files.join("\n") + "\n");
  const args = ["--sort=name", "--owner=0", "--group=0", "--numeric-owner"];
  if (epoch) args.push("--mtime=@" + epoch);
  args.push("-czf", outAbs, "-C", root, "-T", listFile);
  try {
    const r = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error("tar 失败: " + (r.stderr || r.error));
  } finally {
    try { fs.unlinkSync(listFile); } catch (_e) {}
  }
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
  // OI-16（2026-11-03，flywheel-line 报）：已跟踪文件的修改也必须 fail-closed，
  //   否则 dirty=false 是假的 —— 产物会带上未提交改动，而清单不体现。
  const trackedDirty = listTrackedDirty(root);
  if (trackedDirty.length && !opts.allowDirty) {
    throw new Error("工作区有 " + trackedDirty.length + " 个已跟踪文件被修改（会进产物但不进清单）：" +
      "\n  " + trackedDirty.slice(0, 12).join("\n  ") + (trackedDirty.length > 12 ? "\n  …" : "") +
      "\n要么提交，要么用 --allow-dirty（产物会标 dirty:true）");
  }
  const meta = gitMeta(root);
  const version = resolveVersion(root, opts.version);
  // 2026-11-02（devops 线，实测）：版本闭环硬约束 —— 产物标签必须等于**树里 VERSION 的内容**。
  //   事故：在干净工作树里用 --version=0.4.1 打包，但 HEAD 的 VERSION 还是 0.1.0，
  //   于是清单写 0.4.1、安装却按树内 VERSION 装成 0.1.0（lions-install 读的是树内 VERSION）。
  //   "标签一个号、内容是另一个号"正是版本无法追溯的根源，必须 fail-closed。
  if (opts.version) {
    const vf = path.join(root, "VERSION");
    const treeVersion = fs.existsSync(vf) ? fs.readFileSync(vf, "utf8").trim() : "";
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
  const { all, kept, excluded } = listFiles(root, Object.assign({}, opts, { closed }));
  // 只打包常规文件：符号链接/目录（如 backups 软链）不进产物（避免 EISDIR 与不确定语义）。
  const packable = kept.filter((rel) => {
    try { return fs.lstatSync(path.join(root, rel)).isFile(); } catch (_e) { return false; }
  });
  if ((opts.edition || (opts.openSource ? "open" : "sales")) === "sales") {
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
  fs.mkdirSync(outDir, { recursive: true });
  const archiveName = "lions-" + version + ".tar.gz";
  const archiveAbs = path.join(outDir, archiveName);
  tarCreate(root, packable, archiveAbs, packEpoch(meta, opts));
  const files = packable.map((rel) => {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    return { path: rel, sha256: sha256File(abs), bytes: st.size };
  });
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
    edition: opts.edition || (opts.openSource ? "open" : "sales"),
    gitSha: meta.gitSha,
    commitTime: meta.commitIso,
    builtAt: buildStamp(meta, opts),
    node: NODE_REQUIREMENT,
    pnpm: PNPM_REQUIREMENT,
    summary: opts.summary || "",
    notes: opts.notes || "",
    archive: { name: archiveName, sha256: sha256File(archiveAbs), bytes: archiveBytes },
    signature,
    fileCount: files.length,
    totalBytes: files.reduce((a, f) => a + f.bytes, 0),
    excludedCount: excluded,
    openSource: !!opts.openSource,
    closedPackages: opts.openSource ? closed : null,
    dirty: !!(opts.includeUntracked || opts.allowDirty || untracked.length > 0 || trackedDirty.length > 0),
    source: opts.includeUntracked ? "include-untracked" : (opts.allowDirty ? "allow-dirty" : "tracked"),
    untrackedCount: untracked.length,
    migrations: collectMigrations(root),
    files,
  };
  const manifestAbs = path.join(outDir, "lions-" + version + ".manifest.json");
  fs.writeFileSync(manifestAbs, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestAbs, archiveAbs, manifest, trackedTotal: all.length, outDir };
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
  assert("排除 agent-f.env", isExcluded("scripts/macs-client/agent-x/agent-f.env") === true);
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
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + (r.detail ? " :: " + r.detail : ""));
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad === 0 ? "SELFTEST OK (" + results.length + " 断言)" : "SELFTEST FAILED (" + bad + ")");
  process.exit(bad === 0 ? 0 : 1);
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
  const args = parseArgv(process.argv.slice(2));
  if (args.selftest) return runSelftest();
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
  if (args.json) { process.stdout.write(JSON.stringify(res.manifest, null, 2) + "\n"); return; }
  console.log("PACK OK");
  console.log("  产物   : " + path.relative(base, res.archiveAbs) + " (" + (res.manifest.archive.bytes / 1048576).toFixed(1) + " MB)");
  console.log("  清单   : " + path.relative(base, res.manifestAbs));
  console.log("  版本   : " + res.manifest.version + "  渠道: " + res.manifest.channel + "  git: " + res.manifest.gitSha.slice(0, 8));
  console.log("  文件数 : " + res.manifest.fileCount + " / tracked " + res.trackedTotal + "（排除 " + res.manifest.excludedCount + "）");
  console.log("  迁移   : mind " + res.manifest.migrations.mind.length + " / session " + res.manifest.migrations.session.length);
  console.log("  校验和 : " + res.manifest.archive.sha256);
}

if (require.main === module) main();
module.exports = { isExcluded, sha256File, listFiles, listUntracked, collectMigrations, tarCreate, build, verify, openSourceClosedPrefixes, SCHEMA, EXCLUDE_PREFIXES };
