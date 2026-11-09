#!/usr/bin/env node
/**
 * lions-upgrade.cjs — 用户机器上的平滑升级 + 失败自动回滚（产品化 S0-1）
 * ========================================================================
 *
 * 与 scripts/lions-release.cjs 的关系:
 *   release 工具管"本机生产发布"（八步判据）；本工具管"用户安装根的版本升级"。
 *   两者共用口径：先停服务、构建后验证、失败回滚、每次留痕（JSONL）。本工具不修改 release 工具。
 *
 * 八步（任一步失败 -> 回滚分支）:
 *   1 preflight  读 install.json / 校验产物 sha256 / 磁盘 / 并发锁
 *   2 backup     三张库 checkpoint + 复制到 backups/<ts>/；记录当前版本与单元
 *   3 stop       写 Restart=no drop-in -> daemon-reload -> stop（默认不碰线上；--unit-prefix 可隔离测试）
 *   4 apply      解包新版本 -> releases/<to>；pnpm install；prisma generate
 *   5 migrate    mind: migrate deploy；schema 有变化的 app 才 db push；补 raw SQL
 *   6 build      生产构建（next build）
 *   7 switch     切 current -> 新版本；去 drop-in；启动；健康验证
 *   8 record     logs/upgrade-evidence.jsonl + 人类日志
 *
 * 回滚: 停服务 -> 恢复数据库备份 -> current 切回旧版本 -> 启动 -> 验证 -> 留痕 ROLLED_BACK_OK
 *
 * 用法:
 *   node scripts/lions-upgrade.cjs --home=DIR --from=<tar|dir> [--dry-run] [--json]
 *   node scripts/lions-upgrade.cjs --home=DIR --check [--source=file://DIR]
 *   node scripts/lions-upgrade.cjs --home=DIR [--rollback]
 *   node scripts/lions-upgrade.cjs --selftest
 *   [--skip-deps] [--skip-generate] [--skip-migrate] [--skip-build] [--skip-start] [--no-systemctl] [--allow-edition-change]
 *   [--repair]   # 同版本换包：目标版本 == 当前版本，且树与产物有关键差异时才允许；不动库（强制 skip-migrate）
 *   [--unit-prefix=lions-qa-] [--simulate-fail=<step>]   # 测试接缝
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { spawnSync } = require("child_process");
const H = require("./lib/lions-home.cjs");
const { APPS, START_ORDER } = require("./lib/lions-apps.cjs");
const U = require("./lib/lions-units.cjs");
const I = require("./lions-install.cjs");
const { RUNTIME_TABLES } = require("./lib/lions-runtime-tables.cjs");


// 2026-11-05（副本漂移）：env 用户执行的是 /usr/local/lib/lions-tools 下的世界可读副本。
// 副本旧 = 装的时候跑的不是你以为的代码（实测：新加的 step indexes 没生效，日志里也看不出来）。
// 这里在脚本入口做一次一致性检查：DIFF 就先同步再继续；同步失败则直接退出，绝不在旧副本上装。
// 从 /usr/local/lib/lions-tools 副本执行时，__dirname 的 .. 是 /usr/local/lib（不是仓库）。
// 仓库固定取 ~/lions（世界可读，env 用户也可读）；其它情况按脚本位置推断。
const REPO_ROOT = __dirname.startsWith("/usr/local/lib/lions-tools")
  ? "~/lions"
  : path.resolve(__dirname, "..");
function ensureToolsReplica(quiet) {
  // 2026-11-05：env 用户（dev/test/prod）读不到 ~（750），无法与仓库比对；
  // 这种情况改对 /usr/local/lib/lions-tools/MANIFEST.sha256 自检副本完整性（--staged-only），
  // 仓库↔副本的一致性由 devops 侧在装前用不带参数的同一判据把关。
  let canReadRepo = true;
  try { fs.accessSync(path.join(REPO_ROOT, "scripts", "lions-upgrade.cjs"), fs.constants.R_OK); } catch { canReadRepo = false; }
  const chkArgs = [canReadRepo
    ? path.join(REPO_ROOT, "scripts", "check-lions-tools-drift.cjs")
    : "/usr/local/lib/lions-tools/check-lions-tools-drift.cjs"];
  if (!canReadRepo) chkArgs.push("--staged-only");
  const chk = spawnSync(process.execPath, chkArgs, { encoding: "utf8" });
  if (chk.status === 0) { if (!quiet) console.log("[tools] 副本与仓库一致"); return; }
  console.log("[tools] lions-tools 副本与仓库不一致，先同步：");
  console.log(String(chk.stdout || "").trim());
  if (!canReadRepo) throw new Error("lions-tools 副本自检失败且当前用户无法同步（需 devops 侧跑 stage-lions-tools.sh）");
  const st = spawnSync("bash", [path.join(REPO_ROOT, "scripts", "stage-lions-tools.sh")], { encoding: "utf8", cwd: REPO_ROOT });
  if (st.status !== 0) throw new Error("lions-tools 副本同步失败，拒绝在旧副本上安装：" + String(st.stderr || "").slice(0, 300));
  console.log("[tools] 已同步副本");
}

const SCHEMA = "lions-upgrade/1";
const DB_APPS = START_ORDER.filter((a) => APPS[a].hasDatabase);
const RAW_SQL = { session: ["v2_fts5.sql", "v3_multi_source_sync.sql"] };

function parseArgv(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([A-Za-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}
function log(args, msg) { if (args.json) console.error(msg); else console.log(msg); }
/**
 * 2026-11-02（devops 线，主平台实测）：原来用 readFileSync 一次读入算 sha256，
 *   遇到 >2GiB 的数据库备份（session.sql 实测 2.1GB）会抛
 *   "File size (2175531441) is greater than 2 GiB" —— Node 的 Buffer 上限。
 *   备份就是为了"出事能回滚"，恰恰在大库上算不出校验值 = 回滚证据缺失。
 *   改为流式分块计算。
 */
function sha256File(p) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}
function ts() { return new Date().toISOString().replace(/[:.]/g, "-"); }

/* ── 升级来源：file:// 与 http(s)://（必要时下载 + 校验 + 验签） ── */

function httpGetText(url, redirects) {
  redirects = redirects === undefined ? 5 : redirects;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); resolve(httpGetText(new URL(res.headers.location, url).toString(), redirects - 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error("HTTP " + res.statusCode + " " + url)); return; }
      let d = ""; res.setEncoding("utf8"); res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

function httpDownload(url, outAbs, redirects) {
  redirects = redirects === undefined ? 5 : redirects;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); resolve(httpDownload(new URL(res.headers.location, url).toString(), outAbs, redirects - 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error("HTTP " + res.statusCode + " " + url)); return; }
      const f = fs.createWriteStream(outAbs);
      res.pipe(f);
      f.on("finish", () => f.close(() => resolve(outAbs)));
      f.on("error", reject);
    }).on("error", reject);
  });
}

/** gpg 验签（可选 --gpg-key=<公钥文件>；未给则用默认 keyring）。 */
function verifySignature(args, asc, data) {
  if (!fs.existsSync(asc)) throw new Error("签名文件不存在: " + asc);
  let env = process.env;
  if (args["gpg-key"]) {
    const gnupg = fs.mkdtempSync(path.join(os.tmpdir(), "lions-gnupg-"));
    env = Object.assign({}, process.env, { GNUPGHOME: gnupg });
    const imp = spawnSync("gpg", ["--batch", "--import", String(args["gpg-key"])], { encoding: "utf8", env });
    if (imp.status !== 0) throw new Error("导入公钥失败: " + (imp.stderr || imp.error));
  }
  const v = spawnSync("gpg", ["--batch", "--verify", asc, data], { encoding: "utf8", env });
  if (v.status !== 0) throw new Error("签名校验失败: " + ((v.stderr || "") + (v.error || "")).slice(0, 300));
  return { ok: true, key: (v.stderr || "").split("\n").find((l) => /using .* key/.test(l)) || "" };
}

/** 把 --from / --source(--to) 解析为一个本地 tar/dir 路径。返回 {from, tempDir, version}。 */
async function resolveSource(args) {
  if (args.from) return { from: path.resolve(String(args.from)), tempDir: null, version: null };
  const source = typeof args.source === "string" ? args.source : null;
  if (!source) throw new Error("缺少 --from=<tar|dir> 或 --source=<file://DIR|https://BASE>");
  const to = typeof args.to === "string" ? args.to : "latest";
  if (source.startsWith("file://")) {
    const dir = source.slice("file://".length).replace(/\/$/, "");
    let version = to;
    if (to === "latest") version = JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8")).version;
    return { from: path.join(dir, "lions-" + version + ".tar.gz"), tempDir: null, version };
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const base = source.replace(/\/$/, "");
    let version = to;
    if (to === "latest") version = JSON.parse(await httpGetText(base + "/latest.json")).version;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lions-upgrade-fetch-"));
    const tar = path.join(tmp, "lions-" + version + ".tar.gz");
    const man = path.join(tmp, "lions-" + version + ".manifest.json");
    await httpDownload(base + "/lions-" + version + ".tar.gz", tar);
    await httpDownload(base + "/lions-" + version + ".manifest.json", man);
    const manifest = JSON.parse(fs.readFileSync(man, "utf8"));
    const actual = sha256File(tar);
    if (manifest.archive && manifest.archive.sha256 && actual !== manifest.archive.sha256) throw new Error("下载产物 sha256 不符（可能被篡改/损坏）");
    const asc = tar + ".asc";
    if (args["require-signature"]) {
      try { await httpDownload(base + "/lions-" + version + ".tar.gz.asc", asc); } catch (e) { throw new Error("要求签名但下载 .asc 失败: " + e.message); }
      verifySignature(args, asc, tar);
    } else {
      try { await httpDownload(base + "/lions-" + version + ".tar.gz.asc", asc); verifySignature(args, asc, tar); } catch (_e) { /* 未强制：签名缺失/失败不阻断 */ }
    }
    return { from: tar, tempDir: tmp, version };
  }
  throw new Error("不支持的 --source 协议（支持 file:// 与 http(s)://）: " + source);
}
// 2026-11-04：portal 已开源（open-source-line 的 29cf57bb2/cbe4fecef 起，open 包合法包含 portal），
//   若仍把 portal 当闭源标记，"open 版产物"会被误判成 sales 并触发 editionGuard 拒绝升级（dev 实测）。
//   现在只以 mcp-agent-chat-server 作为闭源标记；与 lions-pack 的 man.closed 口径一致。
const CLOSED_PACKAGES = ["packages/apps/mcp-agent-chat-server"];
function detectEdition(dir) { const present = CLOSED_PACKAGES.filter((x) => fs.existsSync(path.join(dir, x))); return present.length > 0 ? "sales" : "open"; }
/** 返回错误串或 null（fail-closed：edition 变更需显式放行）。 */
function editionGuard(fromEdition, toEdition, allow) { if (!fromEdition || !toEdition || fromEdition === toEdition || allow) return null; return "edition 不一致: 已装 " + fromEdition + " -> 新包 " + toEdition; }

function readInstall(home) {
  const rec = H.readInstallRecord(home);
  if (!rec || rec._unparsable) throw new Error("找不到 install.json（该安装根不是由 lions-install 装的）: " + H.installRecordPath(home));
  return rec;
}
function writeInstall(home, rec) { fs.writeFileSync(H.installRecordPath(home), JSON.stringify(rec, null, 2) + "\n"); }
function evidence(home, obj) {
  const dir = H.logsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "upgrade-evidence.jsonl"), JSON.stringify(obj) + "\n");
}
function unitDir(args, rec) { return typeof args["systemd-dir"] === "string" ? path.resolve(args["systemd-dir"]) : (rec.systemdDir || path.join(os.homedir(), ".config", "systemd", "user")); }
function unitNameFor(args, rec, app) {
  // 2026-11-05 P0（两次生产停服）：旧实现在 install.json 缺 apps[app] 时回退到 unitName(app, prefix)，
  // prefix 为空就得到 lions-<app>（= selfonline 的单元名），于是装 env 时把生产停了。
  // 现在改为 fail-closed：必须能从 install.json 或显式 --unit-prefix 得到带 env 的名字；
  // 只有显式 --allow-unprefixed 才允许 lions-<app>（仅 selfonline 自身维护时用）。
  // 2026-11-05 修正：若 install.json 有 apps 但**没有这个 app**（如 dev 没有 portal），
  // 说明该 env 本就不部署这个单元 -> 返回 null 让调用方跳过，而不是 fail-closed。
  // 只有"apps 整个缺失"或"unit 名无 env 前缀"才是危险情形，继续抛错。
  if (rec.apps && !rec.apps[app] && !args["unit-prefix"]) return null;
  const fromRec = rec.apps && rec.apps[app] && rec.apps[app].unit;
  if (fromRec) return fromRec;
  const prefix = args["unit-prefix"];
  if (!prefix) {
    throw new Error("无法确定 unit 名：install.json 缺 apps." + app + ".unit，且未传 --unit-prefix（拒绝回退到无前缀 lions-<app>，会误停生产）");
  }
  const u = U.unitName(app, prefix);
  if (!args["allow-unprefixed"] && !/^lions-[A-Za-z0-9-]+-(mind|session|console|selfimproving|portal)\.service$/.test(u)) {
    throw new Error("unit 名不含 env 前缀：" + u + "（若确为 selfonline 自身维护，加 --allow-unprefixed）");
  }
  return u;
}

function dbFiles(home, app) {
  const p = path.join(H.appDataDir(home, app), "dev.db");
  return [p, p + "-wal", p + "-shm"];
}
function checkpoint(home, app, releaseDir) {
  const bin = path.join(releaseDir, "node_modules", ".bin", "prisma");
  const db = path.join(H.appDataDir(home, app), "dev.db");
  const script = "try{const D=require(String(process.argv[1]));const db=new D(process.argv[2]);db.pragma('wal_checkpoint(TRUNCATE)');db.close();}catch(e){process.exit(3);}";
  const r = spawnSync(process.execPath, ["-e", script, path.join(releaseDir, "node_modules", "better-sqlite3"), db], { encoding: "utf8" });
  return r.status === 0;
}
function backupDbs(home, releaseDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const made = [];
  // 2026-10-27 (商业化线): PG 安装没有 data/<app>/dev.db；用 pg_dump 做逻辑备份，不能报 0 库。
  let rec = {};
  try { rec = JSON.parse(fs.readFileSync(path.join(home, "install.json"), "utf8")); } catch (_e) {}
  if (rec.dbMode === "pg") {
    const keys = { mind: "MIND_DATABASE_URL", session: "SESSION_DATABASE_URL", selfimproving: "SELFIMPROVING_DATABASE_URL" };
    for (const app of DB_APPS) {
      const envPath = path.join(releaseDir, APPS[app].dir, ".env");
      if (!fs.existsSync(envPath)) continue;
      const env = I.parseEnvFile(fs.readFileSync(envPath, "utf8"));
      // 2026-11-02（devops 线，主平台实测）：.env 里的 URL 可能带 Prisma 专用参数
      //   （?connection_limit=30&pool_timeout=30）。pg_dump/psql 不认，会报
      //   'invalid URI query parameter' 并让升级在**备份步骤**就失败（还没停服）。
      //   备份/恢复只连数据库、不经过 Prisma，所以去掉查询串。
      const url = (env[keys[app]] || env.DATABASE_URL || "").split("?")[0];
      if (!url) continue;
      const dst = path.join(outDir, app + ".sql");
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      I.run("pg_dump", ["--no-owner", "--no-privileges", "-f", dst, url], { allowFail: false });
      made.push({ app, src: "postgres", dst, sha256: sha256File(dst) });
    }
    return made;
  }
  for (const app of DB_APPS) {
    const src = path.join(H.appDataDir(home, app), "dev.db");
    if (!fs.existsSync(src)) continue;
    checkpoint(home, app, releaseDir);
    const dstDir = path.join(outDir, app);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of dbFiles(home, app)) {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dstDir, path.basename(f)));
    }
    const dst = path.join(dstDir, "dev.db");
    made.push({ app, src, dst, sha256: sha256File(dst) });
  }
  return made;
}
/**
 * 从升级前备份恢复数据库。
 *
 * 2026-11-02（devops 线，实测发现的 P0）：原实现**只认 SQLite**（backupDir/<app>/dev.db），
 *   PG 模式的备份是 <app>.sql，于是 <<if (!exists) continue>> 把每个 app 都跳过 ——
 *   **代码回滚了、库没回滚**，而 migrate 阶段可能已经 db push 过。
 *   结果是"旧代码 + 新 schema"的静默不一致，几天后才以莫名其妙的方式爆出来。
 *
 * 现在的语义：
 *   - SQLite：照旧恢复文件；
 *   - PG：默认**不自动恢复**（对生产库做 DROP SCHEMA 风险过高），但会把"未恢复"如实返回，
 *     由调用方写进证据与日志，避免"以为回滚了"；
 *   - opts.restorePg=true（仅 --rollback 显式传）才执行：schema reset + psql -f 恢复。
 */
function restoreDbs(home, backupDir, opts) {
  opts = opts || {};
  // 容忍没有 install.json 的场景（自检夹具/裸目录）：没有记录就按 SQLite 旧路径走。
  let rec = null;
  try { rec = readInstall(home); } catch (_e) { rec = null; }
  const isPg = rec && rec.dbMode === "pg";
  if (isPg) {
    const sqlFiles = DB_APPS.map((app) => path.join(backupDir, app + ".sql")).filter((p) => fs.existsSync(p));
    if (!opts.restorePg) {
      return sqlFiles.map((p) => ({ app: path.basename(p, ".sql"), skipped: true, reason: "pg-requires-explicit-restore", file: p }));
    }
    const restored = [];
    const envKeys = { mind: "MIND_DATABASE_URL", session: "SESSION_DATABASE_URL", selfimproving: "SELFIMPROVING_DATABASE_URL" };
    for (const app of DB_APPS) {
      const sql = path.join(backupDir, app + ".sql");
      if (!fs.existsSync(sql)) continue;
      const envPath = path.join(H.currentLink(home), APPS[app].dir, ".env");
      let url = "";
      try {
        const env = I.parseEnvFile(fs.readFileSync(envPath, "utf8"));
        url = env[envKeys[app]] || env.DATABASE_URL || "";
      } catch (_e) {}
      if (!url) { restored.push({ app, skipped: true, reason: "no-database-url" }); continue; }
      // 破坏性：先重置 public schema，否则 dump 会与既有对象冲突
      I.run("psql", [url, "-v", "ON_ERROR_STOP=1", "-c", "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"], { allowFail: false });
      I.run("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", sql], { allowFail: false });
      restored.push({ app, restored: true, file: sql });
    }
    return restored;
  }
  const restored = [];
  for (const app of DB_APPS) {
    const src = path.join(backupDir, app, "dev.db");
    if (!fs.existsSync(src)) continue;
    for (const f of dbFiles(home, app)) { try { fs.rmSync(f, { force: true }); } catch (_e) {} }
    const dir = path.join(H.appDataDir(home, app));
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, "dev.db"));
    restored.push({ app, restored: true });
  }
  return restored;
}
function writeDropIn(unitDirAbs, unit, on) {
  const dir = path.join(unitDirAbs, unit + ".d");
  const file = path.join(dir, "10-upgrade-maintenance.conf");
  if (on) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, "[Service]\nRestart=no\n"); }
  else { try { fs.rmSync(file, { force: true }); } catch (_e) {} }
}
function sysctl(args, argv) {
  // 2026-11-03（dev 实测）：sudo -u <env> 下没有 XDG_RUNTIME_DIR，`systemctl --user` 会失败，
  //   而旧的 allowFail 把失败吞了 —— 结果"8 步全绿"但单元根本没重启，旧进程继续服务（假升级）。
  //   现在：显式带上会话总线环境；失败不再静默（调用方改为读取 MainPID 复核）。
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const env = { ...process.env };
  if (uid != null) {
    if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = "/run/user/" + uid;
    if (!env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/" + uid + "/bus";
  }
  return I.run("systemctl", ["--user"].concat(argv), { allowFail: true, env });
}
/** 读某单元当前 MainPID 与启动时刻（用于证明"真的重启了"） */
function unitRuntime(args, rec, app) {
  const u = unitNameFor(args, rec, app);
  const r = sysctl(args, ["show", u, "-p", "MainPID", "-p", "ExecMainStartTimestamp", "--value"]);
  const out = String((r && (r.stdout || r.out)) || "").trim().split("\n");
  return { unit: u, pid: Number(out[0]) || 0, started: out[1] || "" };
}
function snapshotPids(args, rec) {
  const o = {};
  for (const app of START_ORDER) { const x = unitRuntime(args, rec, app); if (x.pid) o[app] = x.pid; }
  return o;
}
// 2026-11-05 P0（两次生产停服）：env 的 install.json 里 unit 名若没带 env 前缀（如 sales 写成 lions-mind），
// stopUnits 会照着它停，直接停到 selfonline。停之前必须确认该 unit 真的属于这个 home。
function unitBelongsToHome(args, home, unit) {
  const h = path.resolve(home);
  // 2026-11-05：必须走 sysctl()（它会补 XDG_RUNTIME_DIR/DBUS），否则 sudo -u <env> 下 systemctl --user 读不到单元，
  // 会把"读不到"误判成"不属于该 home"，从而拒绝一切 env 升级（实测 dev/prod 都被挡）。
  const r = sysctl(args, ["show", unit, "-p", "ExecStart", "-p", "FragmentPath"]);
  const out = String((r && (r.stdout || r.stdoutText)) || "");
  if (!out.trim()) {
    // 读不到时用单元文件路径兜底（/home/<env>/.config/systemd/user/<unit> 存在即视为属于该 env）
    const m = home.match(/^\/home\/([a-z0-9]+)\/lions$/);
    if (m) { try { return fs.existsSync("/home/" + m[1] + "/.config/systemd/user/" + unit); } catch (_e) { return false; } }
    return false;
  }
  return out.includes(h);
}

function stopUnits(args, rec) {
  // 升级前记录 MainPID：升级后要能证明 PID 变了（否则就是"假升级"）
  if (!args["no-systemctl"]) rec.oldPids = snapshotPids(args, rec);
  const ud = unitDir(args, rec);
  for (const app of START_ORDER) writeDropIn(ud, unitNameFor(args, rec, app), true);
  if (!args["no-systemctl"]) {
    const list = START_ORDER.map((a) => unitNameFor(args, rec, a));
    console.log("[units] home=" + args.home + " env-prefix=" + (args["unit-prefix"] || "(from install.json)") + " 将停止: " + list.join(","));
    sysctl(args, ["daemon-reload"]);
    for (const app of START_ORDER) {
      const u = unitNameFor(args, rec, app);
      if (!u) continue;
      if (!unitBelongsToHome(args, args.home, u)) {
        throw new Error("拒绝停服：单元 " + u + " 不属于 " + args.home + "（install.json 的 unit 名可能没带 env 前缀）");
      }
      sysctl(args, ["stop", u]);
    }
  }
}
function startUnits(args, rec) {
  const ud = unitDir(args, rec);
  for (const app of START_ORDER) writeDropIn(ud, unitNameFor(args, rec, app), false);
  if (!args["no-systemctl"]) {
    sysctl(args, ["daemon-reload"]);
    for (const app of START_ORDER) { const u0 = unitNameFor(args, rec, app); if (u0) sysctl(args, ["start", u0]); }
    // 复核：PID 必须变（旧进程还在 -> 抛错，别让"假升级"记成成功）
    rec.newPids = snapshotPids(args, rec);
    const oldP = rec.oldPids || {};
    const same = Object.keys(rec.newPids).filter((a) => oldP[a] && oldP[a] === rec.newPids[a]);
    rec.unitsRestarted = same.length === 0 && Object.keys(rec.newPids).length > 0;
    if (same.length) {
      throw new Error("单元未重启（PID 未变： " + same.map((a) => a + "=" + rec.newPids[a]).join(",") + "）—— systemctl --user 可能不可达，拒绝记成升级成功");
    }
  }
}
function schemaHash(releaseDir, app) {
  const p = path.join(releaseDir, APPS[app].dir, "prisma", "schema.prisma");
  return fs.existsSync(p) ? sha256File(p) : null;
}
/**
 * 升级时重建新版本的 .env：发布包**不含** .env（密钥不入包），所以新 release 必须重新生成。
 * 关键：把**旧版本的 .env 值**作为 answers 合并进去，保留用户的模型 key / 服务 key；
 *   同时用 buildAppEnv 重算 DB/URL/路径（指向新 home 的 data 与 current）。
 */
// 2026-11-02: 生成模型配置不属于“发布 env”。升级重建 .env 时**不从旧 .env 继承**这些键，
//   否则 MiniMax/agent-x 的选择会被安装器/升级器悄悄带进新 release，覆盖 dev 的 .env.local。
//   模型只从 app 目录的 .env.local（dev override）或部署方显式注入来。
const RELEASE_MODEL_KEYS = new Set(["MINIMAX_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "REFLECT_MODEL"]);

function regenerateEnv(ctx, newRelease, oldRelease) {
  const written = [];
  for (const app of START_ORDER) {
    const appDir = path.join(newRelease, APPS[app].dir);
    // 2026-10-27 (商业化线): open 版导出没有 portal 目录；升级不能对它写 .env。
    if (!fs.existsSync(appDir)) continue;
    const examplePath = path.join(appDir, ".env.example");
    const exampleEnv = fs.existsSync(examplePath) ? I.parseEnvFile(fs.readFileSync(examplePath, "utf8")) : {};
    const oldEnvPath = path.join(oldRelease, APPS[app].dir, ".env");
    const oldEnvRaw = fs.existsSync(oldEnvPath) ? I.parseEnvFile(fs.readFileSync(oldEnvPath, "utf8")) : {};
    // 不继承生成模型键；.env.local override 不在此文件，升级不会覆盖它。
    const oldEnv = Object.fromEntries(Object.entries(oldEnvRaw).filter(([k]) => !RELEASE_MODEL_KEYS.has(k)));
    const answers = Object.assign({}, oldEnv);
    const isPg = ctx.dbMode === "pg" || oldEnv.MIND_DB_DRIVER === "pg" || oldEnv.SESSION_DB_DRIVER === "pg" || oldEnv.SELFIMPROVING_DB_DRIVER === "pg";
    const pairs = I.buildAppEnv(app, {
      home: ctx.home, ports: ctx.ports, answers, exampleEnv,
      dbMode: isPg ? "pg" : "sqlite",
      pgUrls: {
        mind: oldEnv.MIND_DATABASE_URL || "",
        session: oldEnv.SESSION_DATABASE_URL || "",
        selfimproving: oldEnv.SELFIMPROVING_DATABASE_URL || "",
      },
    });
    for (const k of Object.keys(oldEnv)) if (pairs[k] === undefined) pairs[k] = oldEnv[k];
    const envPath = path.join(appDir, ".env");
    fs.writeFileSync(envPath, I.renderEnv(pairs), { mode: 0o600 });
    try { fs.chmodSync(envPath, 0o600); } catch (_e) {}
    written.push(app);
  }
  return written;
}

function stageRelease(args, home, srcDir) {
  const version = I.readVersion(srcDir);
  const releaseDir = path.join(H.releasesDir(home), version);
  if (fs.existsSync(releaseDir)) {
    // 2026-11-02（devops 线，dev 实测）：上次升级失败会留下半成品 releases/<v>，
    //   回滚只切 current、不清目录，于是**一次失败就永久卡死**（重试必撞"已存在"）。
    //   只要它不是当前的 current，就视为残留并清掉；是 current 才拒绝。
    let curTarget = "";
    try { curTarget = fs.readlinkSync(H.currentLink(home)); } catch (_e) {}
    if (curTarget === releaseDir) throw new Error("目标 release 已是 current: " + releaseDir);
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(releaseDir), { recursive: true });
  fs.cpSync(srcDir, releaseDir, { recursive: true, dereference: false, filter: (s) => { const b = path.basename(s); return b !== ".git" && b !== "node_modules"; } });
  return { version, releaseDir };
}
function generateAll(releaseDir, home) {
  const bin = path.join(releaseDir, "node_modules", ".bin", "prisma");
  if (!fs.existsSync(bin)) return false;
  for (const app of ["mind", "session", "selfimproving", "portal"]) {
    // 2026-11-02（devops 线，dev 实测）：open 版产物把 APPS 里的 portal 裁掉了，但这里硬编码了 portal，
    //   于是 APPS["portal"].dir 抛 "Cannot read properties of undefined (reading 'dir')"，
    //   升级在 apply 阶段失败并回滚。产物没有的 app 直接跳过。
    if (!APPS[app]) continue;
    const schema = path.join(releaseDir, APPS[app].dir, "prisma", "schema.prisma");
    if (!fs.existsSync(schema)) continue;
    const env = Object.assign({}, process.env, { DATABASE_URL: I.dbUrl(home, app) });
    I.run(bin, ["generate", "--schema=" + schema], { cwd: releaseDir, env });
    // 2026-10-21 双驱动：PG client 也要生成（否则升级后 mind 启动缺 mind-client-pg）。
    const pgSchema = path.join(releaseDir, APPS[app].dir, "prisma", "schema.postgres.prisma");
    if (fs.existsSync(pgSchema)) I.run(bin, ["generate", "--schema=" + pgSchema], { cwd: releaseDir, env });
  }
  return true;
}
function schemaHashFor(releaseDir, app, isPg) {
  const p = path.join(releaseDir, APPS[app].dir, "prisma", isPg ? "schema.postgres.prisma" : "schema.prisma");
  return fs.existsSync(p) ? sha256File(p) : null;
}
function schemaHash(releaseDir, app) { return schemaHashFor(releaseDir, app, false); }

/** 非空 PG 库的 db push 门禁：DROP>0 或 gap>0 一律拒绝。 */
function pgPushGuard(gap) {
  if (!gap || !gap.ok || gap.drops > 0) {
    const d = gap && Number.isFinite(gap.drops) ? gap.drops : "?";
    const g = gap && Array.isArray(gap.executable) ? gap.executable.length : "?";
    throw new Error("非空 PG 库拒绝 db push：DROP=" + d + " / gap=" + g + "（需要人工迁移，不能用 db push 删/改线上结构）");
  }
  return true;
}
function envPgUrl(releaseDir, app) {
  const keys = { mind: "MIND_DATABASE_URL", session: "SESSION_DATABASE_URL", selfimproving: "SELFIMPROVING_DATABASE_URL" };
  const envPath = path.join(releaseDir, APPS[app].dir, ".env");
  if (!fs.existsSync(envPath)) return "";
  try { const env = I.parseEnvFile(fs.readFileSync(envPath, "utf8")); return env[keys[app]] || env.DATABASE_URL || ""; } catch (_e) { return ""; }
}
async function migrate(args, home, oldRelease, newRelease, rec) {
  const bin = path.join(newRelease, "node_modules", ".bin", "prisma");
  const isPg = !!(rec && rec.dbMode === "pg");
  const done = [];
  for (const app of DB_APPS) {
    const schemaName = isPg ? "schema.postgres.prisma" : "schema.prisma";
    const schema = path.join(newRelease, APPS[app].dir, "prisma", schemaName);
    const env = Object.assign({}, process.env, { DATABASE_URL: I.dbUrl(home, app) });
    let url = "";
    if (isPg) {
      url = envPgUrl(oldRelease, app) || envPgUrl(newRelease, app) || process.env[({ mind: "MIND_DATABASE_URL", session: "SESSION_DATABASE_URL", selfimproving: "SELFIMPROVING_DATABASE_URL" })[app]] || "";
      if (!url) throw new Error("PG 升级缺 " + app + " 的 DATABASE_URL（旧 .env 与进程环境都没有）");
      env.DATABASE_URL = url;
      if (app === "mind") env.MIND_DATABASE_URL = url;
      if (app === "session") env.SESSION_DATABASE_URL = url;
      if (app === "selfimproving") env.SELFIMPROVING_DATABASE_URL = url;
    }
    const changed = schemaHashFor(oldRelease, app, isPg) !== schemaHashFor(newRelease, app, isPg);
    if (isPg) {
      // 非空 PG 库：只体检，不 db push。空库才允许 db push。
      if (!fs.existsSync(bin)) throw new Error("找不到 prisma（PG 升级需先装依赖）");
      const tables = await I.pgTableCount(url, newRelease);
      if (tables > 0) {
        const gap = await I.schemaGapCheck(bin, url, schema, newRelease, env);
        pgPushGuard(gap);
        done.push(app + ":pg-noop(drop=" + gap.drops + ",gap=" + gap.executable.length + ")");
      } else {
        // 2026-11-05：双保险——只有确认空库才允许 db push（空库没有可删的索引/结构）
        if (await I.pgTableCount(url, newRelease) > 0) throw new Error("拒绝 db push：目标库非空（" + app + "）");
        I.run(bin, ["db", "push", "--schema=" + schema, "--skip-generate"], { cwd: newRelease, env });
        done.push(app + ":dbpush-empty");
      }
    } else if (changed) {
      if (!fs.existsSync(bin)) throw new Error("找不到 prisma（schema 有变化，需先装依赖）");
      I.run(bin, ["db", "push", "--schema=" + schema, "--skip-generate"], { cwd: newRelease, env });
      done.push(app + ":dbpush");
    } else {
      done.push(app + ":unchanged");
    }
    if (!isPg) {
      for (const f of RAW_SQL[app] || []) {
        const sqlPath = path.join(path.dirname(schema), "migrations", f);
        if (!fs.existsSync(sqlPath)) continue;
        const dbFile = path.join(H.appDataDir(home, app), "dev.db");
        const script = "const fs=require('fs');try{const D=require(String(process.argv[1]));const db=new D(process.argv[2]);db.exec(fs.readFileSync(process.argv[3],'utf8'));db.close();}catch(e){process.exit(3);}";
        spawnSync(process.execPath, ["-e", script, path.join(newRelease, "node_modules", "better-sqlite3"), dbFile, sqlPath], { encoding: "utf8" });
      }
      for (const sql of RUNTIME_TABLES[app] || []) {
        const dbFile2 = path.join(H.appDataDir(home, app), "dev.db");
        const tmpSql = path.join(os.tmpdir(), "lions-rt-" + app + "-" + process.pid + ".sql");
        fs.writeFileSync(tmpSql, sql + ";\n");
        const sc = "const fs=require('fs');try{const D=require(String(process.argv[1]));const db=new D(process.argv[2]);db.exec(fs.readFileSync(process.argv[3],'utf8'));db.close();}catch(e){process.exit(3);}";
        spawnSync(process.execPath, ["-e", sc, path.join(newRelease, "node_modules", "better-sqlite3"), dbFile2, tmpSql], { encoding: "utf8" });
        try { fs.rmSync(tmpSql, { force: true }); } catch (_e) {}
      }
    }
  }
  return done;
}

async function healthAll(args, rec, ports) {
  const out = {};
  for (const app of START_ORDER) {
    // 2026-11-02（devops 线，dev 实测）：open 版没有 portal，但 START_ORDER 里有；
    //   旧实现会对 portal 的 14006 做健康检查并判红，把一次**成功的回滚**写成 ROLLBACK_FAILED
    //   （假失败比不判更危险：运维会以为回滚也坏了）。产物里没有的 app 一律跳过。
    if (!APPS[app]) continue;
    if (rec && rec.apps && !rec.apps[app]) continue;
    out[app] = await I.waitHealth(app, ports[app], 90000);
    log(args, "    " + (out[app].ok ? "✓" : "✗") + " " + app + " :" + ports[app]);
  }
  return out;
}

// 2026-11-05（0.4.29 车单 #8 / 方案 R1）同版本换包：
//   为什么需要：0.4.28 重打包后要覆盖 test，旧逻辑 toVersion==fromVersion 直接失败，
//   只能“先降级再升级”（当天实测多花 14 分钟，且中途服务是停的）。
//   为什么只比关键文件：这几样变了就说明不是同一个包；全一样时必须**拒绝**——
//   “修了个没坏的”不是修复，是把漂移掩盖掉。
const REPAIR_KEY_FILES = [
  "VERSION",
  "scripts/lions-service-wrapper.sh",
  "packages/apps/mind/.next/BUILD_ID",
  "packages/apps/console/.next/BUILD_ID",
  "packages/apps/session/.next/BUILD_ID",
  "packages/apps/selfimproving/.next/BUILD_ID",
];
function fileSha(p) { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch (_e) { return null; } }
function diffKeyFiles(a, b) {
  const out = [];
  for (const rel of REPAIR_KEY_FILES) {
    const x = fileSha(path.join(a, rel));
    const y = fileSha(path.join(b, rel));
    if (x !== y) out.push(rel + (x === null ? "(新包缺)" : "") + (y === null ? "(产物缺)" : ""));
  }
  return out;
}

async function doUpgrade(args) {
  const home = H.resolveHome({ home: typeof args.home === "string" ? args.home : undefined });
  const startedAt = new Date().toISOString();
  const rec = readInstall(home);
  const fromVersion = rec.version;
  const fromRelease = path.join(H.releasesDir(home), fromVersion);
  const steps = [];
  const fail = (step, detail) => { const e = new Error(detail); e.step = step; throw e; };
  const mark = (name, detail) => { steps.push({ name, ok: true, detail: detail || "" }); log(args, "[" + steps.length + "] " + name + (detail ? " — " + detail : "")); if (args["simulate-fail"] === name) fail(name, "simulated failure at " + name); };

  // 0 解析来源：--from 直接给；--source 支持 file:// 与 http(s)://（必要时下载 + 校验 sha256 + 可选验签）
  const resolved = await resolveSource(args);
  if (resolved.from) args.from = resolved.from;

  // 1 preflight
  if (!args.from && !args.check) fail("preflight", "缺少 --from=<tar|dir>（或 --check 只看可用版本）");
  const fromAbs = args.from ? path.resolve(String(args.from)) : null;
  if (fromAbs && !fs.existsSync(fromAbs)) fail("preflight", "产物不存在: " + fromAbs);
  let srcDir = fromAbs;
  let staging = null;
  const isTar = fromAbs && (fromAbs.endsWith(".tar.gz") || fromAbs.endsWith(".tgz"));
  if (isTar) { staging = fs.mkdtempSync(path.join(os.tmpdir(), "lions-upgrade-stage-")); I.run("tar", ["-xzf", fromAbs, "-C", staging]); srcDir = staging; }
  const toVersion = srcDir ? I.readVersion(srcDir) : null;
  // 2026-11-05（车单 #8）：同版本 -> 默认拒绝；--repair 只放行“树与产物确有差异”的那种，且不动库。
  const isRepair = !!args.repair;
  const sameVersion = !!(toVersion && toVersion === fromVersion);
  if (sameVersion && !isRepair) fail("preflight", "目标版本与当前相同: " + toVersion + "（同版本换包请加 --repair）");
  if (isRepair) {
    if (!sameVersion) fail("preflight", "--repair 只用于同版本换包（目标 " + toVersion + " != 当前 " + fromVersion + "）");
    const diff = diffKeyFiles(srcDir, fromRelease);
    if (!diff.length) fail("preflight", "--repair 被拒绝：树与产物一致（关键文件 0 处不同），没有可修的东西");
    // 裁决（2026-11-05）：树差异 -> 显式 tar sha + backup/ledger；失败回滚。
    //   repair 是“换包”，不是“省步骤”：备份不能被跳过，否则出问题没有回退点。
    if (args["skip-backup"]) fail("preflight", "--repair 不允许 --skip-backup（换包必须有备份/回滚点）");
    args["skip-migrate"] = true;   // 同版本换包不碰库：强制跳过（不靠调用方记得传 flag）
    const tarSha = isTar ? crypto.createHash("sha256").update(fs.readFileSync(fromAbs)).digest("hex") : "(dir)";
    mark("repair", "同版本换包；差异 " + diff.length + " 处: " + diff.slice(0, 3).join(" | ") + (diff.length > 3 ? " …" : "") + "；tar sha256=" + String(tarSha).slice(0, 16));
    args._repairTarSha = tarSha;
  }
  const fromEdition = rec.edition || (fromRelease && fs.existsSync(fromRelease) ? detectEdition(fromRelease) : null);
  const toEdition = srcDir ? detectEdition(srcDir) : null;
  const eg = editionGuard(fromEdition, toEdition, !!args["allow-edition-change"]);
  if (eg) fail("preflight", eg + "（许可变更需显式 --allow-edition-change）");
  const ports = rec.ports || {};
  // skip-units 安装没有自己的 systemdDir；升级/回滚不应去拉全局单元或等 5 个 app 健康。
  const noServices = !rec.systemdDir || !!args["skip-start"] || !!args["no-systemctl"];
  try { ensureToolsReplica(false); } catch (e) { fail("preflight", String(e.message)); }
  mark("preflight", fromVersion + " -> " + toVersion + "（" + (args["dry-run"] ? "dry-run" : "real") + "）");
  if (args["dry-run"]) { cleanupStaging(staging); return { ok: true, dryRun: true, from: fromVersion, to: toVersion, steps }; }

  // 2 backup
  const backupDir = path.join(H.backupsDir(home), ts());
  const backups = args["skip-backup"] ? [] : backupDbs(home, fromRelease, backupDir);
  mark("backup", backups.length + " 库 -> " + backupDir);
  evidence(home, { schema: SCHEMA, phase: "start", from: fromVersion, to: toVersion, fromEdition, toEdition, at: startedAt, backupDir, backups: backups.map((b) => ({ app: b.app, sha256: b.sha256 })) });

  // 3 stop
  stopUnits(args, rec);
  mark("stop", "服务已停（Restart=no drop-in 已写）");

  let switched = false;
  try {
    // 4 apply
    const staged = stageRelease(args, home, srcDir);
    // 2026-10-29 (商业化线): 升级解包可能丢可执行位；systemd 直接执行 wrapper，必须 0755。
    try { fs.chmodSync(path.join(staged.releaseDir, "scripts", "lions-service-wrapper.sh"), 0o755); } catch (_e) {}
    regenerateEnv({ home, ports, dbMode: rec.dbMode, answers: {} }, staged.releaseDir, fromRelease);
    if (!args["skip-deps"]) {
      const pnpm = I.resolvePnpm();
      if (!pnpm) throw new Error("缺 pnpm");
      const hasLock = fs.existsSync(path.join(staged.releaseDir, "pnpm-lock.yaml"));
      // 2026-10-27 (商业化线): open 导出没有 lockfile；不能再用 --frozen-lockfile。
      I.run(pnpm.cmd, pnpm.pre.concat(["install", hasLock ? "--frozen-lockfile" : "--no-frozen-lockfile"]), { cwd: staged.releaseDir });
    }
    if (!args["skip-generate"]) generateAll(staged.releaseDir, home);
    mark("apply", toVersion + " -> " + staged.releaseDir);

    // 5 migrate
    const mig = args["skip-migrate"] ? ["skipped"] : await migrate(args, home, fromRelease, staged.releaseDir, rec);
    mark("migrate", mig.join(","));

    // 6 build
    if (!args["skip-build"]) I.buildWorkspace({ home }, args, staged.releaseDir);
    mark("build", args["skip-build"] ? "skipped" : "workspace 已构建");

    // 7 switch + start + health
    I.linkCurrent(home, staged.releaseDir);
    // 2026-11-02（devops 线，test 实测）：升级不会重跑安装器的 <home>/scripts/macs-responder 软链，
    //   于是升完级 client/version 又变 500。这里在切换后补建（幂等）。
    try {
      const scriptsDir = path.join(home, "scripts");
      const link = path.join(scriptsDir, "macs-responder");
      fs.mkdirSync(scriptsDir, { recursive: true });
      if (!fs.existsSync(link)) fs.symlinkSync(path.join("..", "current", "scripts", "macs-responder"), link);
    } catch (_e) {}
    switched = true;
    startUnits(args, rec);
    mark("switch", "current -> " + toVersion);
    const health = noServices ? { skipped: true } : await healthAll(args, rec, ports);
    const healthy = health.skipped || Object.values(health).every((h) => h.ok);
    if (!healthy) fail("health", "上线后健康检查未通过");
    mark("health", health.skipped ? "skipped" : "全部通过");

    // 2026-11-05（P0 索引消失）：env 装完后补建会话首页的两个 perf 索引（幂等；缺才建）。
    // 为什么放这里：这两条索引是裸 SQL 建的、不在 schema 里，任何 db push/migrate 都可能把它清掉；
    // 装完立刻补一次，装完就是可用状态，不依赖人记得跑脚本。
    if (!args["skip-migrate"] && rec.dbMode === "pg") {
      const ensure = path.join(path.resolve(__dirname, ".."), "scripts", "apply-session-perf-indexes.cjs");
      if (fs.existsSync(ensure)) {
        const r = I.run(process.execPath, [ensure], { allowFail: true, cwd: path.resolve(__dirname, "..") });
        const tail = String((r.stdout || r.stdoutText || "")).trim().split("\n").slice(-1)[0] || "";
        mark("indexes", tail || "已尝试补建");
      }
    }

    rec.version = toVersion;
    rec.updatedAt = new Date().toISOString();
    rec.installedAt = rec.updatedAt;   // 2026-11-03：原来只改 version，installedAt 一直停在首次安装时间
    writeInstall(home, rec);
    mark("record", H.installRecordPath(home));
    evidence(home, { schema: SCHEMA, phase: "done", from: fromVersion, to: toVersion, verdict: "UPGRADED_OK", steps, at: new Date().toISOString(),
      oldPids: rec.oldPids || {}, newPids: rec.newPids || {}, unitsRestarted: rec.unitsRestarted === true });
    cleanupStaging(staging);
    return { ok: true, from: fromVersion, to: toVersion, steps, backupDir };
  } catch (e) {
    log(args, "  ✗ " + (e.step || "step") + " 失败: " + e.message + "；开始自动回滚…");
    // 2026-11-02（devops 线，dev 实测）：失败时 stageRelease 已经把新版本目录建出来了，
    //   但回滚只把 current 切回去、**没清半成品目录**；于是重试必然撞"目标 release 已存在"，
    //   升级变成"一次失败就永久卡死"。这里在回滚时把不属于 current 的半成品目录清掉。
    try {
      const stale = path.join(H.releasesDir(home), toVersion);
      let curTarget = "";
      try { curTarget = fs.readlinkSync(H.currentLink(home)); } catch (_e) {}
      if (toVersion && toVersion !== fromVersion && fs.existsSync(stale) && curTarget !== stale) {
        fs.rmSync(stale, { recursive: true, force: true });
        log(args, "  ↺ 已清理半成品目录: " + stale);
      }
    } catch (_e) {}
    // rollback
    try {
      stopUnits(args, rec);
      // PG 不会自动恢复（见 restoreDbs 注释）；这里把"没恢复"显式记进证据与日志，避免误以为已回滚。
      const restored = backups.length ? restoreDbs(home, backupDir) : [];
      const skippedDb = restored.filter((x) => x && x.skipped);
      if (skippedDb.length) {
        log(args, "  ⚠ 数据库未自动恢复（" + skippedDb.map((x) => x.app).join(",") + "）：PG 模式需显式 --rollback --restore-db");
      }
      I.linkCurrent(home, fromRelease);
      startUnits(args, rec);
      const health = noServices ? { skipped: true } : await healthAll(args, rec, ports);
      const healthy = health.skipped || Object.values(health).every((h) => h.ok);
      evidence(home, { schema: SCHEMA, phase: "rollback", from: toVersion, to: fromVersion, verdict: healthy ? "ROLLED_BACK_OK" : "ROLLBACK_FAILED", restored, reason: e.message, steps, at: new Date().toISOString() });
      cleanupStaging(staging);
      return { ok: false, rolledBack: healthy, from: fromVersion, to: toVersion, steps, error: e.message, backupDir };
    } catch (e2) {
      evidence(home, { schema: SCHEMA, phase: "rollback", verdict: "ROLLBACK_FAILED", reason: e.message, rollbackError: e2.message, steps, at: new Date().toISOString() });
      cleanupStaging(staging);
      return { ok: false, rolledBack: false, from: fromVersion, to: toVersion, steps, error: e.message, rollbackError: e2.message };
    }
  }
}

function cleanupStaging(staging) { if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_e) {} } }

async function check(args) {
  const home = H.resolveHome({ home: typeof args.home === "string" ? args.home : undefined });
  const rec = readInstall(home);
  let source = typeof args.source === "string" ? args.source : null;
  if (!source) {
    const cp = H.channelPath(home);
    if (fs.existsSync(cp)) { try { source = JSON.parse(fs.readFileSync(cp, "utf8")).source; } catch (_e) {} }
  }
  const result = { current: rec.version, source: source || null, available: null, updateAvailable: false, summary: null, notes: null };
  if (source && source.startsWith("file://")) {
    const dir = source.slice("file://".length);
    const latest = path.join(dir, "latest.json");
    if (fs.existsSync(latest)) { const idx = JSON.parse(fs.readFileSync(latest, "utf8")); result.available = idx.version; result.summary = idx.summary || null; result.notes = idx.notes || null; result.availableEdition = idx.edition || null; }
    else {
      const cands = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^lions-.*\.manifest\.json$/.test(f)) : [];
      if (cands.length) { const f = cands.sort().pop(); result.available = f.replace(/^lions-(.*)\.manifest\.json$/, "$1"); try { const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); result.summary = m.summary || null; result.notes = m.notes || null; } catch (_e) {} }
    }
    result.updateAvailable = !!result.available && result.available !== rec.version;
  }
  if (source && (source.startsWith("http://") || source.startsWith("https://"))) {
    try {
      const idx = JSON.parse(await httpGetText(source.replace(/\/$/, "") + "/latest.json"));
      result.available = idx.version;
      result.availableEdition = idx.edition || null;
      result.summary = idx.summary || null;
      result.notes = idx.notes || null;
      result.updateAvailable = !!result.available && result.available !== rec.version;
    } catch (e) {
      result.error = String(e.message || e);
    }
  }
  return result;
}

/**
 * --rollback：把安装根退回上一版本（2026-11-02，devops 线）。
 *
 * 为什么单独实现：usage 里早就写了 --rollback，但 main 从来没有对应分支（实测），
 *   于是"一条命令回滚"只存在于文档里。而生产回滚是最需要**可执行**的动作。
 *
 * 语义（保守）：
 *   - 默认只回滚**代码**（current 指向旧 release）+ 重启 + 健康检查；
 *   - 数据库默认**不动**（PG 上 DROP SCHEMA 风险过高），需显式 --restore-db 才恢复；
 *   - 目标版本默认取"最近一次成功升级记录里的 from"，可用 --to 覆盖；
 *   - 全程写 upgrade-evidence.jsonl。
 */
async function rollbackCmd(args) {
  const home = H.resolveHome({ home: typeof args.home === "string" ? args.home : undefined });
  const rec = readInstall(home);
  const cur = rec.version;
  let target = typeof args.to === "string" ? args.to : "";
  if (!target) {
    const evPath = path.join(H.logsDir(home), "upgrade-evidence.jsonl");
    if (fs.existsSync(evPath)) {
      const rows = fs.readFileSync(evPath, "utf8").split("\n").filter(Boolean).map((s) => { try { return JSON.parse(s); } catch (_e) { return null; } }).filter(Boolean);
      const last = rows.filter((e) => e.phase === "done" && e.to === cur).pop();
      if (last) target = last.from;
    }
  }
  if (!target) throw new Error("找不到上一版本（无升级记录）；用 --to=<version> 指定");
  if (target === cur) throw new Error("目标版本与当前相同: " + target);
  const targetRelease = path.join(H.releasesDir(home), target);
  if (!fs.existsSync(targetRelease)) throw new Error("目标 release 不存在: " + targetRelease);
  let bk = typeof args.backup === "string" ? path.resolve(args.backup) : "";
  if (!bk && args["restore-db"]) {
    const root = H.backupsDir(home);
    if (fs.existsSync(root)) {
      const dirs = fs.readdirSync(root).map((d) => ({ d, p: path.join(root, d) })).filter((x) => { try { return fs.statSync(x.p).isDirectory(); } catch (_e) { return false; } });
      dirs.sort((a, b) => fs.statSync(b.p).mtimeMs - fs.statSync(a.p).mtimeMs);
      if (dirs.length) bk = dirs[0].p;
    }
  }
  const ports = rec.ports || {};
  const noServices = !rec.systemdDir || !!args["skip-start"] || !!args["no-systemctl"];
  const steps = [];
  const mark = (n, d) => { steps.push({ name: n, ok: true, detail: d || "" }); log(args, "[" + steps.length + "] " + n + (d ? " — " + d : "")); };
  stopUnits(args, rec);
  mark("stop", noServices ? "no-systemctl" : "已停");
  const restored = bk ? restoreDbs(home, bk, { restorePg: !!args["restore-db"] }) : [];
  const skipped = restored.filter((x) => x && x.skipped);
  if (skipped.length) log(args, "  ⚠ 库未恢复（" + skipped.map((x) => x.app).join(",") + "）：加 --restore-db 才恢复 PG");
  mark("restore-db", bk ? (restored.length + " 个" + (skipped.length ? "（" + skipped.length + " 跳过）" : "")) : "未指定备份，跳过");
  I.linkCurrent(home, targetRelease);
  mark("switch", cur + " -> " + target);
  rec.version = target; rec.updatedAt = new Date().toISOString();
  writeInstall(home, rec);
  mark("record", H.installRecordPath(home));
  startUnits(args, rec);
  const health = noServices ? { skipped: true } : await healthAll(args, rec, ports);
  const healthy = health.skipped || Object.values(health).every((h) => h.ok);
  mark("health", health.skipped ? "skipped" : (healthy ? "全部通过" : "未通过"));
  evidence(home, { schema: SCHEMA, phase: "manual-rollback", from: cur, to: target, verdict: healthy ? "ROLLED_BACK_OK" : "ROLLBACK_FAILED", restored, steps, at: new Date().toISOString(),
    oldPids: rec.oldPids || {}, newPids: rec.newPids || {}, unitsRestarted: rec.unitsRestarted === true });
  return { ok: healthy, rolledBack: healthy, from: cur, to: target, steps, restored };
}

function renderCheck(r) {
  const L = [];
  L.push("当前版本: " + (r.current || "未知"));
  L.push("可用版本: " + (r.available || "未知") + (r.updateAvailable ? "  ← 有更新" : "（已是最新）"));
  if (r.summary) L.push("本次摘要: " + r.summary);
  if (r.notes) { L.push(""); L.push("本次说明:"); L.push(String(r.notes).trim()); }
  if (r.error) L.push("检查出错: " + r.error);
  return L.join("\n");
}

function runSelftest() {
  const results = [];
  const assert = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail || "" });
  const throws = (fn) => { try { fn(); return false; } catch (_e) { return true; } };
  assert("parseArgv", parseArgv(["--home=/x", "--from", "--dry-run"]).home === "/x");
  assert("pgPushGuard 空 diff 放行", pgPushGuard({ ok: true, drops: 0, executable: [] }) === true);
  assert("pgPushGuard gap 拒绝", throws(() => pgPushGuard({ ok: false, drops: 0, executable: ["CREATE TABLE"] })));
  assert("pgPushGuard DROP 拒绝", throws(() => pgPushGuard({ ok: true, drops: 20, executable: [] })));
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "lions-ug-ed-"));
  fs.mkdirSync(path.join(fx, "packages/apps/mind"), { recursive: true });
  assert("detectEdition=open", detectEdition(fx) === "open");
  // 2026-11-04：portal 已开源，不再作为闭源标记（open 包合法含 portal）
  fs.mkdirSync(path.join(fx, "packages/apps/portal"), { recursive: true });
  assert("detectEdition: 仅 portal 仍判 open（portal 已开源）", detectEdition(fx) === "open");
  fs.mkdirSync(path.join(fx, "packages/apps/mcp-agent-chat-server"), { recursive: true });
  assert("detectEdition=sales（mcp-agent-chat-server 为闭源标记）", detectEdition(fx) === "sales");
  assert("editionGuard 一致放行", editionGuard("open", "open", false) === null && editionGuard("sales", "sales", false) === null);
  assert("editionGuard 不一致拦截", (editionGuard("open", "sales", false) || "").indexOf("不一致") >= 0);
  assert("editionGuard 显式放行", editionGuard("open", "sales", true) === null);
  fs.rmSync(fx, { recursive: true, force: true });
  assert("check 渲染含新版本与说明", renderCheck({ current: "0.1.0", available: "0.2.0", updateAvailable: true, summary: "sum", notes: "notes-line" }).indexOf("0.2.0") >= 0 && renderCheck({ current: "0.1.0", available: "0.2.0", updateAvailable: true, summary: "sum", notes: "notes-line" }).indexOf("notes-line") >= 0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lions-upgrade-selftest-"));
  try {
    fs.mkdirSync(path.join(tmp, "logs"), { recursive: true });
    evidence(tmp, { a: 1 });
    const lines = fs.readFileSync(path.join(tmp, "logs", "upgrade-evidence.jsonl"), "utf8").trim().split("\n");
    assert("evidence 追加 JSONL", JSON.parse(lines[0]).a === 1);
    fs.mkdirSync(path.join(tmp, "data", "mind"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "data", "mind", "dev.db"), "x");
    fs.mkdirSync(path.join(tmp, "backup", "mind"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "backup", "mind", "dev.db"), "y");
    const restored = restoreDbs(tmp, path.join(tmp, "backup"));
    assert("restoreDbs 覆盖（sqlite）", restored.some((x) => x.app === "mind" && x.restored) && fs.readFileSync(path.join(tmp, "data", "mind", "dev.db"), "utf8") === "y");
    // PG 模式：未显式授权时必须 reported-as-skipped，而不是静默通过
    fs.writeFileSync(path.join(tmp, "install.json"), JSON.stringify({ schema: "lions-install/1", version: "1.0.0", dbMode: "pg", apps: {} }));
    fs.writeFileSync(path.join(tmp, "backup", "mind.sql"), "-- dump\n");
    const pgSkip = restoreDbs(tmp, path.join(tmp, "backup"));
    assert("restoreDbs PG 未授权时显式 skipped", pgSkip.some((x) => x.app === "mind" && x.skipped), JSON.stringify(pgSkip));
    const ud = path.join(tmp, "units");
    writeDropIn(ud, "lions-mind.service", true);
    assert("drop-in 写入", fs.readFileSync(path.join(ud, "lions-mind.service.d", "10-upgrade-maintenance.conf"), "utf8").indexOf("Restart=no") >= 0);
    writeDropIn(ud, "lions-mind.service", false);
    assert("drop-in 移除", !fs.existsSync(path.join(ud, "lions-mind.service.d", "10-upgrade-maintenance.conf")));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // 2026-11-05（车单 #8 / R1）：同版本换包的“树 vs 产物”判定必须两向都对——
  //   一致 -> 差异 0（调用方据此拒绝）；不一致 -> 差异 >0（才允许 repair）。
  const ra = fs.mkdtempSync(path.join(os.tmpdir(), "lions-ug-repair-a-"));
  const rb = fs.mkdtempSync(path.join(os.tmpdir(), "lions-ug-repair-b-"));
  try {
    fs.mkdirSync(path.join(ra, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(rb, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(ra, "VERSION"), "0.4.28\n");
    fs.writeFileSync(path.join(rb, "VERSION"), "0.4.28\n");
    assert("repair: 树与产物一致 -> 差异 0（必须拒绝）", diffKeyFiles(ra, rb).length === 0);
    fs.writeFileSync(path.join(rb, "VERSION"), "0.4.29\n");
    assert("repair: 版本文件不同 -> 差异 1", diffKeyFiles(ra, rb).length === 1);
    fs.writeFileSync(path.join(rb, "VERSION"), "0.4.28\n");
    fs.writeFileSync(path.join(ra, "scripts/lions-service-wrapper.sh"), "a");
    assert("repair: wrapper 不同 -> 差异 1", diffKeyFiles(ra, rb).length === 1);
  } finally { fs.rmSync(ra, { recursive: true, force: true }); fs.rmSync(rb, { recursive: true, force: true }); }
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + (r.detail ? " :: " + r.detail : ""));
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad === 0 ? "SELFTEST OK (" + results.length + " 断言)" : "SELFTEST FAILED (" + bad + ")");
  process.exit(bad === 0 ? 0 : 1);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.selftest) return runSelftest();
  if (!args.home) { console.error("缺少 --home=DIR"); process.exit(3); }
  if (args.rollback) {
    try {
      const rb = await rollbackCmd(args);
      if (args.json) process.stdout.write(JSON.stringify(rb, null, 2) + "\n");
      else console.log((rb.ok ? "ROLLED_BACK_OK" : "ROLLBACK_FAILED") + "  " + rb.from + " -> " + rb.to);
      process.exit(rb.ok ? 0 : 1);
    } catch (e) {
      console.error("ROLLBACK FAILED: " + (e && e.message || e));
      process.exit(1);
    }
  }
  try {
    if (args.check) { const r = await check(args); if (args.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n"); else console.log(renderCheck(r)); process.exit(0); }
    const report = await doUpgrade(args);
    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    console.error("UPGRADE FAILED: " + e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { parseArgv, backupDbs, restoreDbs, writeDropIn, schemaHash, schemaHashFor, pgPushGuard, check, doUpgrade, SCHEMA };
