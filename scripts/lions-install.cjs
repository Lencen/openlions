#!/usr/bin/env node
/**
 * lions-install.cjs — 把发布产物装成一个可运行实例（产品化 S0-1）
 * =====================================================================
 *
 * 做什么（阶段可独立跳过，便于分级验证）:
 *   1 preflight  环境/依赖/磁盘/端口检查（不过就在装任何东西前退出并给修复命令）
 *   2 stage      取产物（tar 或目录）→ releases/<version>
 *   3 dirs       建 data/ config/ logs/ run/ backups/
 *   4 config     从 .env.example + answers 生成各 app .env（DATABASE_URL 指向 data/，0600）
 *   5 deps       pnpm install
 *   6 generate   prisma generate（各含 schema 的 app）
 *   7 db         建空库（mind: migrate deploy；session/selfimproving: db push；session 再补 raw SQL）
 *   8 units      生成并安装 systemd --user 单元 → daemon-reload → enable --now
 *   9 health     按 app profile 轮询健康路径
 *   10 record    写 install.json
 *
 * 用法:
 *   node scripts/lions-install.cjs --from=<tar|dir> --home=<dir> [--answers=<json>]
 *     [--systemd-dir=DIR] [--edition=open|sales] [--dry-run] [--json] [--force-units] [--force-release]
 *     [--skip-deps] [--skip-generate] [--skip-db] [--skip-units] [--skip-start]
 *     [--port-<app>=N]...
 *   node scripts/lions-install.cjs --selftest
 *
 * 安全:
 *   - 绝不指向既有库：DATABASE_URL 一律写成本安装根的 data/<app>/dev.db 绝对路径；
 *     若目标库已存在则默认拒绝 db push（除非 --force-db）。
 *   - 已存在同名 unit 默认不覆盖（保护用户手改）。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawnSync, execFileSync } = require("child_process");
const H = require("./lib/lions-home.cjs");
const { APPS, START_ORDER } = require("./lib/lions-apps.cjs");
const U = require("./lib/lions-units.cjs");
const { RUNTIME_TABLES, RUNTIME_TABLES_PG } = require("./lib/lions-runtime-tables.cjs");

const SCHEMA = "lions-install/1";
// 新装空库一律用 `db push`：
//   2026-10-15 实测：mind 的 11 个 migration 无法从空库 bootstrap（20260717_v16_task_improvement_fields
//   会报 `no such table: Task` —— 因为最早的 Task 表历史上是 db push 建的、不在 migration 里）。
//   空库上 db push 是安全的（无数据可丢），且会建出 schema.prisma 的完整当前结构。
//   注意：运行期自建表（Todo/Discussion/lost_and_found）由应用启动时创建；升级时 db push 只在 schema 变化时才跑，
//   且总是先备份（见 lions-upgrade.cjs）。
const DB_MODES = { mind: "push", session: "push", selfimproving: "push" };
const RAW_SQL = { session: ["v2_fts5.sql", "v3_multi_source_sync.sql"] };

// D8: 取值型参数必须同时支持 --k=v 与 --k v 两种形式（selftest 各断言一次）。
const VALUE_FLAGS = new Set(["from", "home", "systemd-dir", "unit-prefix", "edition", "db", "answers",
  "model-base-url", "model-key", "model-name", "reflect-model", "model-provider"]);
function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([A-Za-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (!m) { out._.push(a); continue; }
    if (m[2] !== undefined) { out[m[1]] = m[2]; continue; }
    if (VALUE_FLAGS.has(m[1]) && argv[i + 1] !== undefined && !/^--/.test(argv[i + 1])) { out[m[1]] = argv[++i]; continue; }
    out[m[1]] = true;
  }
  return out;
}

function run(cmd, args, opts) {
  opts = opts || {};
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const res = { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
  if (r.status !== 0 && !opts.allowFail) {
    const e = new Error(cmd + " " + args.join(" ") + " 失败(status=" + r.status + "): " + (r.stderr || r.stdout || r.error));
    e.result = res;
    throw e;
  }
  return res;
}

function nodeMajor() { return Number(process.versions.node.split(".")[0]); }

/** 解析可用的 pnpm 入口：PATH 上的 pnpm，否则 corepack pnpm（仓库用 packageManager 固定版本）。 */
function resolvePnpm() {
  let r = run("pnpm", ["--version"], { allowFail: true });
  if (r.status === 0) return { cmd: "pnpm", pre: [], version: r.stdout.trim() };
  r = run("corepack", ["pnpm", "--version"], { allowFail: true });
  if (r.status === 0) return { cmd: "corepack", pre: ["pnpm"], version: r.stdout.trim() };
  return null;
}

function pnpmArgs(pnpm, args) { return pnpm.pre.concat(args); }

function diskFreeBytes(p) {
  try { const s = fs.statfsSync(p); return s.bavail * s.bsize; } catch (_e) { return -1; }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["\']|["\']$/g, "");
  }
  return out;
}

function renderEnv(pairs) {
  const keys = Object.keys(pairs).sort();
  return "# 由 lions-install 生成（产品化 S0-1）；手工修改后请勿再跑安装覆盖\n" +
    keys.map((k) => k + "=" + pairs[k]).join("\n") + "\n";
}

function readJsonIfExists(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_e) { return null; }
}

function readVersion(dir) {
  const vf = path.join(dir, "VERSION");
  if (fs.existsSync(vf)) return fs.readFileSync(vf, "utf8").trim();
  const pj = readJsonIfExists(path.join(dir, "package.json"));
  return (pj && pj.version) || "0.0.0";
}

// 2026-11-04：portal 公共页已加入开源；edition 只按 MACS / mcp-server / doc-portal 判定。
const CLOSED_PACKAGES = ["packages/apps/mcp-agent-chat-server", "packages/apps/mcp-server", "packages/apps/doc-portal"];
function detectEdition(releaseDir) {
  const present = CLOSED_PACKAGES.filter((p) => fs.existsSync(path.join(releaseDir, p)));
  return present.length > 0 ? "sales" : "open";
}
/** 明确指定时必须与产物一致（fail-closed：open 不得含闭源，sales 必须含闭源）。 */
function resolveEdition(releaseDir, explicit) {
  const detected = detectEdition(releaseDir);
  if (explicit && explicit !== detected) throw new Error("edition 冲突：声明 " + explicit + " 但产物是 " + detected + "（许可隔离校验失败）");
  return explicit || detected;
}

function defaultPorts(overrides) {
  const ports = {};
  for (const app of START_ORDER) ports[app] = APPS[app].port;
  return Object.assign(ports, overrides || {});
}

function parsePortOverrides(args) {
  const out = {};
  for (const k of Object.keys(args)) {
    const m = /^port-([a-z]+)$/.exec(k);
    if (m) out[m[1]] = Number(args[k]);
  }
  return out;
}

/** 组装每个 app 的 .env 键值（纯函数，供 selftest）。 */
function pgUrlFor(ctx, app) {
  return (ctx && ctx.pgUrls && ctx.pgUrls[app]) || "";
}

function buildAppEnv(app, ctx) {
  const profile = APPS[app];
  const base = {};
  const example = ctx.exampleEnv || {};
  const answers = ctx.answers || {};
  Object.assign(base, example);
  const isPg = ctx && ctx.dbMode === "pg";
  if (isPg) {
    // 2026-10-27 (商业化线): A 方案。三个 app 各连自己的 PG 库；
    //   mind 用 MIND_DATABASE_URL（prisma.ts 的 fail-closed 依据），
    //   session/selfimproving 用各自 URL；所有 app 都能看到 mind URL（console/portal 只读）。
    const m = pgUrlFor(ctx, "mind");
    const s = pgUrlFor(ctx, "session");
    const si = pgUrlFor(ctx, "selfimproving");
    base.MIND_DB_DRIVER = "pg";
    if (app === "session") base.SESSION_DB_DRIVER = "pg";
    if (app === "selfimproving") base.SELFIMPROVING_DB_DRIVER = "pg";
    if (m) base.MIND_DATABASE_URL = m;
    if (s) base.SESSION_DATABASE_URL = s;
    if (si) base.SELFIMPROVING_DATABASE_URL = si;
    if (profile.hasDatabase) base.DATABASE_URL = pgUrlFor(ctx, app) || "";
  } else if (profile.hasDatabase) {
    base.DATABASE_URL = "file:" + path.join(H.appDataDir(ctx.home, app), "dev.db");
  }
  base.PORT = String(ctx.ports[app]);
  base.LIONS_MIND_URL = "http://127.0.0.1:" + ctx.ports.mind;
  base.MIND_API_URL = "http://127.0.0.1:" + ctx.ports.mind;
  base.LIONS_TASK_URL = "http://127.0.0.1:" + ctx.ports.selfimproving;
  base.LIONS_SESSION_API_BASE = "http://127.0.0.1:" + ctx.ports.session;
  base.LIONS_HOME = ctx.home;
  // 运行期路径统一走 env（2026-10-15 去硬编码）：代码里以 LIONS_HOME 为兜底，这里显式给全。
  base.LIONS_REPO = path.join(ctx.home, "current");
  base.LIONS_MIND_DB = path.join(ctx.home, "data", "mind", "dev.db");
  base.MIND_DB_PATH = base.LIONS_MIND_DB;
  base.LIONS_SESSION_DB = path.join(ctx.home, "data", "session", "dev.db");
  base.LIONS_GOALS_FILE = path.join(ctx.home, "current", "docs", "platform-logic", "goals.md");
  base.LIONS_ADR_DIR = path.join(ctx.home, "current", "docs", "architecture", "adr");
  base.LIONS_LOGIC_DOCS = path.join(ctx.home, "current", "docs", "platform-logic");
  // 2026-11-02（前端线，开源清理配套）：console 的 agent-permissions 曾把 11 个 agent 的
  //   user@内网地址与 root@内网段 硬编码在源码里；现在改为两条配置，代码里只留安全默认。
  //   默认必须是**无害值**：环回前缀 + 空 target 表（解析不到就明确报错，不静默连内网）。
  //   实际值走 answers 或环境变量注入（部署方自己知道内网拓扑）。
  // 2026-11-04（开源接入闭环）：多 agent 注册/领取钥匙/客户端发布签名都依赖部署级密钥。
  //   以前这些键只在生产 .env 里手工配置，开源新装没有 -> 接入向导 500、客户端发布 500。
  if ((app === "mind" || app === "console" || app === "portal") && ctx.secrets) {
    if (ctx.secrets.MIND_BOOTSTRAP_API_KEY) base.MIND_BOOTSTRAP_API_KEY = ctx.secrets.MIND_BOOTSTRAP_API_KEY;
    if (ctx.secrets.MIND_ADMIN_API_KEY && app !== "portal") base.MIND_ADMIN_API_KEY = ctx.secrets.MIND_ADMIN_API_KEY;
  }
  if (app === "mind" && ctx.secrets && ctx.secrets.LIONS_SIGNING_KEY_PATH) {
    base.LIONS_SIGNING_KEY_PATH = ctx.secrets.LIONS_SIGNING_KEY_PATH;
  }
  if (app === "portal") {
    base.LIONS_CONSOLE_URL = "http://127.0.0.1:" + ctx.ports.console;
    base.LIONS_PORTAL_URL = "http://127.0.0.1:" + ctx.ports.portal;
  }
  if (app === "console") {
    if (APPS.portal && ctx.ports.portal) base.LIONS_PORTAL_URL = "http://127.0.0.1:" + ctx.ports.portal;
    base.AGENT_HOST_PREFIX = answers.AGENT_HOST_PREFIX || process.env.AGENT_HOST_PREFIX || "127.0.0.1";
    base.AGENT_SSH_TARGETS = answers.AGENT_SSH_TARGETS || process.env.AGENT_SSH_TARGETS || "";
    // 2026-11-02（0.4.3 切流事故）：console 的 /api/system/comm（通讯录/协同）读 HERMES_MCP_API_KEY，
    //   切流后 env 缺该键 -> 401 -> 通讯录静默变空（数据在，页面空）。
    //   **密钥绝不写默认值**：只从 answers / 进程环境来；两者都没有就不写这个键（fail-closed，宁可 401 也不写假值）。
    const hermes = answers.HERMES_MCP_API_KEY || process.env.HERMES_MCP_API_KEY || "";
    if (hermes) base.HERMES_MCP_API_KEY = hermes;
  }
  // 2026-11-02 (env.local 覆盖调查): 生成模型配置**不再由安装器写入** .env。
  //   原因: 安装器曾把 MINIMAX_API_KEY/ANTHROPIC_* 反复写进各 app .env，覆盖 dev 的 .env.local 选择，
  //   且让发布 env 与“谁的模型”耦合。模型只走本机 override 文件 (.env.local) 或部署方显式注入。
  //   answers 里的 model-* 仍解析，但 buildAppEnv 不消费，避免安装器再成为模型配置源。
  return base;
}

function dbUrl(home, app, ctx) {
  if (ctx && ctx.dbMode === "pg") return pgUrlFor(ctx, app);
  return "file:" + path.join(H.appDataDir(home, app), "dev.db");
}

// 模型配置通道（路线图 §1.2 / §12.3）：answers 文件 + CLI 直传；绝不写默认 key。
const MODEL_FLAG_MAP = { "model-base-url": "ANTHROPIC_BASE_URL", "model-key": "ANTHROPIC_AUTH_TOKEN", "model-name": "ANTHROPIC_MODEL", "reflect-model": "REFLECT_MODEL" };
function loadAnswers(args) {
  const answers = {};
  const fromFile = typeof args.answers === "string" ? readJsonIfExists(path.resolve(args.answers)) : null;
  if (fromFile) Object.assign(answers, fromFile);
  for (const flag of Object.keys(MODEL_FLAG_MAP)) if (typeof args[flag] === "string" && args[flag]) answers[MODEL_FLAG_MAP[flag]] = args[flag];
  const provider = typeof args["model-provider"] === "string" ? args["model-provider"] : "";
  if (provider === "minimax") { if (args["model-key"]) answers.MINIMAX_API_KEY = answers.MINIMAX_API_KEY || String(args["model-key"]); if (!answers.ANTHROPIC_BASE_URL) answers.ANTHROPIC_BASE_URL = "https://api.minimax.chat/v1"; }
  if (provider === "anthropic" && !answers.ANTHROPIC_BASE_URL) answers.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
  return answers;
}

function log(msg, args) { if (args.json) console.error(msg); else console.log(msg); }

async function preflight(args, ctx) {
  const problems = [];
  const notes = [];
  if (nodeMajor() < 20) problems.push("Node 版本过低: " + process.versions.node + "（要求 >= 20）");
  const pnpm = resolvePnpm();
  if (!pnpm && !args["skip-deps"]) problems.push("缺 pnpm（可用 corepack: corepack pnpm --version；或 corepack enable）");
  else if (pnpm) notes.push((pnpm.cmd === "corepack" ? "corepack pnpm " : "pnpm ") + pnpm.version);
  if (ctx.dbMode === "sqlite") {
    // 显式选了遗留路径：不阻断，但必须说清楚代价（否则又是一次"装完才发现跑不起来"）。
    notes.push("dbMode=sqlite（遗留/测试路径）: 开源版按 docs/productization/OPEN-EDITION-DB-DECISION-2026-10-27.md " +
      "采用方案 A（要求 PostgreSQL），应用侧是 PG-only —— sqlite 装出来的实例可能 build/启动失败。默认已是 pg。");
  }
  if (ctx.dbMode === "pg") {
    const need = ["mind", "session", "selfimproving"];
    const miss = need.filter((a) => !pgUrlFor(ctx, a));
    // dry-run + 介质引导：--plan 不建库/不返回 URL，不能因此判缺 URL；真实安装才会填入。
    //   仅当介质里**确实有 pg/** 才豁免；普通 dry-run（无 PG 介质）仍必须 fail-fast。
    const fromDir = String(args.from || "").endsWith(".tar.gz") || String(args.from || "").endsWith(".tgz")
      ? "" : path.resolve(String(args.from || "."));
    const hasMediaPg = !!fromDir && fs.existsSync(path.join(fromDir, "pg"));
    const dryRunBootstrap = args["dry-run"] && ctx.pgBoot && ctx.pgBoot !== "off" && hasMediaPg;
    if (miss.length && !dryRunBootstrap) problems.push("PG 模式缺 URL: " + miss.map((a) => a + " (MIND_DATABASE_URL/SESSION_DATABASE_URL/SELFIMPROVING_DATABASE_URL)").join(", ") +
      " —— 开源版默认要求 PostgreSQL 14+（见 OPEN-EDITION-DB-DECISION-2026-10-27.md 方案 A）；仅遗留/测试可 --db=sqlite");
    if (!miss.length) {
      let PgMod = null;
      try { PgMod = pgClient(); } catch (_e) { notes.push("PG 连通性预检跳过（pg 模块未装，装后由 initDb 实测）"); }
      const Client = PgMod ? PgMod.Client : null;
      for (const app of Client ? need : []) {
        const u = pgUrlFor(ctx, app);
        const c = new Client({ connectionString: u });
        try {
          await c.connect(); await c.query("select 1");
          // 2026-11-09（github-maintenance-line 在 100 机踩到）：--pg-bootstrap=off 走"已有 PG"时
          //   历史上不建 pg_trgm，而 schema 的 GIN 索引要 gin_trgm_ops -> db push 直接失败。
          //   这里先查，缺则尝试建；建不了就前置报错并给可执行命令，不要等到 [10] db 才炸。
          let hasTrgm = false;
          try { const r0 = await c.query("select 1 from pg_extension where extname='pg_trgm'"); hasTrgm = (r0.rowCount || 0) > 0; } catch (_e) {}
          if (!hasTrgm) {
            try { await c.query("CREATE EXTENSION IF NOT EXISTS pg_trgm"); hasTrgm = true; notes.push("PG " + app + " 已建扩展 pg_trgm"); }
            catch (e2) {
              problems.push("PG " + app + " 缺扩展 pg_trgm 且当前账号无权创建（Prisma GIN 索引需要 gin_trgm_ops）：" +
                "请用有权限的账号执行 CREATE EXTENSION pg_trgm（见 docs/productization/PG-MEDIA.md §已有 PG）");
            }
          }
          if (hasTrgm) notes.push("PG " + app + " 可连接");
        }
        catch (e) { problems.push("PG " + app + " 连接失败: " + String(e && e.message || e).slice(0, 160)); }
        finally { try { await c.end(); } catch (_e) {} }
      }
    }
  }
  if (String(args.from).endsWith(".tar.gz") || String(args.from).endsWith(".tgz")) {
    const tar = run("tar", ["--version"], { allowFail: true });
    if (tar.status !== 0) problems.push("缺 tar");
  }
  const free = diskFreeBytes(ctx.homeParentExists ? ctx.home : os.homedir());
  if (free >= 0 && free < 5 * 1024 * 1024 * 1024) problems.push("磁盘可用空间不足 5GB: " + (free / 1073741824).toFixed(1) + "GB");
  if (!args["skip-units"] && !args["no-systemctl"]) {
    const sc = run("systemctl", ["--user", "show-environment"], { allowFail: true });
    if (sc.status !== 0) notes.push("systemd --user 不可用（将跳过服务启动）");
  }
  if (!args["skip-start"] && !args["skip-units"]) {
    for (const app of START_ORDER) {
      const p = ctx.ports[app];
      const freePort = await isPortFree(p);
      if (!freePort) problems.push("端口被占用: " + p + "（" + app + "）；用 --port-" + app + "=<其它端口> 或先释放");
    }
  }
  return { problems, notes };
}

function stage(args, ctx) {
  const fromAbs = path.resolve(String(args.from));
  if (!fs.existsSync(fromAbs)) throw new Error("产物不存在: " + fromAbs);
  const isTar = fromAbs.endsWith(".tar.gz") || fromAbs.endsWith(".tgz");
  let srcDir = fromAbs;
  let staging = null;
  if (isTar) {
    staging = fs.mkdtempSync(path.join(os.tmpdir(), "lions-install-stage-"));
    run("tar", ["-xzf", fromAbs, "-C", staging]);
    srcDir = staging;
  }
  const version = readVersion(srcDir);
  const releaseDir = path.join(H.releasesDir(ctx.home), version);
  const result = { version, releaseDir, staging, srcDir };
  if (args["dry-run"]) return result;
  if (fs.existsSync(releaseDir) && !args["force-release"]) throw new Error("release 已存在: " + releaseDir + "（--force-release 覆盖）");
  const srcAbs = path.resolve(srcDir);
  if (!isTar && (releaseDir + path.sep).startsWith(srcAbs + path.sep)) throw new Error("产物目录不能位于安装目标内（会自我递归）: " + srcAbs);
  fs.mkdirSync(path.dirname(releaseDir), { recursive: true });
  if (isTar) {
    try { fs.renameSync(staging, releaseDir); }
    catch (_e) { fs.cpSync(staging, releaseDir, { recursive: true }); fs.rmSync(staging, { recursive: true, force: true }); }
  } else {
    fs.cpSync(srcDir, releaseDir, {
      recursive: true,
      dereference: false,
      filter: (s) => { const b = path.basename(s); return b !== ".git" && b !== "node_modules"; },
    });
  }
  return result;
}

function ensureDirs(home) {
  for (const d of [H.releasesDir(home), H.dataDir(home), H.configDir(home), H.logsDir(home), H.runDir(home), H.backupsDir(home)]) fs.mkdirSync(d, { recursive: true });
  for (const app of START_ORDER) if (APPS[app].hasDatabase) fs.mkdirSync(H.appDataDir(home, app), { recursive: true });
}

/** 原子切换 current 软链 -> 该版本代码根（升级时同一操作换代码）。 */
function linkCurrent(home, releaseDir) {
  const link = H.currentLink(home);
  const tmp = link + ".tmp-" + process.pid;
  try { fs.rmSync(tmp); } catch (_e) {}
  fs.symlinkSync(releaseDir, tmp, "dir");
  fs.renameSync(tmp, link);
}

/**
 * 为"每个部署"生成专属 macs 服务端密钥（HERMES_MCP_API_KEY / MCP_JWT_SECRET）。
 * 目的：解决"所有客户共用同一把"——发布包不含密钥（*.env 被排除），安装时本地生成、0600、不共享。
 */
function ensureMacsEnv(releaseDir, args) {
  const dir = path.join(releaseDir, "packages", "apps", "mcp-agent-chat-server");
  if (!fs.existsSync(dir)) return null;
  const envPath = path.join(dir, ".macs.env");
  if (fs.existsSync(envPath) && !args["force-secrets"]) return { envPath, generated: false };
  const content = [
    "# 本部署专属密钥（安装器自动生成；禁止入库/跨部署共用）",
    "HERMES_MCP_API_KEY=" + crypto.randomBytes(32).toString("hex"),
    "MCP_JWT_SECRET=" + crypto.randomBytes(32).toString("hex"),
    "SOP_VERSION_REQUIRED=1.2",
    "",
  ].join("\n");
  if (args["dry-run"]) return { envPath, generated: false, dryRun: true };
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch (_e) {}
  return { envPath, generated: true };
}

/**
 * 每部署生成接入/发布密钥（2026-11-04，开源接入闭环）。
 *   - MIND_BOOTSTRAP_API_KEY：/agents/onboard 注册 agent 的准入 key（不再要求生产 key）；
 *   - MIND_ADMIN_API_KEY：客户端发布/撤销等管理端点；
 *   - Ed25519 客户端签名密钥：$LIONS_HOME/config/signing/lions-client-signing.pem（0600），
 *     key_id = sha256(raw 32B 公钥) 前 16 位；与生产 key 完全隔离，安装器只打印 key_id。
 * 幂等：已存在的键/私钥一律沿用，重装不轮换。
 */
function ensureInstallSecrets(home, args) {
  const dir = path.join(home, "config");
  const file = path.join(dir, "install-secrets.json");
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_e) { s = {}; }
  let changed = false;
  const gen = (prefix) => prefix + crypto.randomBytes(24).toString("hex");
  if (!s.MIND_BOOTSTRAP_API_KEY) { s.MIND_BOOTSTRAP_API_KEY = gen("sk-bootstrap-"); changed = true; }
  if (!s.MIND_ADMIN_API_KEY) { s.MIND_ADMIN_API_KEY = gen("sk-admin-"); changed = true; }
  const signingDir = path.join(dir, "signing");
  const pem = path.join(signingDir, "lions-client-signing.pem");
  if (!s.LIONS_SIGNING_KEY_PATH) { s.LIONS_SIGNING_KEY_PATH = pem; changed = true; }
  if (!fs.existsSync(pem)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    fs.mkdirSync(signingDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(pem, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const der = publicKey.export({ type: "spki", format: "der" });
    const raw = der.subarray(der.length - 32);
    fs.writeFileSync(path.join(signingDir, "lions-client-signing.pub"), raw, { mode: 0o644 });
    const fp = crypto.createHash("sha256").update(raw).digest("hex");
    fs.writeFileSync(path.join(signingDir, "lions-client-signing.fingerprint"), fp + "\n", { mode: 0o644 });
    s.LIONS_SIGNING_KEY_ID = fp.slice(0, 16);
    changed = true;
  }
  if (changed && !args["dry-run"]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  }
  return s;
}

function writeConfig(ctx, args, releaseDir) {
  const written = [];
  for (const app of START_ORDER) {
    const appDir = path.join(releaseDir, APPS[app].dir);
    // 2026-10-27 开源安装实测(商业化线): open 版不含 portal/macs 等闭源包；
    //   旧实现仍按 START_ORDER 给 portal 写 .env -> ENOENT，open 版装不上。
    //   目录不存在 = 该版本不含此 app，跳过而不是失败。
    if (!fs.existsSync(appDir)) { written.push({ app, skipped: true, reason: "not in release" }); continue; }
    const examplePath = path.join(appDir, ".env.example");
    const exampleEnv = fs.existsSync(examplePath) ? parseEnvFile(fs.readFileSync(examplePath, "utf8")) : {};
    const pairs = buildAppEnv(app, { home: ctx.home, ports: ctx.ports, answers: ctx.answers, exampleEnv, dbMode: ctx.dbMode, pgUrls: ctx.pgUrls, secrets: ctx.secrets });
    const envPath = path.join(appDir, ".env");
    if (args["dry-run"]) { written.push({ app, envPath, keys: Object.keys(pairs).length }); continue; }
    fs.writeFileSync(envPath, renderEnv(pairs), { mode: 0o600 });
    try { fs.chmodSync(envPath, 0o600); } catch (_e) {}
    written.push({ app, envPath, keys: Object.keys(pairs).length });
  }
  return written;
}

// 2026-10-28 开源安装实测: PG 模式需要 pg，但开源导出的根 node_modules 未必有（pg 在 console/selfimproving 的 deps 里）。
//   从 release/app 目录解析，避免"源码根没装依赖 -> 安装器直接挂"。
function pgClient(releaseDir) {
  const bases = [
    releaseDir, path.join(releaseDir || "", "packages/apps/console"), path.join(releaseDir || "", "packages/apps/selfimproving"),
    process.cwd(), path.join(process.cwd(), "packages/apps/console"), path.join(process.cwd(), "packages/apps/selfimproving"),
  ].filter(Boolean);
  for (const b of bases) {
    try { return require(require.resolve("pg", { paths: [b] })); } catch (_e) {}
  }
  throw new Error("找不到 pg 模块（PG 模式需要 pg）：请先在安装源根 pnpm install");
}
function prismaBin(releaseDir, app) {
  // 2026-10-27 开源安装实测(商业化线): pnpm workspace 把 prisma 装在**各 app** 的 node_modules/.bin，
  //   根 node_modules/.bin 只有 tsc/eslint/prettier。旧实现只查根 -> open 版 generate/db 必失败。
  const root = path.join(releaseDir, "node_modules", ".bin", "prisma");
  if (fs.existsSync(root)) return root;
  if (app) {
    const appBin = path.join(releaseDir, APPS[app].dir, "node_modules", ".bin", "prisma");
    if (fs.existsSync(appBin)) return appBin;
  }
  return null;
}

/**
 * 纯函数：非空 PG 库是否必须拒绝 db push（供 selftest 断言）。
 *   空库 -> 放行；非空且「有缺口 / 有 DROP / 体检失败」-> 拒绝。
 *   注意：--force-db **不是"允许删表"的开关**，DROP>0 永远拒绝。
 */
function pgDbPushDecision({ tableCount, gap }) {
  if (!tableCount || Number(tableCount) <= 0) return { refuse: false, why: "空库，允许初始化" };
  const drops = gap && Number.isFinite(gap.drops) ? gap.drops : -1;
  const exec = gap && Array.isArray(gap.executable) ? gap.executable.length : -1;
  if (!gap || !gap.ok || drops > 0 || exec > 0) return { refuse: true, why: "DROP=" + drops + " gap=" + exec };
  return { refuse: false, why: "无缺口（db push 为 no-op）" };
}

async function initDb(app, ctx, args, releaseDir) {
  const isPg = ctx.dbMode === "pg";
  const schema = path.join(releaseDir, APPS[app].dir, "prisma", isPg ? "schema.postgres.prisma" : "schema.prisma");
  const url = dbUrl(ctx.home, app, ctx);
  const dbFile = isPg ? null : path.join(H.appDataDir(ctx.home, app), "dev.db");
  const env = Object.assign({}, process.env, { DATABASE_URL: url });
  if (isPg) {
    if (app === "mind") env.MIND_DATABASE_URL = url;
    if (app === "session") env.SESSION_DATABASE_URL = url;
    if (app === "selfimproving") env.SELFIMPROVING_DATABASE_URL = url;
  }
  const bin = prismaBin(releaseDir, app);
  if (!bin) throw new Error("找不到 prisma 可执行文件（先装依赖）");
  if (!isPg && fs.existsSync(dbFile) && !args["force-db"]) throw new Error("目标库已存在，拒绝初始化: " + dbFile + "（--force-db 覆盖）");
  if (!fs.existsSync(schema)) throw new Error("找不到 schema: " + schema + "（该版本不支持 " + ctx.dbMode + "）");
  const mode = DB_MODES[app] || "push";
  // 2026-11-02（总调度授权）：把"非空 PG 库是否拒绝 db push"抽成纯函数，便于 selftest 断言。
  //   判据方向：DROP>0 或 有缺口 或 体检失败 => 拒绝；空库放行。**force-db 不放行 DROP**（那是删表）。
  const pgTables = isPg ? await pgTableCount(url, releaseDir) : 0;
  if (isPg && pgTables > 0) {
    // 2026-11-02（devops 线，实测 + mind-line-3 结论）：
    //   **已有库绝不能跑 db push**。线上库有一批"库里有、schema 里没有"的运行时表
    //   （Todo / SessionExtractionState / AcceptanceVerdict / *Archive 等 20 张），
    //   db push 会把它们判为多余并 DROP —— 实测会删 20 张表（含 1.9 万行真实数据）。
    //   改为**只做体检、不执行 DDL**：算 diff，DROP>0 或 gap>0 一律拒绝（与 SQLite force-db 对齐）。
    const gap = await schemaGapCheck(bin, url, schema, releaseDir, env);
    const decision = pgDbPushDecision({ tableCount: pgTables, gap });
    if (decision.refuse) throw new Error("已有 PG 库拒绝 db push：" + decision.why + "（不会自动改库；需人工迁移）\n" + (gap.executable || []).join("\n"));
    console.log("        [schema-gap] " + app + ": 缺口 " + gap.executable.length + " 条 / 无害 " + (gap.benign || 0) + " 条 / DROP " + gap.drops + " 条（已有库只体检、不执行任何 DDL）");
  } else if (mode === "migrate" && !isPg) {
    run(bin, ["migrate", "deploy", "--schema=" + schema], { cwd: releaseDir, env });
  } else {
    run(bin, ["db", "push", "--schema=" + schema, "--skip-generate"], { cwd: releaseDir, env });
  }
  if (!isPg) {
    // raw SQL（如 session 的 FTS5 / SyncWatermark）在 schema 建好之后应用；PG 版不适用 SQLite raw SQL。
    for (const f of RAW_SQL[app] || []) {
      const sqlPath = path.join(path.dirname(schema), "migrations", f);
      if (!fs.existsSync(sqlPath)) continue;
      run(process.execPath, ["-e", "const fs=require('fs');const p=process.argv[1];" +
        "let db;try{throw new Error('SQLITE_RETIRED');}catch(e){console.error('SQLite 已退役(2026-10-26)，请改用 PG');process.exit(3);}" +
        "db.exec(fs.readFileSync(p,'utf8'));db.close();", sqlPath, dbFile], { cwd: releaseDir, env, allowFail: true });
    }
    // Prisma schema 之外的运行期表（Todo/Discussion 等）—— 否则新装 mind 健康 503。
    for (const sql of RUNTIME_TABLES[app] || []) {
      const tmpSql = path.join(os.tmpdir(), "lions-runtime-" + app + "-" + process.pid + ".sql");
      fs.writeFileSync(tmpSql, sql + ";\n");
      // 2026-10-27 开源安装实测(商业化线): 运行期表不需要 better-sqlite3（pnpm 不保证根/app 都有），
      //   Node 22 自带 node:sqlite 可直接打开 Prisma 建的 SQLite 库；用它消除原生依赖。
      const script = "const fs=require('fs');const {DatabaseSync}=require('node:sqlite');try{const db=new DatabaseSync(process.argv[1]);db.exec(fs.readFileSync(process.argv[2],'utf8'));db.close();}catch(e){console.error(e.message);process.exit(3);}";
      const rr = run(process.execPath, ["--no-warnings", "-e", script, dbFile, tmpSql], { cwd: releaseDir, allowFail: true });
      try { fs.rmSync(tmpSql, { force: true }); } catch (_e) {}
      if (rr.status !== 0) throw new Error("运行期表初始化失败(" + app + "): " + (rr.stderr || "").slice(0, 200));
    }
  } else {
    // PG 运行期表：Todo/Discussion 不在 Prisma schema 里；用 RUNTIME_TABLES_PG（CamelCase 引号 + BIGINT）。
    const { Client } = pgClient(releaseDir);
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      for (const sql of RUNTIME_TABLES_PG[app] || []) await c.query(sql);
    } finally { try { await c.end(); } catch (_e) {} }
  }
  return { dbFile, url, mode, dbMode: ctx.dbMode };
}

/**
 * 工作区整体构建。**必须分两阶段**（2026-10-15 实测）：
 *   app 用 webpack alias 指向 workspace 包的 dist（如 mind/console 的 @lions/events），但 pnpm -r 的并行/顺序
 *   不保证"别名库"先于 app 构建；一旦某个 app 先跑，就会因 dist 缺失失败并 aborts 整个递归构建，
 *   导致库根本没被构建。故：阶段1 只构建 apps 之外的库，阶段2 再构建全部（含 apps）。
 */
/** 已有库探测：public schema 下有几张表。 */
async function pgTableCount(url, releaseDir) {
  try {
    const { Client } = pgClient(releaseDir);
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      const r = await c.query("select count(*)::int as n from information_schema.tables where table_schema='public'");
      return (r.rows[0] && r.rows[0].n) || 0;
    } finally { try { await c.end(); } catch (_e) {} }
  } catch (_e) { return 0; }
}

/** 把 prisma migrate diff 的输出拆成语句（去掉注释与空串）。 */
function splitSqlStatements(script) {
  const noComments = String(script || "").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  return noComments.split(";").map((s) => s.trim()).filter(Boolean);
}

/**
 * 已有库的 schema 体检（**不执行任何 DDL**）。
 * 返回 { ok, executable, drops }：executable = 过滤掉 DROP 后剩余的可执行语句。
 * ok 的条件是 executable.length === 0 —— 即"库已完整具备交付 schema 的结构，无需任何变更"。
 */
/**
 * 把 diff 语句分成三类（**判据方向很关键**）：
 *   - drop：库里有、交付 schema 里没有 —— 对已有库是**正常**的（运行时/归档表），只是记录，不阻塞；
 *   - benign：DROP INDEX / ALTER COLUMN ... SET DEFAULT —— 不影响数据、不影响旧代码读取，记录即可；
 *   - gap：**交付 schema 需要、库里没有或结构不符**（CREATE TABLE / ADD COLUMN / 类型变更 / SET NOT NULL）
 *          —— 这才是真缺口：切过去后代码会查询不存在的表/列。
 * ok 的条件是 gap.length === 0。
 */
function classifySchemaDiff(script) {
  const stmts = splitSqlStatements(script);
  const drop = [];
  const benign = [];
  const gap = [];
  for (const s of stmts) {
    if (/^DROP\s+TABLE/i.test(s) || /^DROP\s+SCHEMA/i.test(s)) { drop.push(s); continue; }
    if (/^DROP\s+/i.test(s)) { drop.push(s); continue; }
    if (/^ALTER TABLE .* ALTER COLUMN .* SET DEFAULT /i.test(s)) { benign.push(s); continue; }
    if (/^CREATE (UNIQUE )?INDEX/i.test(s)) { benign.push(s); continue; }
    gap.push(s);
  }
  return { drop, benign, gap, statements: stmts.length };
}

async function schemaGapCheck(bin, url, schema, releaseDir, env) {
  const r = spawnSync(bin, ["migrate", "diff", "--from-url", url, "--to-schema-datamodel", schema, "--script"], { cwd: releaseDir, env, encoding: "utf8" });
  if (r.status !== 0) return { ok: false, executable: ["migrate diff 失败: " + String(r.stderr || "").slice(0, 300)], drops: 0, benign: 0 };
  const c = classifySchemaDiff(r.stdout);
  return { ok: c.gap.length === 0, executable: c.gap, drops: c.drop.length, benign: c.benign.length, statements: c.statements };
}

function buildWorkspace(ctx, args, releaseDir) {
  const pnpm = ctx.pnpm || resolvePnpm();
  if (!pnpm) throw new Error("缺 pnpm（构建需要）");
  const env = Object.assign({}, process.env, { NEXT_TELEMETRY_DISABLED: "1", NODE_OPTIONS: "--max-old-space-size=3072" });
  if (ctx.dbMode === "pg") {
    env.MIND_DB_DRIVER = "pg";
    env.SESSION_DB_DRIVER = "pg";
    env.SELFIMPROVING_DB_DRIVER = "pg";
    env.MIND_DATABASE_URL = pgUrlFor(ctx, "mind");
    env.SESSION_DATABASE_URL = pgUrlFor(ctx, "session");
    env.SELFIMPROVING_DATABASE_URL = pgUrlFor(ctx, "selfimproving");
  }
  const base = ["-r", "--workspace-concurrency=1"];
  run(pnpm.cmd, pnpmArgs(pnpm, base.concat(["--filter", "./packages/**", "--filter", "!./packages/apps/**", "build"])), { cwd: releaseDir, env });
  run(pnpm.cmd, pnpmArgs(pnpm, base.concat(["build"])), { cwd: releaseDir, env });
}

function buildApp(app, ctx, args, releaseDir) {
  const appDir = path.join(releaseDir, APPS[app].dir);
  const nextBin = path.join(appDir, "node_modules", ".bin", "next");
  const fallback = path.join(releaseDir, "node_modules", ".bin", "next");
  const bin = fs.existsSync(nextBin) ? nextBin : fallback;
  if (!fs.existsSync(bin)) throw new Error("找不到 next 可执行文件（先装依赖）: " + app);
  const env = Object.assign({}, process.env, {
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: "--max-old-space-size=" + (APPS[app].nodeHeapMiB || 3072),
    DATABASE_URL: dbUrl(ctx.home, app, ctx),
  });
  if (ctx.dbMode === "pg") {
    env.MIND_DB_DRIVER = "pg";
    env.SESSION_DB_DRIVER = "pg";
    env.SELFIMPROVING_DB_DRIVER = "pg";
    env.MIND_DATABASE_URL = pgUrlFor(ctx, "mind");
    env.SESSION_DATABASE_URL = pgUrlFor(ctx, "session");
    env.SELFIMPROVING_DATABASE_URL = pgUrlFor(ctx, "selfimproving");
  }
  run(bin, ["build"], { cwd: appDir, env });
  return { app, appDir };
}

async function waitHealth(app, port, timeoutMs) {
  const paths = APPS[app].healthPaths || ["/"];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of paths) {
      const ok = await new Promise((resolve) => {
        const req = require("http").get({ host: "127.0.0.1", port, path: p, timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500); });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      });
      if (ok) return { ok: true, path: p };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, path: paths.join(",") };
}

async function install(args) {
  const home = H.resolveHome({ home: typeof args.home === "string" ? args.home : undefined });
  const ports = defaultPorts(parsePortOverrides(args));
  const answers = loadAnswers(args);
  // 2026-11-03（W45 SQLite 退役）：默认从 sqlite 改为 pg。
  //   依据 docs/productization/OPEN-EDITION-DB-DECISION-2026-10-27.md：方案 A（开源版要求 PostgreSQL）已在
  //   2026-10-27 采用，文中明确"不把 SQLite 作为交付路径""不建议 B"，且实测该文档 §6 记录
  //   "应用是 PG-only，build/启动要求 MIND_DATABASE_URL" —— 也就是说 sqlite 默认装出来的实例
  //   建得了库但**跑不起来**，是个陷阱默认值。
  //   sqlite 仍可显式 --db=sqlite（遗留/测试），但会打印警告。
  const dbMode = args.db === "sqlite" ? "sqlite" : "pg";
  const pgUrls = {
    mind: process.env.MIND_DATABASE_URL || "",
    session: process.env.SESSION_DATABASE_URL || "",
    selfimproving: process.env.SELFIMPROVING_DATABASE_URL || "",
  };
  // ── A2（2026-11-03）：PG 作为介质的一部分 ────────────────────────────────────
  //   默认 dbMode=pg 之后，"没装 PG"就成了新装的第一道坎。若介质里带了 pg/（compose 或 deb），
  //   这里先把它拉起来并建库，再把三个 URL 填进 ctx —— 用户不必手工装 PG。
  //   开关：--pg-bootstrap=auto（默认，介质里有才动）/ compose / deb / off。
  //   --dry-run 只打印计划，不启动容器、不装包、不建库。
  const pgBoot = String(args["pg-bootstrap"] || "auto");
  let pgBootNote = "";
  if (dbMode === "pg" && Object.values(pgUrls).some((u) => !u) && pgBoot !== "off") {
    const media = path.resolve(String(args.from || "."));
    const bootScript = path.join(__dirname, "pg-bootstrap.cjs");
    const bootArgv = [bootScript, "--media=" + media];
    bootArgv.push(args["dry-run"] ? "--plan" : "--apply");
    if (pgBoot !== "auto") bootArgv.push("--mode=" + pgBoot);
    try {
      const r = spawnSync(process.execPath, bootArgv, { encoding: "utf8", timeout: 600000 });
      const out = String(r.stdout || "");
      const err = String(r.stderr || "");
      if (r.status === 0) {
        if (args["dry-run"]) {
          pgBootNote = "PG 介质引导（dry-run 计划）: " + (out.split("\n").filter((l) => l.trim()).slice(0, 3).join(" | ") || "ok");
        } else {
          const j = (() => { try { return JSON.parse(out.slice(out.indexOf("{"))); } catch { return null; } })();
          if (j && j.urls) {
            pgUrls.mind = j.urls.mind; pgUrls.session = j.urls.session; pgUrls.selfimproving = j.urls.selfimproving;
            pgBootNote = "PG 介质引导完成（mode=" + j.mode + "，端口 " + j.port + "），URL 已写入 " + j.urlsFile;
          } else { pgBootNote = "PG 介质引导完成（未解析到 urls）"; }
        }
      } else {
        pgBootNote = "PG 介质引导未执行（介质无 pg/ 或失败）: " + (err || out).trim().replace(/\s+/g, " ").slice(0, 200);
      }
    } catch (e) { pgBootNote = "PG 介质引导异常: " + String(e && e.message || e).slice(0, 160); }
  }
  const ctx = { home, ports, answers, dbMode, pgUrls, pgBoot, homeParentExists: fs.existsSync(path.dirname(home)), pnpm: resolvePnpm() };
  const report = { schema: SCHEMA, home, ports, steps: [], dryRun: !!args["dry-run"] };
  const step = (name, detail) => { report.steps.push({ name, detail }); log("[" + (report.steps.length) + "] " + name + (detail ? " — " + detail : ""), args); };

  const pf = await preflight(args, ctx);
  if (pgBootNote) pf.notes.push(pgBootNote);   // A2：把介质引导结果并进 preflight 摘要，便于一眼判断
  step("preflight", pf.notes.join(" / ") || "ok");
  if (pf.problems.length) {
    report.ok = false; report.preflightProblems = pf.problems;
    if (!args.json) { console.error("前置检查未通过，未做任何修改:"); for (const p of pf.problems) console.error("  ✗ " + p); }
    return report;
  }
  if (args["dry-run"]) {
    const srcVersion = readVersion(path.resolve(String(args.from)));
    step("plan", "将安装 " + srcVersion + " 到 " + path.join(H.releasesDir(home), srcVersion));
    report.ok = true;
    return report;
  }
  const staged = stage(args, ctx);
  ctx.releaseDir = staged.releaseDir;
  step("stage", staged.version + " -> " + staged.releaseDir);
  staged.edition = resolveEdition(staged.releaseDir, args.edition);
  step("edition", staged.edition);
  ensureDirs(home);
  linkCurrent(home, staged.releaseDir);
  // 2026-11-02（devops 线，四环境实测）：应用把 LIONS_HOME 当**仓库根**用，
  //   会取 <LIONS_HOME>/scripts/macs-responder/CLIENT_VERSION（客户端自更新版本源）。
  //   安装根的 scripts/ 只有备份脚本，于是 /api/v1/flywheel/client/version 恒 500
  //   （dev/test/prod/主平台四处都中招）。这里把发布包里的 macs-responder 挂进安装根。
  try {
    const scriptsDir = path.join(home, "scripts");
    const link = path.join(scriptsDir, "macs-responder");
    fs.mkdirSync(scriptsDir, { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(path.join("..", "current", "scripts", "macs-responder"), link);
  } catch (_e) {}
  step("dirs", "data/config/logs/run/backups 就绪；current -> releases/" + staged.version);
  ctx.secrets = ensureInstallSecrets(home, args);
  step("secrets", "接入/发布密钥就绪（bootstrap/admin/签名；签名 key_id=" + String(ctx.secrets.LIONS_SIGNING_KEY_ID || "existing") + "）");
  const cfg = writeConfig(ctx, args, staged.releaseDir);
  step("config", cfg.length + " 个 .env（0600）");
  // 2026-10-29 (商业化线): 导出/打包可能丢可执行位；systemd 直接执行 wrapper，664 会 203/EXEC。
  try { fs.chmodSync(path.join(staged.releaseDir, "scripts", "lions-service-wrapper.sh"), 0o755); } catch (_e) {}
  const macsEnv = ensureMacsEnv(staged.releaseDir, args);
  if (macsEnv) step("macs-secrets", macsEnv.generated ? "已生成本部署专属密钥（0600）" : "沿用既有 .macs.env");
  if (!args["skip-deps"]) {
    const pnpm = ctx.pnpm || resolvePnpm();
    if (!pnpm) throw new Error("缺 pnpm：请先 corepack enable，或安装 pnpm");
    // 2026-10-27 开源安装实测(商业化线): open 导出有意删掉 pnpm-lock.yaml（避免闭源包进入锁文件），
    //   旧实现无条件 --frozen-lockfile -> 必然 ERR_PNPM_LOCKFILE_CONFIG_MISMATCH。
    //   有锁才 frozen（可复现），无锁用 no-frozen（能装上）；两者都在日志里显式说明。
    const hasLock = fs.existsSync(path.join(staged.releaseDir, "pnpm-lock.yaml"));
    run(pnpm.cmd, pnpmArgs(pnpm, ["install", hasLock ? "--frozen-lockfile" : "--no-frozen-lockfile"]), { cwd: staged.releaseDir });
    step("deps", hasLock ? "pnpm install 完成（frozen lock）" : "pnpm install 完成（无锁文件，no-frozen）");
  }
  if (!args["skip-generate"]) {
    let generated = 0;
    for (const app of ["mind", "session", "selfimproving", "portal"].filter((a) => APPS[a])) {
      const schema = path.join(staged.releaseDir, APPS[app].dir, "prisma", "schema.prisma");
      if (!fs.existsSync(schema)) continue;
      const bin = prismaBin(staged.releaseDir, app);
      if (!bin) continue;
      const env = Object.assign({}, process.env, { DATABASE_URL: dbUrl(home, app, ctx) });
      if (ctx.dbMode === "pg") { env.MIND_DB_DRIVER = "pg"; env.MIND_DATABASE_URL = pgUrlFor(ctx, "mind"); env.SESSION_DATABASE_URL = pgUrlFor(ctx, "session"); env.SELFIMPROVING_DATABASE_URL = pgUrlFor(ctx, "selfimproving"); }
      run(bin, ["generate", "--schema=" + schema], { cwd: staged.releaseDir, env });
      // 2026-10-21 双驱动：PG client 也要生成（开源版默认 SQLite，但 mind 静态 import 了 mind-client-pg）。
      const pgSchema = path.join(staged.releaseDir, APPS[app].dir, "prisma", "schema.postgres.prisma");
      if (fs.existsSync(pgSchema)) run(bin, ["generate", "--schema=" + pgSchema], { cwd: staged.releaseDir, env });
      generated++;
    }
    step("generate", generated ? ("prisma 客户端已生成（" + generated + " app）") : "跳过：未找到 prisma 可执行文件");
  }
  if (!args["skip-db"]) {
    const dbs = [];
    for (const app of START_ORDER) {
      if (!APPS[app].hasDatabase) continue;
      dbs.push(app);
      await initDb(app, ctx, args, staged.releaseDir);
    }
    step("db", dbs.join(",") + " 已建空库");
  }
  // 2026-11-04（open 接入闭环）：新库的 AgentService 是空的，onboard 向导会"注册成功但没有可用服务"。
  //   种两条开源版必需服务（幂等；已有行不覆盖）。
  if (ctx.dbMode === "pg" && !args["skip-db"]) {
    try {
      const { Client } = pgClient(staged.releaseDir);
      const c = new Client({ connectionString: pgUrlFor(ctx, "mind") });
      await c.connect();
      const rows = [
        ["lions_mind", "LIONS Mind", "共享记忆/知识/反思/技能", "http://127.0.0.1:" + ctx.ports.mind,
          JSON.stringify(["memory.read", "memory.write", "knowledge.read", "knowledge.write", "reflection.write", "skill.read"])],
        ["lions_session", "LIONS Session", "会话上传与同步", "http://127.0.0.1:" + ctx.ports.session,
          JSON.stringify(["session.upload", "session.read"])],
      ];
      for (const [name, display, desc, endpoint, perms] of rows) {
        await c.query(
          'INSERT INTO "AgentService" (id,name,display_name,description,endpoint,version,status,enabled,available_perms,idempotent,created_at,updated_at) ' +
          "VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',true,$7,false,now(),now()) ON CONFLICT (name) DO NOTHING",
          ["svc_" + crypto.randomBytes(8).toString("hex"), name, display, desc, endpoint, staged.version, perms]
        );
      }
      await c.end();
      step("services", "lions_mind / lions_session 已就绪");
    } catch (e) {
      step("services", "种服务失败（onboard 会没有可用服务）：" + String(e && e.message || e).slice(0, 160));
    }
  }
  if (!args["skip-build"]) {
    buildWorkspace(ctx, args, staged.releaseDir);
    step("build", "workspace 已构建（core/modules 先 tsc，apps 再 next build，串行）");
    // 2026-11-04（open 业务看板）：先生成一份快照，页面首次打开就有数；
    //   失败不阻断安装（页面会显示可操作提示），但要把原因记进 step。
    try {
      const rep = path.join(staged.releaseDir, "scripts", "flywheel-business-report.cjs");
      if (fs.existsSync(rep)) {
        run(process.execPath, [rep, "--hours=24", "--write", "--quiet"], {
          cwd: staged.releaseDir,
          env: Object.assign({}, process.env, {
            LIONS_HOME: home,
            MIND_DATABASE_URL: pgUrlFor(ctx, "mind") || process.env.MIND_DATABASE_URL || "",
            MIND_DB_DRIVER: "pg",
          }),
        });
        step("business-snapshot", "已生成 run/flywheel-business-snapshot-latest.json");
      }
    } catch (e) {
      step("business-snapshot", "未生成（页面会显示提示）：" + String(e && e.message || e).slice(0, 160));
    }
  }
  let unitsResult = null;
  let hasMacs = false;
  if (!args["skip-units"]) {
    const systemdDir = typeof args["systemd-dir"] === "string" ? path.resolve(args["systemd-dir"]) : path.join(os.homedir(), ".config", "systemd", "user");
    const plan = U.planUnits(home, { systemdDir, portOverrides: ports, modeOverrides: null, unitPrefix: args["unit-prefix"] });
    unitsResult = U.writeUnits(plan, { force: !!args["force-units"] });
    report.units = { written: unitsResult.written.map((u) => u.unit), skipped: unitsResult.skipped.map((u) => u.unit), systemdDir };
    // 2026-10-30（devops 三环境 P1-5）：PG 模式生成/接管 PG unit 并写进 install record。
    //   --pg-data-dir 给出时才生成（集群已存在）；否则只接管已存在的 unit，不覆盖。
    if (ctx.dbMode === "pg") {
      const pgDir = typeof args["pg-data-dir"] === "string" ? path.resolve(args["pg-data-dir"]) : null;
      const pgPlan = U.planPgUnit(home, { systemdDir, unitPrefix: args["unit-prefix"], dataDir: pgDir || undefined, port: Number(args["pg-port"]) || 5432 });
      if (pgDir) {
        U.writeUnits([pgPlan], { force: !!args["force-units"] });
        report.units.pgUnit = pgPlan.unit;
        if (!args["no-systemctl"] && !args["skip-start"]) run("systemctl", ["--user", "enable", "--now", pgPlan.unit], { allowFail: true });
        step("pg-unit", "生成 " + pgPlan.unit + "（" + pgPlan.path + "）");
      } else if (fs.existsSync(pgPlan.path)) {
        report.units.pgUnit = pgPlan.unit;
        step("pg-unit", "接管已存在 " + pgPlan.unit + "（不覆盖）");
      }
    }
    if (!args["no-systemctl"]) {
      run("systemctl", ["--user", "daemon-reload"], { allowFail: true });
      if (!args["skip-start"]) {
        for (const u of plan) run("systemctl", ["--user", "enable", "--now", u.unit], { allowFail: true });
      }
    }
    step("units", unitsResult.written.length + " 写入 / " + unitsResult.skipped.length + " 跳过（" + systemdDir + "）");

    // 2026-10-27（商业化线 P0，fail-closed）：MACS 安全加固必须由**主安装器**自动套用，
    //   否则设计伙伴跑 lions-install 之后 MACS 仍是裸的（"文件在、没人调用"）。
    //   仅当本平台的 macs 应用存在时执行；失败即整体失败，不允许"安装成功但 MACS 裸奔"。
    const macsPort = ports && ports.macs ? ports.macs : 8765;
    // MACS 不在 APPS 的五个服务里（现状），但 release 里带了它就必须装：
    //   否则设计伙伴装完没有 MACS 服务，更谈不上 90/91。判定按产物是否存在，不按 APPS 名单。
    const macsStart = path.join(staged.releaseDir, "packages", "apps", "mcp-agent-chat-server", "start.sh");
    hasMacs = fs.existsSync(macsStart);
    if (hasMacs) {
      const macsDropin = path.join(systemdDir, "lions-macs.service.d");
      const macsInstaller = path.join(__dirname, "install-macs-platform.sh");
      const installedRoot = fs.existsSync(path.join(home, "current")) ? path.join(home, "current") : staged.releaseDir;
      const argv = [macsInstaller, "--systemd-dir", systemdDir, "--repo-dir", installedRoot, "--bind", "loopback", "--port", String(macsPort)];
      if (args["dry-run"]) argv.push("--dry-run");
      try {
        run("bash", argv, { allowFail: false });
        report.macsSecurity = { dropin: macsDropin, applied: true };
        step("macs-security", (args["dry-run"] ? "dry-run " : "") + "90/91 已套用到 " + macsDropin);
      } catch (e) {
        report.ok = false;
        report.macsSecurity = { dropin: macsDropin, applied: false, error: String(e && e.message || e).slice(0, 300) };
        step("macs-security", "失败（fail-closed）：" + (report.macsSecurity.error));
        throw new Error("MACS 安全加固未套用，安装中止（fail-closed）");
      }
    }
  }
  if (!args["skip-start"] && !args["skip-units"] && !args["no-systemctl"]) {
    const health = {};
    for (const app of START_ORDER) {
      const h = await waitHealth(app, ports[app], 90000);
      health[app] = h;
      log("    " + (h.ok ? "✓" : "✗") + " " + app + " :" + ports[app] + " " + h.path, args);
    }
    report.health = health;
    report.ok = Object.values(health).every((h) => h.ok);
    step("health", report.ok ? "全部通过" : "存在未通过");

    // 2026-10-27（商业化线 P0）：安装后必须证明"不可匿名访问 + 只绑回环"，
    //   否则 P0 仍是"文件在，没验证"。fail-closed：任一探针不符即安装失败。
    // 2026-11-04：开源版产物**不含 MACS**，探针必须按 hasMacs 门控；否则干净机装到最后一步必失败。
    if (!hasMacs) {
      report.macsSecurity = Object.assign({}, report.macsSecurity, { probe: "skipped(no macs in release)" });
      step("macs-security-probe", "skipped：本产物不含 MACS（open 版正常）");
    } else {
    try {
      if (args["no-systemctl"]) {
        // 不启停 systemd 的安装（本机演练/CI）无法探针"刚装好的实例"，如实记录为 skipped 而不是假装通过。
        report.macsSecurity = Object.assign({}, report.macsSecurity, { probe: "skipped(--no-systemctl)" });
        step("macs-security-probe", "skipped(--no-systemctl)：未启停服务，不探针");
        throw { __skip: true };
      }
      const port = ports && ports.macs ? ports.macs : 8765;
      const probe = (cmd) => execFileSync("bash", ["-lc", cmd], { encoding: "utf8", timeout: 15000 }).trim();
      const bind = probe("ss -ltn 2>/dev/null | awk '$4 ~ /:" + port + "$/{print $4}' | head -1");
      const dash = probe("curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:" + port + "/dashboard/v2/overview || true");
      const api = probe("curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:" + port + "/api/agents || true");
      const checks = {
        bind_loopback: /^127\.0\.0\.1:/.test(bind || ""),
        dashboard_401: dash === "401",
        api_requires_key_401: api === "401",
      };
      report.macsSecurity = Object.assign({}, report.macsSecurity, { bind, dashboard_http: dash, api_http: api, checks });
      const okAll = Object.values(checks).every(Boolean);
      if (!okAll) {
        report.ok = false;
        step("macs-security-probe", "未通过 bind=" + bind + " dashboard=" + dash + " api=" + api);
        throw new Error("MACS 安全探针未通过（bind/dashboard/api），安装中止（fail-closed）");
      }
      step("macs-security-probe", "bind=" + bind + " dashboard=401 api=401");
    } catch (e) {
      if (e && e.__skip) {
        // 已 step 记录；不算失败
      } else {
        report.ok = false;
        step("macs-security-probe", "失败：" + String(e && e.message || e).slice(0, 200));
        throw e;
      }
    }
    }
  } else {
    report.ok = true;
  }
  // 记录
  const record = {
    schema: SCHEMA,
    version: staged.version,
    edition: staged.edition,
    home,
    installedAt: new Date().toISOString(),
    dbMode: ctx.dbMode,
    ports,
    systemdDir: report.units ? report.units.systemdDir : null,
    apps: Object.fromEntries(START_ORDER.map((a) => [a, { port: ports[a], unit: U.unitName(a, args["unit-prefix"]) }])),
  };
  if (report.units && report.units.pgUnit) record.pgUnit = report.units.pgUnit;
  if (!args["skip-record"]) fs.writeFileSync(H.installRecordPath(home), JSON.stringify(record, null, 2) + "\n");
  report.record = record;
  step("record", H.installRecordPath(home));
  return report;
}

function runSelftest() {
  const results = [];
  const assert = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail || "" });
  assert("env 解析", JSON.stringify(parseEnvFile("A=1\n# c\nB=\"x y\"\n")) === JSON.stringify({ A: "1", B: "x y" }));
  // 已有库体检的判据方向（2026-11-02 实测教训：缺口是"需要新增"，不是"库里有多的"）
  {
    const c1 = classifySchemaDiff("-- x\nDROP TABLE \"Todo\";\nDROP INDEX \"i\";\nALTER TABLE \"K\" ALTER COLUMN \"v\" SET DEFAULT 'private';");
    assert("schema-gap: 仅 DROP/SET DEFAULT => 无缺口", c1.gap.length === 0, JSON.stringify(c1));
    const c2 = classifySchemaDiff("CREATE TABLE \"NewThing\" (id text);");
    // 2026-11-02（总调度要求）：非空 PG 库必须拒绝 db push —— 抽成纯函数后在此断言。
    assert("pgDbPush: 空库放行", pgDbPushDecision({ tableCount: 0, gap: null }).refuse === false);
    assert("pgDbPush: 非空+无缺口放行（no-op）", pgDbPushDecision({ tableCount: 78, gap: { ok: true, drops: 0, executable: [] } }).refuse === false);
    assert("pgDbPush: 非空+DROP 拒绝", pgDbPushDecision({ tableCount: 78, gap: { ok: true, drops: 20, executable: [] } }).refuse === true);
    assert("pgDbPush: 非空+有缺口 拒绝", pgDbPushDecision({ tableCount: 78, gap: { ok: false, drops: 0, executable: ["CREATE TABLE \"X\""] } }).refuse === true);
    assert("pgDbPush: 体检失败(null) 拒绝", pgDbPushDecision({ tableCount: 78, gap: null }).refuse === true);
    assert("schema-gap: CREATE TABLE => 有缺口", c2.gap.length === 1, JSON.stringify(c2));
    const c3 = classifySchemaDiff("ALTER TABLE \"Todo\" ADD COLUMN \"x\" text;");
    assert("schema-gap: ADD COLUMN => 有缺口", c3.gap.length === 1, JSON.stringify(c3));
  }
  const env = buildAppEnv("mind", { home: "/tmp/h", ports: defaultPorts({ console: 3104 }), answers: { MINIMAX_API_KEY: "k" }, exampleEnv: { KNOWLEDGE_SEARCH_LIMIT: "10" } });
  assert("DATABASE_URL 指向 data/", env.DATABASE_URL === "file:/tmp/h/data/mind/dev.db", env.DATABASE_URL);
  assert("DATABASE_URL 是绝对路径", env.DATABASE_URL.indexOf("file:/") === 0, env.DATABASE_URL);
  assert("保留 example 键", env.KNOWLEDGE_SEARCH_LIMIT === "10");
  assert("安装器不再注入生成模型 key", env.MINIMAX_API_KEY === undefined && env.ANTHROPIC_MODEL === undefined);
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "lions-ed-"));
  fs.mkdirSync(path.join(fx, "packages/apps/mind"), { recursive: true });
  assert("detectEdition=open", detectEdition(fx) === "open", detectEdition(fx));
  fs.mkdirSync(path.join(fx, "packages/apps/mcp-agent-chat-server"), { recursive: true });
  assert("detectEdition=sales", detectEdition(fx) === "sales", detectEdition(fx));
  let ethrew = false; try { resolveEdition(fx, "open"); } catch (_e) { ethrew = true; }
  assert("edition 冲突抛错", ethrew);
  assert("edition 一致时通过", resolveEdition(fx, "sales") === "sales");
  fs.rmSync(fx, { recursive: true, force: true });
  assert("parseArgv 支持 --k=v", parseArgv(["--model-key=abc"])["model-key"] === "abc");
  assert("parseArgv 支持 --k v", parseArgv(["--model-key", "abc"])["model-key"] === "abc");
  const ansM = loadAnswers({ "model-key": "k1", "model-name": "m1", "model-base-url": "http://x", "model-provider": "minimax" });
  assert("--model-key 映射 ANTHROPIC_AUTH_TOKEN", ansM.ANTHROPIC_AUTH_TOKEN === "k1");
  assert("--model-provider=minimax 补 MINIMAX_API_KEY", ansM.MINIMAX_API_KEY === "k1");
  assert("缺省不写模型 key", loadAnswers({}).ANTHROPIC_AUTH_TOKEN === undefined);
  assert("console 端口覆盖", defaultPorts({ console: 3104 }).console === 3104);
  assert("selfimproving 无库不写 DATABASE_URL", buildAppEnv("console", { home: "/tmp/h", ports: defaultPorts(), answers: {}, exampleEnv: {} }).DATABASE_URL === undefined);
  // 2026-11-02（前端线）：agent-permissions 的机器地址走配置；默认必须无害（环回 + 空表）。
  {
    const c = buildAppEnv("console", { home: "/tmp/h", ports: defaultPorts(), answers: {}, exampleEnv: {} });
    assert("console 默认 AGENT_HOST_PREFIX=127.0.0.1（无害默认）", c.AGENT_HOST_PREFIX === "127.0.0.1");
    assert("console 默认 AGENT_SSH_TARGETS 为空（fail-closed）", c.AGENT_SSH_TARGETS === "");
    const c2 = buildAppEnv("console", { home: "/tmp/h", ports: defaultPorts(), answers: { AGENT_HOST_PREFIX: "10.0.0", AGENT_SSH_TARGETS: "agent_a=a@h1" }, exampleEnv: {} });
    assert("answers 可覆盖 AGENT_HOST_PREFIX", c2.AGENT_HOST_PREFIX === "10.0.0");
    assert("answers 可覆盖 AGENT_SSH_TARGETS", c2.AGENT_SSH_TARGETS === "agent_a=a@h1");
    const m = buildAppEnv("mind", { home: "/tmp/h", ports: defaultPorts(), answers: {}, exampleEnv: {} });
    assert("非 console 的 app 不写这两个键（避免扩散）", m.AGENT_HOST_PREFIX === undefined && m.AGENT_SSH_TARGETS === undefined);
    // 2026-11-02 切流事故：console 的通讯录依赖 HERMES_MCP_API_KEY；密钥不写默认值。
    const cNoKey = buildAppEnv("console", { home: "/tmp/h", ports: defaultPorts(), answers: {}, exampleEnv: {} });
    assert("console 无 HERMES key 时不写该键（不写假值）", cNoKey.HERMES_MCP_API_KEY === undefined);
    const cKey = buildAppEnv("console", { home: "/tmp/h", ports: defaultPorts(), answers: { HERMES_MCP_API_KEY: "k-demo" }, exampleEnv: {} });
    assert("answers 可注入 HERMES_MCP_API_KEY", cKey.HERMES_MCP_API_KEY === "k-demo");
    const mKey = buildAppEnv("mind", { home: "/tmp/h", ports: defaultPorts(), answers: { HERMES_MCP_API_KEY: "k-demo" }, exampleEnv: {} });
    assert("只有 console 写 HERMES key（mind 不扩散）", mKey.HERMES_MCP_API_KEY === undefined);
  }
  assert("renderEnv 可解析", parseEnvFile(renderEnv({ A: "1" })).A === "1");
  assert("parsePortOverrides", parsePortOverrides({ "port-mind": "3099" }).mind === 3099);
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + (r.detail ? " :: " + r.detail : ""));
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad === 0 ? "SELFTEST OK (" + results.length + " 断言)" : "SELFTEST FAILED (" + bad + ")");
  process.exit(bad === 0 ? 0 : 1);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.selftest) return runSelftest();
  if (!args.from) { console.error("缺少 --from=<tar|dir>"); process.exit(3); }
  if (!args.home) { console.error("缺少 --home=<dir>（新装建议 ~/lions）"); process.exit(3); }
  try {
    const report = await install(args);
    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (report.ok === false) process.exit(1);
  } catch (e) {
    console.error("INSTALL FAILED: " + e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { parseEnvFile, renderEnv, buildAppEnv, defaultPorts, parsePortOverrides, readVersion, dbUrl, resolvePnpm, linkCurrent, buildApp, buildWorkspace, waitHealth, run, install, schemaGapCheck, pgTableCount, SCHEMA };
