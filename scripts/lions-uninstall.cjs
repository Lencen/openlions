#!/usr/bin/env node
/**
 * lions-uninstall.cjs — 干净卸载一个安装根（默认 dry-run；数据默认保留）。
 *
 * 安全:
 *   - 默认只打印计划（dry-run）；真正执行需 --apply --yes。
 *   - 拒绝危险目标：/ 、$HOME 本身、含 .git 的源码仓根。
 *   - 默认保留 data/ backups/ logs/ config/（密钥）；--purge-data / --purge-config 才删。
 *   - 只操作 --home 内与 install.json 记录的 systemdDir 内文件。
 *
 * 用法：
 *   node scripts/lions-uninstall.cjs --home=DIR [--json]
 *   node scripts/lions-uninstall.cjs --home=DIR --apply --yes [--purge-data] [--purge-config]
 *   node scripts/lions-uninstall.cjs --selftest
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const U = require("./lib/lions-units.cjs");
const { START_ORDER } = require("./lib/lions-apps.cjs");

function refuseReason(home) {
  const h = path.resolve(home);
  if (h === "/" || h === os.homedir()) return "拒绝：目标是 / 或家目录本身";
  if (fs.existsSync(path.join(h, ".git"))) return "拒绝：看起来是源码仓根（含 .git），不是安装根";
  if (!fs.existsSync(path.join(h, "install.json"))) return "拒绝：没有 install.json（不是由 lions-install 装的）";
  return null;
}
function plan(home, opts) {
  const h = path.resolve(home);
  const rec = JSON.parse(fs.readFileSync(path.join(h, "install.json"), "utf8"));
  // 2026-10-27 (商业化线): 安装时 --skip-units 的根没有自己的 systemdDir；
  //   不能回退到用户全局 systemd 目录去删别的安装/主环境的单元。
  const systemdDir = typeof rec.systemdDir === "string" && rec.systemdDir ? rec.systemdDir : null;
  const units = (systemdDir && rec.apps) ? Object.values(rec.apps).map((a) => a.unit) : [];
  // 2026-10-30（devops 三环境 P1-5）：PG unit 由安装器/接管写入 install.json，卸载必须一并停用删除，
  //   否则残留的 lions-<env>-pg.service 会在下次登录/宿主重启时把 PG 又拉起来。
  if (systemdDir && typeof rec.pgUnit === "string" && rec.pgUnit && units.indexOf(rec.pgUnit) < 0) units.push(rec.pgUnit);
  const unitFiles = units.map((u) => path.join(systemdDir, u));
  const dropins = units.map((u) => path.join(systemdDir, u + ".d"));
  const remove = [path.join(h, "current"), path.join(h, "releases"), path.join(h, "run"), path.join(h, "install.json"), path.join(h, "channel.json")];
  const keep = [path.join(h, "data"), path.join(h, "backups"), path.join(h, "logs"), path.join(h, "config")];
  const purge = [];
  if (opts && opts.purgeData) purge.push(path.join(h, "data"), path.join(h, "backups"));
  if (opts && opts.purgeConfig) purge.push(path.join(h, "config"));
  return { home: h, units, systemdDir, unitFiles, dropins, remove, keep, purge, version: rec.version, edition: rec.edition || null };
}
function render(p, applied) {
  const L = ["== 卸载计划" + (applied ? "（已执行）" : "（dry-run；加 --apply --yes 执行）") + " =="];
  L.push("安装根: " + p.home + "（版本 " + p.version + (p.edition ? " / " + p.edition : "") + "）");
  L.push("停用单元: " + p.units.join(", "));
  L.push("删除单元文件: " + p.unitFiles.length + " 个 + " + p.dropins.length + " 个 drop-in 目录");
  L.push("删除: " + p.remove.join(", "));
  L.push("保留: " + p.keep.join(", ") + "（用 --purge-data/--purge-config 才删）");
  if (p.purge.length) L.push("额外清除: " + p.purge.join(", "));
  return L.join("\n");
}
function selftest() {
  let bad = 0; const t = (n, c, d) => { console.log((c ? "PASS" : "FAIL") + "  " + n + (d ? " :: " + d : "")); if (!c) bad++; };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lions-uninstall-"));
  fs.mkdirSync(path.join(home, "releases/0.1.0"), { recursive: true });
  fs.mkdirSync(path.join(home, "data/mind"), { recursive: true });
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  fs.writeFileSync(path.join(home, "install.json"), JSON.stringify({ schema: "lions-install/1", version: "0.1.0", edition: "sales", systemdDir: path.join(home, "units"), pgUnit: "lions-pg.service", apps: { mind: { unit: "lions-mind.service" }, console: { unit: "lions-console.service" } } }));
  const p = plan(home, {});
  t("plan 读到单元", p.units.length === 3 && p.units.indexOf("lions-mind.service") >= 0, JSON.stringify(p.units));
  t("plan 含 pgUnit", p.units.indexOf("lions-pg.service") >= 0 && p.unitFiles.indexOf(path.join(home, "units", "lions-pg.service")) >= 0, JSON.stringify(p.units));
  t("plan 保留 data", p.keep.indexOf(path.join(home, "data")) >= 0);
  t("plan 删除 releases", p.remove.indexOf(path.join(home, "releases")) >= 0);
  t("purge-data 生效", plan(home, { purgeData: true }).purge.indexOf(path.join(home, "data")) >= 0);
  t("拒绝源码仓", (function () { const g = fs.mkdtempSync(path.join(os.tmpdir(), "lions-dev-")); fs.mkdirSync(path.join(g, ".git")); const r = refuseReason(g); fs.rmSync(g, { recursive: true, force: true }); return r && r.indexOf("源码仓") >= 0; })());
  t("拒绝 /", (refuseReason("/") || "").indexOf("家目录") >= 0 || (refuseReason("/") || "").length > 0);
  fs.rmSync(home, { recursive: true, force: true });
  console.log(bad === 0 ? "SELFTEST OK (7 断言)" : "SELFTEST FAILED (" + bad + ")");
  process.exit(bad === 0 ? 0 : 1);
}
function applyPlan(p) {
  const run = (c, a) => { try { spawnSync(c, a, { encoding: "utf8" }); } catch (_e) {} };
  for (const u of p.units) { run("systemctl", ["--user", "stop", u]); run("systemctl", ["--user", "disable", u]); }
  for (const f of p.unitFiles) { try { fs.rmSync(f, { force: true }); } catch (_e) {} }
  for (const d of p.dropins) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {} }
  run("systemctl", ["--user", "daemon-reload"]);
  for (const x of p.remove.concat(p.purge)) { try { fs.rmSync(x, { recursive: true, force: true }); } catch (_e) {} }
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) return selftest();
  const homeArg = args.find((a) => a.indexOf("--home=") === 0);
  const home = homeArg ? homeArg.slice(7) : null;
  if (!home) { console.error("缺 --home=DIR"); process.exit(3); }
  const reason = refuseReason(home);
  if (reason) { console.error(reason); process.exit(4); }
  const p = plan(home, { purgeData: args.includes("--purge-data"), purgeConfig: args.includes("--purge-config") });
  const doApply = args.includes("--apply") && args.includes("--yes");
  if (doApply) { fs.mkdirSync(path.join(p.home, "logs"), { recursive: true }); try { fs.appendFileSync(path.join(p.home, "logs", "uninstall-evidence.jsonl"), JSON.stringify({ at: new Date().toISOString(), action: "uninstall", version: p.version, units: p.units, purge: p.purge }) + "\n"); } catch (_e) {} applyPlan(p); }
  if (args.includes("--json")) process.stdout.write(JSON.stringify({ applied: doApply, plan: p }, null, 2) + "\n");
  else console.log(render(p, doApply));
}
main();
