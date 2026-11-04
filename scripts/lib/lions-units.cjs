#!/usr/bin/env node
/**
 * lions-units.cjs — LIONS 五服务 systemd --user 单元的生成/落盘（产品化 S0-1）
 * ===============================================================================
 *
 * 为什么单独一层:
 *   平台现状的 unit 文件是**手工写死本机路径**的（ExecStart/PIDFile/Documentation 全是 ~/lions）。
 *   要装到任意安装根，必须由 profile + 安装根**生成**单元，而不是复制一份写死的。
 *   "只写 drop-in、不改单元文件"是发布工具的纪律；本模块负责"新装时生成单元"，两件事不冲突。
 *
 * 安全默认:
 *   目标单元已存在时**不覆盖**（除非 force），保护用户手改；生成前不调用 systemctl。
 *
 * 用法(库):
 *   const U = require("./lib/lions-units.cjs");
 *   const plan = U.planUnits(home, { portOverrides: { console: 3104 } });
 *   U.renderUnit("mind", plan[0].profile, { home });
 *   node scripts/lib/lions-units.cjs --selftest
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { APPS, START_ORDER } = require("./lions-apps.cjs");
const H = require("./lions-home.cjs");

function unitName(app, prefix) { return (prefix || "lions-") + app + ".service"; }

function renderUnit(app, profile, opts) {
  const home = opts.home;
  const systemdDir = opts.systemdDir || path.join(os.homedir(), ".config", "systemd", "user");
  // 代码根：托管安装用 <home>/current（升级时切软链即换代码），兼容直接用 <home> 的旧布局。
  const codeRoot = opts.codeRoot || path.join(home, "current");
  const appDir = path.join(codeRoot, profile.dir);
  const wrapper = path.join(codeRoot, "scripts", "lions-service-wrapper.sh");
  const log = path.join(H.logsDir(home), app + ".log");
  const pid = path.join(H.runDir(home), "lions-" + app + ".pid");
  // 注意：wrapper 只认 start/dev；安装 profile 的 installMode="production" 必须映射为 "start"。
  const rawMode = opts.mode || profile.installMode || "production";
  const nextCmd = rawMode === "production" ? "start" : rawMode;
  const heap = opts.heapMiB || profile.nodeHeapMiB || 1536;
  const doc = "file://" + path.join(codeRoot, "docs", "platform-logic", "installer-upgrade.md");
  return [
    "[Unit]",
    "Description=LIONS " + profile.label,
    "After=network-online.target",
    "Wants=network-online.target",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "Documentation=" + doc,
    "",
    "[Service]",
    "Environment=NODE_OPTIONS=--max-old-space-size=" + heap,
    "Environment=LIONS_NEXT_CMD=" + nextCmd,
    "Environment=LIONS_HOME=" + home,
    "Type=simple",
    "ExecStart=" + wrapper + " " + appDir + " " + profile.port + " " + log + " " + pid,
    "PIDFile=" + pid,
    "Restart=always",
    "RestartSec=10",
    "KillMode=mixed",
    // 2026-11-02 P0：mind stop 15s 超时被 SIGKILL，升级停机未起；core units 统一 60s。
    "TimeoutStopSec=60",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** 生成单元计划（不落盘）。portOverrides 允许安装器避开端口冲突。 */
function planUnits(home, opts) {
  opts = opts || {};
  const systemdDir = opts.systemdDir || path.join(os.homedir(), ".config", "systemd", "user");
  const codeRoot = opts.codeRoot || path.join(home, "current");
  return START_ORDER.map((app) => {
    const base = APPS[app];
    const profile = Object.assign({}, base, {
      port: (opts.portOverrides && opts.portOverrides[app]) || base.port,
      installMode: (opts.modeOverrides && opts.modeOverrides[app]) || base.installMode,
    });
    return {
      app,
      unit: unitName(app, opts.unitPrefix),
      profile,
      path: path.join(systemdDir, unitName(app, opts.unitPrefix)),
      content: renderUnit(app, profile, { home, systemdDir, codeRoot }),
    };
  });
}

/** PG 单元名（多实例带前缀）。 */
function pgUnitName(prefix) { return (prefix || "lions-") + "pg.service"; }

/** 生成 PG 单元内容（Type=forking + pg_ctl；数据/端口/socket 与三环境手工版一致）。 */
function renderPgUnit(home, opts) {
  opts = opts || {};
  const pgRoot = opts.pgRoot || path.join(path.dirname(home), "lions-pg");
  const dataDir = opts.dataDir || path.join(pgRoot, "data");
  const socketDir = opts.socketDir || path.join(pgRoot, "run");
  const logFile = opts.logFile || path.join(pgRoot, "pg.log");
  const port = opts.port || 5432;
  const pgb = opts.pgBin || "/usr/lib/postgresql/16/bin";
  return [
    "[Unit]",
    "Description=LIONS PostgreSQL（127.0.0.1:" + port + "）",
    "After=network.target",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=forking",
    "ExecStart=" + pgb + "/pg_ctl -D " + dataDir + " -o \"-p " + port + " -k " + socketDir + " -h 127.0.0.1\" -l " + logFile + " -w start",
    "ExecStop=" + pgb + "/pg_ctl -D " + dataDir + " -m fast -w stop",
    "ExecReload=" + pgb + "/pg_ctl -D " + dataDir + " reload",
    "PIDFile=" + path.join(dataDir, "postmaster.pid"),
    "TimeoutStartSec=0",
    "TimeoutStopSec=300",
    "Restart=always",
    "RestartSec=5",
    "KillMode=mixed",
    "OOMScoreAdjust=-900",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** 生成 PG 单元计划（不落盘）。 */
function planPgUnit(home, opts) {
  opts = opts || {};
  const systemdDir = opts.systemdDir || path.join(os.homedir(), ".config", "systemd", "user");
  const unit = pgUnitName(opts.unitPrefix);
  const pgRoot = opts.pgRoot || path.join(path.dirname(home), "lions-pg");
  const dataDir = opts.dataDir || path.join(pgRoot, "data");
  return {
    app: "pg",
    unit,
    path: path.join(systemdDir, unit),
    dataDir,
    content: renderPgUnit(home, Object.assign({}, opts, { pgRoot, dataDir })),
  };
}

/** 落盘。返回 {written, skipped}；默认不覆盖已存在文件。 */
function writeUnits(plan, opts) {
  opts = opts || {};
  const written = [];
  const skipped = [];
  for (const u of plan) {
    fs.mkdirSync(path.dirname(u.path), { recursive: true });
    if (fs.existsSync(u.path) && !opts.force) { skipped.push(u); continue; }
    fs.writeFileSync(u.path, u.content);
    written.push(u);
  }
  return { written, skipped };
}

function runSelftest() {
  const results = [];
  const assert = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail || "" });
  const home = "/tmp/lions-home-test";
  const systemdDir = fs.mkdtempSync(path.join(os.tmpdir(), "lions-units-"));
  const plan = planUnits(home, { systemdDir });
  assert("生成 5 个单元", plan.length === 5, String(plan.length));
  assert("顺序为 mind 起手", plan[0].app === "mind", plan[0].app);
  const mind = plan[0];
  assert("单元名正确", mind.unit === "lions-mind.service", mind.unit);
  assert("unitPrefix 生效", planUnits(home, { systemdDir, unitPrefix: "lions-qa-" })[0].unit === "lions-qa-mind.service");
  assert("单元文件名也带前缀", planUnits(home, { systemdDir, unitPrefix: "lions-qa-" })[0].path.endsWith("lions-qa-mind.service"), planUnits(home, { systemdDir, unitPrefix: "lions-qa-" })[0].path);
  assert("ExecStart 指向 current 代码根", mind.content.indexOf(path.join(home, "current", "scripts", "lions-service-wrapper.sh")) >= 0, mind.content.split("\n").filter((l) => l.indexOf("ExecStart") === 0)[0]);
  assert("带 LIONS_HOME", mind.content.indexOf("Environment=LIONS_HOME=" + home) >= 0);
  assert("生产模式映射为 start", mind.content.indexOf("Environment=LIONS_NEXT_CMD=start") >= 0, mind.content.split("\n").filter((l) => l.indexOf("LIONS_NEXT_CMD") === 0)[0]);
  assert("PIDFile 在 run/ 下", mind.content.indexOf("PIDFile=" + path.join(home, "run", "lions-mind.pid")) >= 0);
  assert("端口来自 profile", mind.content.indexOf(" 3000 ") >= 0);
  const pg = planPgUnit(home, { systemdDir });
  assert("PG 单元名", pg.unit === "lions-pg.service", pg.unit);
  assert("PG 单元 Type=forking", pg.content.indexOf("Type=forking") >= 0);
  assert("PG 单元数据目录", pg.content.indexOf(pg.dataDir) >= 0, pg.dataDir);
  assert("PG 单元带前缀", planPgUnit(home, { systemdDir, unitPrefix: "lions-qa-" }).unit === "lions-qa-pg.service");
  const w = writeUnits(plan, { systemdDir });
  assert("首次写入 5 个", w.written.length === 5 && w.skipped.length === 0, JSON.stringify([w.written.length, w.skipped.length]));
  const w2 = writeUnits(plan, { systemdDir });
  assert("二次默认不覆盖", w2.written.length === 0 && w2.skipped.length === 5, JSON.stringify([w2.written.length, w2.skipped.length]));
  const w3 = writeUnits(plan, { systemdDir, force: true });
  assert("force 覆盖", w3.written.length === 5, String(w3.written.length));
  const overridden = planUnits(home, { systemdDir, portOverrides: { console: 3104 } });
  const con = overridden.filter((u) => u.app === "console")[0];
  assert("端口覆盖生效", con.content.indexOf(" 3104 ") >= 0 && con.content.indexOf(" 3004 ") < 0, con.content.split("\n").filter((l) => l.indexOf("ExecStart") === 0)[0]);
  fs.rmSync(systemdDir, { recursive: true, force: true });
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + (r.detail ? " :: " + r.detail : ""));
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad === 0 ? "SELFTEST OK (" + results.length + " 断言)" : "SELFTEST FAILED (" + bad + ")");
  process.exit(bad === 0 ? 0 : 1);
}

if (require.main === module) {
  if (process.argv.indexOf("--selftest") >= 0) runSelftest();
  const home = H.resolveHome({});
  const plan = planUnits(home, { systemdDir: path.join(os.homedir(), ".config", "systemd", "user") });
  for (const u of plan) console.log(u.unit + "  ->  " + u.path);
}

module.exports = { unitName, renderUnit, planUnits, writeUnits, pgUnitName, renderPgUnit, planPgUnit };
