#!/usr/bin/env node
/**
 * lions-doctor.cjs — 用户侧一键只读诊断 + 脱敏诊断包（产品化 S0-1）
 * ===================================================================
 *
 * 定位（pricing-v2 §3.2）: "AI 售后"的输入端 —— 用户遇到问题点一下，
 *   得到系统状态 + 各模块健康 + 明确建议；需要求助时可生成**脱敏**诊断包。
 *
 * 只读承诺:
 *   默认不写任何文件（除 --bundle 显式指定）；不启动/停止任何服务；不修改配置。
 *   诊断包**默认脱敏**：不含 .env、不含 data/、key 值替换为 ***、家目录替换为 ~。
 *
 * 用法:
 *   node scripts/lions-doctor.cjs [--home=DIR] [--json]
 *   node scripts/lions-doctor.cjs [--home=DIR] --bundle=<out.tar.gz> [--yes]
 *   node scripts/lions-doctor.cjs --selftest
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const H = require("./lib/lions-home.cjs");
const { APPS, START_ORDER } = require("./lib/lions-apps.cjs");
const U = require("./lib/lions-units.cjs");
const I = require("./lions-install.cjs");

const MODEL_KEYS = ["MINIMAX_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "REFLECT_MODEL"];

function parseArgv(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([A-Za-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^\"|\"$/g, ""); }
  return out;
}
function redact(text, secrets) {
  let out = String(text);
  // ① 已知密钥值（来自各 app .env）
  for (const s of secrets) { if (s && s.length >= 6) out = out.split(s).join("***"); }
  // ② 高熵/常见密钥形态（不在 env 列表里也必须掩：日志里可能有）
  out = out.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "***");
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "***JWT***");
  out = out.replace(/\b[A-Fa-f0-9]{32,}\b/g, "***");
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***");
  // ③ 路径/邮箱
  out = out.replace(/\/home\/[A-Za-z0-9._-]+/g, "~");
  out = out.replace(/\/(?:Users|media)\/[A-Za-z0-9._-]+/g, "~");
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***");
  return out;
}
function httpProbe(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 2500 }, (res) => { res.resume(); resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode }); });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.code || "ERR" }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, error: "timeout" }); });
  });
}
function currentRelease(home) { const link = H.currentLink(home); try { return fs.realpathSync(link); } catch (_e) { return null; } }
function quickCheck(releaseDir, home, app) {
  const db = path.join(H.appDataDir(home, app), "dev.db");
  if (!fs.existsSync(db)) return { ok: false, detail: "库不存在", level: "fail" };
  const mod = releaseDir ? path.join(releaseDir, "node_modules", "better-sqlite3") : null;
  if (!mod || !fs.existsSync(mod)) return { ok: true, detail: "库存在（无 better-sqlite3，未做完整性检查）", level: "warn" };
  const script = "try{const D=require(String(process.argv[1]));const db=new D(process.argv[2],{readonly:true});const r=db.pragma('quick_check');db.close();const s=JSON.stringify(r);process.stdout.write(r===undefined?'unknown':s);}catch(e){process.stdout.write('ERR:'+e.message);process.exit(3);}";
  const r = spawnSync(process.execPath, ["-e", script, mod, db], { encoding: "utf8" });
  const txt = (r.stdout || "").trim();
  if (r.status !== 0) return { ok: true, detail: "完整性检查未完成: " + txt.slice(0, 60), level: "warn" };
  const good = /ok/i.test(txt) && txt.indexOf("ERR") < 0;
  return { ok: good, detail: good ? "quick_check ok" : "quick_check: " + txt.slice(0, 80), level: good ? "ok" : "fail" };
}
async function pgCheck(releaseDir, home, app, rec) {
  // 2026-10-27 (商业化线): PG 安装根没有 data/<app>/dev.db；doctor 不能把健康 PG 误判为“库不存在”。
  const envPath = releaseDir ? path.join(releaseDir, APPS[app].dir, ".env") : null;
  if (!envPath || !fs.existsSync(envPath)) return { ok: false, detail: "找不到 .env", level: "fail", advice: "重跑安装或检查 release/.env" };
  const env = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  const key = app === "mind" ? "MIND_DATABASE_URL" : (app === "session" ? "SESSION_DATABASE_URL" : "SELFIMPROVING_DATABASE_URL");
  const url = env[key] || env.DATABASE_URL || "";
  if (!/^postgres(ql)?:\/\//.test(url)) return { ok: false, detail: "PG URL 缺失（" + key + "）", level: "fail", advice: "检查 app .env 的 " + key };
  // 2026-10-29 (商业化线): 导出根没有 pg；从安装 release 解析（与 installer 同理），否则 doctor 在干净包上直接崩。
  let PgMod = null;
  for (const base of [releaseDir, path.join(releaseDir, "packages/apps/console"), path.join(releaseDir, "packages/apps/selfimproving")]) {
    try { PgMod = require(require.resolve("pg", { paths: [base] })); break; } catch (_e) {}
  }
  if (!PgMod) return { ok: false, detail: "找不到 pg 模块（请确认 release 依赖已安装）", level: "fail", advice: "重跑安装器的 pnpm install" };
  const c = new PgMod.Client({ connectionString: url, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
    await c.query("select 1");
    return { ok: true, detail: "PG 连接 ok", level: "ok", advice: "" };
  } catch (e) {
    return { ok: false, detail: "PG 连接失败: " + String(e && e.message || e).slice(0, 80), level: "fail", advice: "检查 PG 服务/URL；不是 dev.db" };
  } finally { try { await c.end(); } catch (_e) {} }
}
function systemdActive(unit) {
  // 2026-10-29 (商业化线): sudo/非登录 shell 下 XDG_RUNTIME_DIR 缺失会 “Failed to connect to bus”；
  //   按 uid 推导 /run/user/<uid>，让多实例/巡检也能读用户 systemd。
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const runtime = process.env.XDG_RUNTIME_DIR || (uid !== null ? "/run/user/" + uid : "");
  const env = Object.assign({}, process.env);
  if (runtime && fs.existsSync(runtime)) env.XDG_RUNTIME_DIR = runtime;
  const r = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8", env });
  return r.status === 0 ? (r.stdout || "").trim() : (r.stdout || r.stderr || "").trim() || "inactive";
}

/**
 * 3env（2026-11-03, P0-1 回归）: open 版产物里没有 portal 目录，但旧逻辑无条件按 START_ORDER
 *   检查 5 个服务 -> 安装版 doctor 恒报 svc-portal fail（假红，且掩盖真故障）。
 *   改为: 以 install record 声明的 app 为准；未声明且产物里也没有该 app 目录 -> skip（不计 fail）；
 *   声明了但目录缺失 -> 仍然检查（fail），避免"少装一个服务"被静默跳过。
 *   纯函数（present 由调用方注入），便于 --selftest 断言"能红也能绿"。
 */
function selectApps(declaredApps, present) {
  const declared = Array.isArray(declaredApps) ? declaredApps.filter((a) => START_ORDER.indexOf(a) >= 0) : null;
  if (!declared) return { check: START_ORDER.slice(), skip: [] }; // 旧记录没有 apps 字段：保持原行为
  const check = [];
  const skip = [];
  for (const app of START_ORDER) {
    if (declared.indexOf(app) >= 0) check.push(app);
    else if (present(app)) check.push(app);
    else skip.push(app);
  }
  return { check, skip };
}

async function diagnose(args) {
  const home = H.resolveHome({ home: typeof args.home === "string" ? args.home : undefined });
  const rec = H.readInstallRecord(home);
  const checks = [];
  const add = (id, label, level, detail, advice) => checks.push({ id, label, level, detail: detail || "", advice: advice || "" });

  const node = process.versions.node;
  add("node", "运行环境 Node", Number(node.split(".")[0]) >= 20 ? "ok" : "fail", "v" + node, Number(node.split(".")[0]) >= 20 ? "" : "升级 Node 到 20+");
  const pnpm = I.resolvePnpm();
  add("pnpm", "包管理器 pnpm", pnpm ? "ok" : "warn", pnpm ? pnpm.cmd + " " + pnpm.version : "不可用", pnpm ? "" : "corepack enable 或安装 pnpm");
  const sc = spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8" });
  add("systemd", "systemd --user", sc.status === 0 ? "ok" : "warn", sc.status === 0 ? "可用" : "不可用（服务不会自启）", sc.status === 0 ? "" : "需要 Linux + systemd --user");

  const releaseDir = currentRelease(home);
  const version = rec && !rec._unparsable ? rec.version : null;
  add("install", "安装记录", version ? "ok" : "fail", version ? "版本 " + (typeof args.home === "string" ? version : version) + "，current=" + (releaseDir || "缺失") : "找不到 install.json", version ? "" : "先跑 lions-install");
  const dirs = [H.dataDir(home), H.logsDir(home), path.join(home, "releases")];
  add("dirs", "目录结构", dirs.every((d) => fs.existsSync(d)) ? "ok" : "warn", dirs.map((d) => path.basename(d) + (fs.existsSync(d) ? "✓" : "✗")).join(" "), "缺目录可重跑安装");

  // 只体检"这一版真的装了"的服务：open 版无 portal -> skip，不再假红（selectApps 有 --selftest 断言）。
  const presentFn = (app) => !!(releaseDir && fs.existsSync(path.join(releaseDir, APPS[app].dir)));
  const sel = selectApps(rec && rec.apps ? Object.keys(rec.apps) : null, presentFn);
  for (const app of sel.check) {
    if (APPS[app].hasDatabase) { const q = (rec && rec.dbMode === "pg") ? await pgCheck(releaseDir, home, app, rec) : quickCheck(releaseDir, home, app); add("db-" + app, "数据库 " + app, q.level, q.detail, q.ok ? "" : (q.advice || "从 backups/ 恢复或跑 lions doctor --bundle 求助")); }
  }
  for (const app of sel.skip) add("svc-" + app, "服务 " + app, "skip", "未安装（本版产物无 " + APPS[app].dir + "），跳过", "");

  const unitInfo = [];
  for (const app of sel.check) {
    let unit = rec && rec.apps && rec.apps[app] ? rec.apps[app].unit : U.unitName(app);
    // 多实例环境用 --unit-prefix=lions-dev- 诊断；标准安装不传则保持 lions-<app>.service。
    // 2026-10-30（devops 三环境）：install.json 记录的 unit 可能已带前缀，再次前缀会拼出
    //   lions-dev-dev-mind.service（诊断假失败）。已带前缀则原样使用。
    const unitPrefix = typeof args["unit-prefix"] === "string" ? args["unit-prefix"] : "";
    if (unitPrefix && !unit.startsWith(unitPrefix)) unit = unitPrefix + unit.replace(/^lions-/, "");
    const port = rec && rec.ports ? rec.ports[app] : APPS[app].port;
    const active = systemdActive(unit);
    const hp = APPS[app].healthPaths[0];
    const probe = (sc.status === 0 && active === "active") ? await httpProbe(port, hp) : { ok: false, status: 0, error: "unit " + active };
    unitInfo.push({ app, unit, port, active, health: probe });
    const level = probe.ok ? "ok" : (active === "active" ? "warn" : "fail");
    add("svc-" + app, "服务 " + app, level, ":" + port + " " + active + " / " + (probe.ok ? "HTTP " + probe.status : (probe.error || "无响应")), probe.ok ? "" : "systemctl --user start " + unit + "；仍失败看 " + path.join(H.logsDir(home), app + ".log"));
  }

  const envSecrets = [];
  let modelConfigured = false;
  if (releaseDir) {
    for (const app of START_ORDER) {
      const envPath = path.join(releaseDir, APPS[app].dir, ".env");
      if (!fs.existsSync(envPath)) continue;
      const env = parseEnvFile(fs.readFileSync(envPath, "utf8"));
      for (const k of MODEL_KEYS) if (env[k]) { envSecrets.push(env[k]); if (k === "MINIMAX_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN" || k === "OPENAI_API_KEY") modelConfigured = true; }
    }
  }
  add("model", "模型配置", modelConfigured ? "ok" : "warn", modelConfigured ? "已配置（值不显示）" : "未设置 API Key", modelConfigured ? "" : "编辑各 app 的 .env 或重跑安装 --answers");

  try { const s = fs.statfsSync(home); add("disk", "磁盘空间", s.bavail * s.bsize > 2 * 1073741824 ? "ok" : "warn", ((s.bavail * s.bsize) / 1073741824).toFixed(1) + " GB 可用", "清理 backups/ 或扩容"); } catch (_e) {}
  add("mem", "内存", os.freemem() > 1024 * 1024 * 1024 ? "ok" : "warn", (os.freemem() / 1073741824).toFixed(1) + " GB 空闲", "内存不足时先停不用的服务");

  return { home, version, current: releaseDir, checks, units: unitInfo, skipped: sel.skip, secrets: envSecrets, summary: { ok: checks.filter((c) => c.level === "ok").length, warn: checks.filter((c) => c.level === "warn").length, fail: checks.filter((c) => c.level === "fail").length, skip: checks.filter((c) => c.level === "skip").length } };
}

function makeBundle(result, args) {
  const out = path.resolve(String(args.bundle));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lions-doctor-"));
  const home = result.home;
  const included = [];
  const excluded = [".env（含密钥）", "data/（业务数据）", "backups/（库副本）", "会话原文"];
  const doctorJson = { schema: "lions-doctor/1", generatedAt: new Date().toISOString(), home: "~", version: result.version, summary: result.summary, checks: result.checks };
  fs.writeFileSync(path.join(tmp, "doctor.json"), JSON.stringify(doctorJson, null, 2)); included.push("doctor.json");
  fs.writeFileSync(path.join(tmp, "system.txt"), redact(["uname: " + os.platform() + " " + os.release() + " " + os.arch(), "node: " + process.versions.node, "host: " + os.hostname(), "time: " + new Date().toISOString()].join("\n") + "\n", result.secrets)); included.push("system.txt");
  const logDir = path.join(tmp, "logs"); fs.mkdirSync(logDir);
  const hlogs = H.logsDir(home);
  if (fs.existsSync(hlogs)) {
    let n = 0;
    for (const f of fs.readdirSync(hlogs)) {
      if (n >= 8) break;
      const p = path.join(hlogs, f);
      if (!fs.statSync(p).isFile()) continue;
      const tail = fs.readFileSync(p, "utf8").split("\n").slice(-80).join("\n");
      fs.writeFileSync(path.join(logDir, f + ".tail"), redact(tail, result.secrets));
      included.push("logs/" + f + ".tail"); n++;
    }
  }
  if (!args.yes) {
    console.log("将要生成诊断包（脱敏）：", out);
    console.log("  包含: " + included.join(", "));
    console.log("  排除: " + excluded.join(", "));
    console.log("  加 --yes 确认生成（不会自动上传，任何分享由你决定）");
    fs.rmSync(tmp, { recursive: true, force: true });
    return { written: false, included, excluded };
  }
  const r = spawnSync("tar", ["-czf", out, "-C", tmp].concat(fs.readdirSync(tmp)), { encoding: "utf8" });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { written: r.status === 0, path: out, included, excluded };
}

function runSelftest() {
  const results = [];
  const assert = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail || "" });
  const red = redact("key=SECRETVALUE123 home=~/lions mail=[email]", ["SECRETVALUE123"]);
  assert("key 值被替换", red.indexOf("SECRETVALUE123") < 0, red);
  assert("家目录被替换", red.indexOf("~") < 0, red);
  assert("邮箱被替换", red.indexOf("[email]") < 0, red);
  assert("env 解析", parseEnvFile("A=1\nB=x\n").B === "x");
  const red2 = redact("k=sk-demo-abcdef1234567890 h=0123456789abcdef0123456789abcdef jwt=eyJabc.eyJdef.ghi auth=Bearer abc.def.ghijkl mn", []);
  assert("高熵 sk- 掩码", red2.indexOf("sk-demo-abcdef") < 0, red2);
  assert("高熵 hex 掩码", red2.indexOf("0123456789abcdef0123456789abcdef") < 0, red2);
  assert("JWT 掩码", red2.indexOf("eyJabc") < 0, red2);
  assert("Bearer 掩码", red2.indexOf("abc.def.ghijkl") < 0, red2);
  // P0-1 回归守卫：3env open 版没有 portal，不能因为"没装"判 fail；但声明了就必须检查（能红）
  const noPortal = (app) => app !== "portal";
  const selOpen = selectApps(["mind", "selfimproving", "session", "console"], noPortal);
  assert("open 版跳过 portal", selOpen.check.indexOf("portal") < 0 && selOpen.skip.join(",") === "portal", JSON.stringify(selOpen));
  const selSales = selectApps(["mind", "selfimproving", "session", "console", "portal"], noPortal);
  assert("sales 版检查 portal", selSales.check.indexOf("portal") >= 0 && selSales.skip.length === 0, JSON.stringify(selSales));
  const selLegacy = selectApps(null, () => true);
  assert("旧记录保持 5 服务", selLegacy.check.length === 5 && selLegacy.skip.length === 0, JSON.stringify(selLegacy));
  const selMissing = selectApps(["mind"], () => false);
  assert("未声明且未安装 -> skip 而非 fail", selMissing.check.join(",") === "mind" && selMissing.skip.length === 4, JSON.stringify(selMissing));
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + (r.detail ? " :: " + r.detail : ""));
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad === 0 ? "SELFTEST OK (" + results.length + " 断言)" : "SELFTEST FAILED (" + bad + ")");
  process.exit(bad === 0 ? 0 : 1);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.selftest) return runSelftest();
  const result = await diagnose(args);
  if (args.bundle) { const b = makeBundle(result, args); if (args.json) process.stdout.write(JSON.stringify({ bundle: b, summary: result.summary }, null, 2) + "\n"); process.exit(b.written || !args.yes ? 0 : 1); }
  if (args.strict && result.summary.fail > 0) process.exitCode = 1; // 判据用：异常项即非 0，可直接进 CI/巡检
  if (args.json) { const { secrets, ...safe } = result; process.stdout.write(JSON.stringify(safe, null, 2) + "\n"); return; }
  console.log("LIONS 体检（版本 " + (result.version || "未知") + "，安装根 " + result.home + "）");
  console.log("────────────────────────────────────────");
  for (const c of result.checks) console.log((c.level === "ok" ? "✓" : c.level === "warn" ? "!" : c.level === "skip" ? "-" : "✗") + " " + c.label.padEnd(14) + " " + c.detail + (c.advice ? "\n    建议：" + c.advice : ""));
  console.log("────────────────────────────────────────");
  console.log("结果: " + result.summary.ok + " 正常 / " + result.summary.warn + " 注意 / " + result.summary.fail + " 异常" + (result.summary.skip ? " / " + result.summary.skip + " 跳过（未安装）" : ""));
  console.log("生成脱敏诊断包：node scripts/lions-doctor.cjs --bundle=~/lions-doctor.tar.gz --yes");
}

if (require.main === module) main();
module.exports = { redact, parseEnvFile, diagnose, makeBundle };
