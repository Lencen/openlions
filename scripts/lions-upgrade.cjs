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
 *   [--skip-deps] [--ignore-scripts-install] [--skip-generate] [--skip-migrate] [--skip-build] [--skip-start] [--no-systemctl] [--allow-edition-change]
 *   [--repair]   # 同版本换包：目标版本 == 当前版本，且树与产物有关键差异时才允许；不动库（强制 skip-migrate）
 *   [--replace-current]   # 仅与 --repair 配套：显式声明允许原地替换 current 指向的 release 目录（rm+cp）；
 *                          # 回退=去掉该 flag 即恢复原 guard 行为（拒绝替换并报错）；单独使用会被 preflight 拒绝
 *   [--unit-prefix=lions-qa-]
 *   # 【2026-11-24 02:40 运营团队 D2 裁定】原头注承诺 --simulate-fail=<step> 故障注入接缝，实现里没有（grep 只命中头注）。
 *   #   裁: 删承诺，不补实现 —— 理由是「演练用的假失败最容易被误当成真失败记进结论」（§12.81 同族），
 *   #   而删一句注释比新增一条会被用于制造假失败的分支更便宜也更安全。
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
const RV = require("./check-upgrade-runtime.cjs"); // C-DL-1（DEC-49）运行态校验
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
  // 【2026-11-24 02:40 运营团队 D3 裁定】此处打的是「不一致，随后自动同步并继续」，
  //   而判据原文以 FAIL 开头 -> 读日志的人会二选一误判（以为失败被吞 / 以为 FAIL 无害）。
  //   裁: 字样改 WARN，不改成 BLOCK（自动同步后 rc=0 是有意设计，改 BLOCK 会把能自愈的项变卡点）。
  console.log("[tools] WARN lions-tools 副本与仓库不一致（随后自动同步并继续；本 WARN 不是判据失败）");
  console.log(String(chk.stdout || "").trim().replace(/^FAIL /gm, "WARN "));
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
// 2026-11-04：portal 已开源（[team] 的 29cf57bb2/cbe4fecef 起，open 包合法包含 portal），
//   若仍把 portal 当闭源标记，"open 版产物"会被误判成 sales 并触发 editionGuard 拒绝升级（dev 实测）。
//   2026-11-16 运营团队裁决：real 口径 = **3 个闭源**（mcp-agent-chat-server / mcp-server / doc-portal，依据
//   scripts/open-source-boundary.json + _note(cbe4fecef) + c2a142c82）；此前「1 个哨兵」是过期实现
//   （注释把 portal（开源）与 doc-portal（闭源）混了）。改为**完整性判定**（fail-closed）：
//     present=0 -> open；present=3 -> sales；**0<present<3 -> WARN（不抛错）并按 sales 处理**（运营团队 2026-11-16 22:18 裁 C 折中）。
//   理由：升级行为变更（拒绝残缺包）留到 RC 后评估；现在用「1 哨兵语义（present>0 -> sales）+ 明确 WARN」让残缺可见但不改升级行为。
//   完整校验由 RC 双包「逐包核 3 目录」承担（dr 侧）。
const CLOSED_PACKAGES = ["packages/apps/mcp-agent-chat-server", "packages/apps/mcp-server", "packages/apps/doc-portal"];
function detectEdition(dir) {
  const present = CLOSED_PACKAGES.filter((x) => fs.existsSync(path.join(dir, x)));
  if (present.length === 0) return "open";
  if (present.length < CLOSED_PACKAGES.length) {
    const missing = CLOSED_PACKAGES.filter((x) => !present.some((p) => p === x));
    const msg = "[edition] 闭源目录残缺：present=" + present.length + "/" + CLOSED_PACKAGES.length + "（缺: " + missing.join(", ") + "）——按 sales 处理但可能功能残缺";
    console.warn(msg);   // WARN 必须清晰可见（stderr；调用方日志会收录）
    return "sales";     // 1 哨兵语义：present>0 -> sales（不拒绝升级）
  }
  return "sales";
}
/** 返回错误串或 null（fail-closed：edition 变更需显式放行）。 */
function editionGuard(fromEdition, toEdition, allow) { if (!fromEdition || !toEdition || fromEdition === toEdition || allow) return null; return "edition 不一致: 已装 " + fromEdition + " -> 新包 " + toEdition; }

function readInstall(home) {
  const rec = H.readInstallRecord(home);
  if (!rec || rec._unparsable) throw new Error("找不到 install.json（该安装根不是由 lions-install 装的）: " + H.installRecordPath(home));
  return rec;
}
function writeInstall(home, rec) { fs.writeFileSync(H.installRecordPath(home), JSON.stringify(rec, null, 2) + "\n"); }
/** edition-ts 纯函数（供 --selftest-p3）：升级成功后 install.json 的版本与时间戳刷新语义。
 *  2026-11-16 核实：主流程原本已内联这段逻辑（rec.version/updatedAt/installedAt），此处抽成纯函数只为
 *  「repair 成功刷 updatedAt」行为可机械判定（dr 门禁要求行为证据，不读文本）。语义不变。 */
function applyInstallRecord(rec, toVersion, nowIso) {
  const next = Object.assign({}, rec || {});
  next.version = toVersion;
  next.updatedAt = nowIso;
  next.installedAt = nowIso;   // 2026-11-03 约定：安装时间随升级刷新
  return next;
}
function evidence(home, obj) {
  const dir = H.logsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "upgrade-evidence.jsonl"), JSON.stringify(obj) + "\n");
}
function unitDir(args, rec) { return typeof args["systemd-dir"] === "string" ? path.resolve(args["systemd-dir"]) : (rec.systemdDir || path.join(os.homedir(), ".config", "systemd", "user")); }

// DEC-55（2026-11-13）：install.json 没有 systemdDir 不代表没有服务 —— apps[].unit 非空即视为有服务。
function hasAppsUnits(rec) { return !!(rec && rec.apps && Object.values(rec.apps).some((a) => a && a.unit)); }
function computeNoServices(rec, args) { return !!(args["skip-start"] || args["no-systemctl"] || (!rec.systemdDir && !hasAppsUnits(rec))); }
function unitStartEpoch(args, unit) {
  const r = sysctl(args, ["show", unit, "-p", "ExecMainStartTimestamp", "--value", "--timestamp=unix"]);
  return Number(String((r && (r.stdout || r.out)) || "").replace(/^@/, "").trim()) || 0;
}
function unitCwd(pid) { try { return fs.readlinkSync("/proc/" + pid + "/cwd"); } catch (_e) { return ""; } }
function realpath(p) { try { return fs.realpathSync(p); } catch (_e) { return p; } }
// DEC-55(b)：升级窗口内暂停会自动拉起服务的关键 timer（acceptance 等 Wants 本部署单元的）
function auxTimerBlockers(args, rec) {
  const ours = START_ORDER.map((a) => unitNameFor(args, rec, a)).filter(Boolean);
  const out = new Set(["lions-acceptance.timer", "lions-acceptance.service"]);
  const r = sysctl(args, ["list-timers", "--all", "--no-legend", "--no-pager"]);
  const txt = String((r && (r.stdout || r.stdoutText)) || "");
  for (const line of txt.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const unit = cols[cols.length - 2]; const act = cols[cols.length - 1];
    if (!unit || !unit.endsWith(".timer")) continue;
    const depR = sysctl(args, ["show", act, "-p", "Wants", "-p", "Requires"]);
    const dep = String((depR && (depR.stdout || depR.stdoutText)) || "");
    if (ours.some((u) => dep.includes(u))) { out.add(unit); out.add(act); }
  }
  return Array.from(out);
}
function stopAuxTimers(args, names) { const stopped = []; for (const n of names) { sysctl(args, ["stop", n]); stopped.push(n); } return stopped; }
function startAuxTimers(args, names) { for (const n of names) { if (n.endsWith(".timer")) sysctl(args, ["start", n]); } }
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
/** P3-余 纯函数（供 --selftest-p3）：PG 备份 0 库必 throw（dr ④c：「没有备份却报成功」= 假回滚点）。 */
function assertBackupNotEmpty(made, skipped) {
  if (made && made.length) return;
  throw new Error("PG 模式备份 0 库（无有效回滚点，拒绝静默通过）；逐 app 跳过原因: " +
    (skipped || []).map((s) => s.app + " -> " + s.why).join("；"));
}

/** P3-余 纯函数（供自检 --selftest-p3）：从 .env 解析某 app 的 PG URL，四态可分辨。
 *  2026-11-16（dr ④c + 双方共识）：空值（键在值空）与缺键分开报——grep -c 会被「行在值空」骗过，
 *  两者根因不同（缺键=生成逻辑没写、空值=写了但取不到值），修法也不同，混报会再误导一轮。
 *  返回 { url, why }：url 非空=可用；否则 why=跳过原因（含 env 路径由调用方拼接）。 */
function classifyEnvUrlSource(env, keyName) {
  const has = (k) => Object.prototype.hasOwnProperty.call(env, k);
  const val = (k) => (has(k) ? String(env[k] == null ? "" : env[k]).trim() : "");
  const keyVal = val(keyName);
  const dbVal = val("DATABASE_URL");
  if (has(keyName) && !keyVal) return { url: "", why: "键在值空（" + keyName + " 存在但为空）" };
  if (!has(keyName) && has("DATABASE_URL") && !dbVal) return { url: "", why: "缺键且 DATABASE_URL 行在值空（" + keyName + " 与 DATABASE_URL 均无有效值）" };
  if (!has(keyName) && !has("DATABASE_URL")) return { url: "", why: "缺键（" + keyName + " 与 DATABASE_URL 均不存在）" };
  const raw = (keyVal || dbVal).split("?")[0].trim();
  if (!raw) return { url: "", why: "URL 解析后为空（源=" + (keyVal ? keyName : "DATABASE_URL") + "）" };
  return { url: raw, why: "" };
}

function backupDbs(args, home, releaseDir, outDir) {
  // 2026-11-24 01:5x（运营团队 2026-11-20 11:02 五② 的未完成项，4 天后补）：**先确认备份根已挂载，再 mkdir**。
  //   旧顺序是 mkdirSync 先跑：外置盘没挂时 /media/operator/数据 只是系统盘上的空目录（AGENTS 四.1b 软链静默指回系统盘），
  //   于是备份写进 / —— 而升级恰恰是磁盘最紧张的时刻。fail-closed：抛错 -> 调用方走回滚分支，绝不写系统盘。
  require('./lib/mount-guard.cjs').assertBackupRoot(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const made = [];
  const skipped = [];
  // 2026-10-27 (运营团队): PG 安装没有 data/<app>/dev.db；用 pg_dump 做逻辑备份，不能报 0 库。
  let rec = {};
  try { rec = JSON.parse(fs.readFileSync(path.join(home, "install.json"), "utf8")); } catch (_e) {}
  if (rec.dbMode === "pg") {
    const keys = { mind: "MIND_DATABASE_URL", session: "SESSION_DATABASE_URL", selfimproving: "SELFIMPROVING_DATABASE_URL" };
    for (const app of DB_APPS) {
      const envPath = path.join(releaseDir, APPS[app].dir, ".env");
      if (!fs.existsSync(envPath)) { skipped.push({ app, why: "env 文件不存在: " + envPath }); continue; }
      const env = I.parseEnvFile(fs.readFileSync(envPath, "utf8"));
      // 2026-11-02（devops 线，主平台实测）：.env 里的 URL 可能带 Prisma 专用参数
      //   （?connection_limit=30&pool_timeout=30）。pg_dump/psql 不认 -> 去查询串（本逻辑在 classifyEnvUrlSource 内）。
      // 2026-11-16（P3-余）：跳过不再静默——四态原因留痕（空值 vs 缺键分开报），且 0 库不许通过。
      const src = classifyEnvUrlSource(env, keys[app]);
      if (!src.url) { skipped.push({ app, why: src.why + "（env=" + envPath + "）" }); continue; }
      const url = src.url;
      const dst = path.join(outDir, app + ".sql");
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      I.run("pg_dump", ["--no-owner", "--no-privileges", "-f", dst, url], { allowFail: false });
      made.push({ app, src: "postgres", dst, sha256: sha256File(dst) });
    }
    // 2026-11-16（P3-余 / dr ④c 采纳）：PG 模式 **0 库不得静默通过**——「没有备份却报成功」比跳过本身更危险。
    assertBackupNotEmpty(made, skipped);
    for (const s of skipped) log(args, "  ⚠ 备份跳过 " + s.app + ": " + s.why);
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
function startUnits(args, rec, opts) {
  // U-34 ③（2026-11-17 复验发现）：回滚时 current 已切回旧树，FIX_NOT_LIVE（"单元未加载新树"）
  //   是升级成功路径的判据，对回滚路径不适用（回滚后服务刚启动 pid 可能为 0/startSec 晚于 switch）。
  //   回滚调用方传 skipRuntimeVerify=true 跳过它，改由 rollbackServiceStatus 轮询端口探活。
  const skipRuntimeVerify = !!(opts && opts.skipRuntimeVerify);
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
    // DEC-55(c)：成功条件再加 cwd/start>=switch（复用 C-DL-1 判据；防 acceptance.timer 等在窗口内把旧树进程拉起）
    let switchMs = 0;
    try { switchMs = fs.lstatSync(H.currentLink(args.home)).mtimeMs; } catch (_e) { switchMs = 0; }
    let expectedRoot = "";
    try { expectedRoot = fs.realpathSync(H.currentLink(args.home)); } catch (_e) { expectedRoot = ""; }
    if (!skipRuntimeVerify && switchMs && expectedRoot) {
      const switchSec = Math.floor(switchMs / 1000);
      const bad = [];
      for (const app of START_ORDER) {
        const u = unitNameFor(args, rec, app);
        if (!u) continue;
        const pid = Number((sysctl(args, ["show", u, "-p", "MainPID", "--value"]) && sysctl(args, ["show", u, "-p", "MainPID", "--value"]).stdout) || "");
        const startSec = unitStartEpoch(args, u);
        const cwd = unitCwd(pid);
        const expect = path.join(expectedRoot, "packages", "apps", app);
        if (!(pid > 0 && startSec >= switchSec && cwd && realpath(cwd) === realpath(expect))) {
          bad.push(u + "(pid=" + pid + ",start=" + startSec + ",cwd=" + cwd + ",expect=" + expect + ",switch=" + switchSec + ")");
        }
      }
      if (bad.length) throw new Error("单元未加载新树（FIX_NOT_LIVE）：" + bad.join("; "));
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
//   否则 MiniMax/agent-d 的选择会被安装器/升级器悄悄带进新 release，覆盖 dev 的 .env.local。
//   模型只从 app 目录的 .env.local（dev override）或部署方显式注入来。
const RELEASE_MODEL_KEYS = new Set(["MINIMAX_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "REFLECT_MODEL"]);

// 2026-11-16（运营团队 15:26，P3 提前到 0.6.0）：pg 模式下每 app 必需的 DB URL 键缺/空即 fail-closed。
//   根因（本日五次发作：r4 console 丢键 / backup 恒 0 库 / mind 空值 / session+selfimproving 缺键 ...）：
//   regenerateEnv = example + oldEnv + buildAppEnv，**oldEnv 缺键即丢**，example 也无该键时
//   pairs 里根本没有 -> 写出的 .env 缺键 -> Prisma 初始化炸（静默产出坏 .env，升级却报成功）。
//   sqlite 不检查：schema 读 DATABASE_URL=file:...，PG 专属键只在 schema.postgres 里被读（空占位无害）。
const APP_PG_URL_KEY = { mind: "MIND_DATABASE_URL", session: "SESSION_DATABASE_URL", selfimproving: "SELFIMPROVING_DATABASE_URL", console: "MIND_DATABASE_URL" };
function maybeAssertPgUrlKey(isPg, app, pairs, examplePath, oldEnvPath) {
  if (!isPg) return; // sqlite 不检查
  const key = APP_PG_URL_KEY[app];
  if (!key) return;  // portal 等未取证 app 不检查
  const v = pairs[key];
  if (v !== undefined && String(v).trim() !== "") return;
  throw new Error(
    "regenerateEnv fail-closed: " + app + " 缺 " + key + "（或为空值）—— pg 模式禁止静默丢键。" +
    " 请在 example 补占位（" + examplePath + "）或确保旧 .env（" + oldEnvPath + "）有非空值后重跑。"
  );
}

// ── P3-余 ④b（2026-11-16 运营团队终裁 + dr 补强）：pgUrls 来源自愈 ──────────────
//   根因：pgUrls 全部取旧 .env 的同名键（oldEnv.X || ""），旧 .env 缺键/空值 -> example 也无 ->
//   66b647d9b 的 fail-closed 会 throw（升级失败、需人工补）。自愈让「缺键但本机能连上 PG」时自动修好。
//   来源优先级：① 旧 .env 同名键（现状）② 同 release 兄弟 app 的 .env 里现成 MIND_DATABASE_URL
//   （console/portal/mind）按库名约定派生 ③ config/pg-password + 默认口径（postgres@127.0.0.1:5432）。
//   ②③ 重建后必须 psql 连通验证（<=5s 超时），通不了仍 throw —— fail-closed 是地板、自愈只在真能修好时发生。
//   错误文案按 dr 补强分类：配置错（密码/库/用户不存在）vs PG 临时不可用（拒连/超时）。
const PG_APP_DB = { mind: "lions_mind", session: "lions_session", selfimproving: "lions_selfimproving" };
function maskPgUrl(u) { return String(u || "").replace(/:\/\/[^:@/]+:[^@/]+@/, "://***:***@"); }
/** 把 base URL 的库名替换为 db（保留 user:pass@host:port；去掉 Prisma 查询串）。 */
function derivePgUrl(baseUrl, db) {
  const noq = String(baseUrl || "").split("?")[0].trim();
  const i = noq.lastIndexOf("/");
  if (i <= "postgresql://".length) return "";
  return noq.slice(0, i + 1) + db;
}
/** 探测错误分类（dr 补强：两种情况都 throw，只是文案让人一眼分辨配置问题还是服务问题）。 */
function classifyPgProbeError(text) {
  const s = String(text || "");
  if (/password authentication failed/i.test(s)) return "配置错误：密码不对（核 config/pg-password 与 .env 是否同源）";
  if (/database "[^"]*" does not exist/i.test(s)) return "配置错误：库名不存在（核库名约定 lions_<app>）";
  if (/role "[^"]*" does not exist/i.test(s)) return "配置错误：用户不存在";
  if (/Connection refused|ECONNREFUSED|could not connect|no route to host/i.test(s)) return "PG 临时不可用（服务未起/拒连，恢复后重跑即可，配置可能正确）";
  if (/timeout|timed out/i.test(s)) return "PG 临时不可用（探测超时，恢复后重跑即可）";
  return "探测失败（原因见原文）";
}
function probePgUrl(url, timeoutMs) {
  const r = spawnSync("psql", [url, "-At", "-c", "select 1"], { encoding: "utf8", timeout: timeoutMs || 5000 });
  if (r.status === 0 && String(r.stdout || "").trim() === "1") return { ok: true, why: "" };
  const err = String(r.stderr || (r.error && r.error.message) || "");
  const code = (r.error && r.error.code) || "";
  return { ok: false, why: classifyPgProbeError(err + " " + code) + " [探测原文: " + (err + " " + code).trim().slice(0, 160) + "]" };
}
/** 自愈解析三 app 的 PG URL（纯逻辑 + 注入 probe/log，便于 --selftest-p3）。 */
function resolvePgUrls(ctx, oldEnv, fromRelease, opts) {
  const o = opts || {};
  const probe = o.probe || probePgUrl;
  const logFn = o.log || (() => {});
  const out = {};
  const rebuilt = [];
  for (const app of ["mind", "session", "selfimproving"]) {
    const keyName = APP_PG_URL_KEY[app];
    const fromEnv = String((oldEnv && oldEnv[keyName]) || "").trim();
    // U-34 ① 边界（2026-11-17 复验发现）：oldEnv 可能含 .env.example 遗留的 sqlite URL
    //   （如 DATABASE_URL=file:./prisma/dev.db），非 PG URL 必须跳过，不能当 fromEnv 用。
    if (fromEnv && /^postgresql:\/\//.test(fromEnv)) { out[app] = fromEnv; continue; }
    let cand = "", src = "";
    for (const sib of ["console", "portal", "mind"]) {
      if (!APPS[sib] || sib === app) continue;
      const p = path.join(fromRelease, APPS[sib].dir, ".env");
      if (!fs.existsSync(p)) continue;
      let base = "";
      try { base = String(I.parseEnvFile(fs.readFileSync(p, "utf8")).MIND_DATABASE_URL || "").trim(); } catch (_e) {}
      // U-34 ① 边界：同样跳过 sqlite/空 URL
      if (!base || !/^postgresql:\/\//.test(base)) continue;
      cand = derivePgUrl(base, PG_APP_DB[app]);
      if (cand) { src = sib + "/.env:MIND_DATABASE_URL"; break; }
    }
    if (!cand) {
      const pwPath = path.join(ctx.home, "config", "pg-password");
      let pw = "";
      try { pw = fs.readFileSync(pwPath, "utf8").trim(); } catch (_e) {}
      if (pw.length >= 8) {
        // U-34 ①（2026-11-17 运营团队立项）：端口**不写死 5432**——从旧 release 的 .env 里
        //   DATABASE_URL / MIND_DATABASE_URL 取真实端口（test 实际 55433，prod 5432）。
        //   旧实现在此分支硬编码 5432，同版本 repair 时触达 -> 连错端口 -> fail-closed -> 回滚也失败。
        // U-34 ① 边界（2026-11-17 复验发现）：baseline 的 mind/.env 里 DATABASE_URL 是
        //   .env.example 遗留的 file:./prisma/dev.db（sqlite）-> 先命中 file: 解析失败。
        //   修法：跳过非 postgresql:// 的 URL；并按 app 优先取对应变量（mind->MIND_DATABASE_URL，
        //   session->SESSION_DATABASE_URL，selfimproving->SELFIMPROVING_DATABASE_URL），其次通用 DATABASE_URL。
        const portKeyByApp = { mind: "MIND_DATABASE_URL", session: "SESSION_DATABASE_URL", selfimproving: "SELFIMPROVING_DATABASE_URL" };
        let port = "";
        for (const a2 of ["mind", "session", "selfimproving", "console", "portal"]) {
          if (!APPS[a2]) continue;
          // U-34 ①（2026-11-17 19:04 devops 复验）：同版本 repair 时 fromRelease 已被 stage 覆盖
          //   （.env/.next MISSING），且 baseline 快照是扁平布局 -> 统一用 readOldEnvPath 读旧 env。
          const p2 = readOldEnvPath(fromRelease, a2);
          if (!p2) continue;
          try {
            const e2 = I.parseEnvFile(fs.readFileSync(p2, "utf8"));
            const keys = [portKeyByApp[a2] || "", "DATABASE_URL", "MIND_DATABASE_URL"];
            for (const k of keys) {
              if (!k) continue;
              const u = String(e2[k] || "").trim();
              if (!u || !/^postgresql:\/\//.test(u)) continue;  // 跳过 file:/空
              const m = /^postgresql:\/\/[^@]+@[^:/]+:(\d+)\//.exec(u);
              if (m) { port = m[1]; break; }
            }
            if (port) break;
          } catch (_e) {}
        }
        if (!port) {
          throw new Error("regenerateEnv fail-closed(自愈失败): " + app + " 需重建 PG URL，但旧 release（" +
            fromRelease + "）的 .env 里找不到 DATABASE_URL 的端口；不写死 5432 兜底（U-34 ①）。" +
            "请补旧 .env 的 DATABASE_URL 或显式提供 config/pg-password+端口后重跑。");
        }
        cand = "postgresql://postgres:" + encodeURIComponent(pw) + "@127.0.0.1:" + port + "/" + PG_APP_DB[app];
        src = "config/pg-password+旧.env端口(" + port + ")";
      }
    }
    if (!cand) {
      throw new Error("regenerateEnv fail-closed(自愈失败): " + app + " 的 " + keyName + " 为空/缺失，" +
        "兄弟 .env 与 config/pg-password 均无法重建。请补旧 .env（" + fromRelease + "）的值后重跑。");
    }
    const pr = probe(cand, 5000);
    if (!pr.ok) {
      throw new Error("regenerateEnv fail-closed(自愈探测失败): " + app + " 重建的 URL 连通失败 —— " + pr.why +
        "；URL=" + maskPgUrl(cand) + "（源=" + src + "）。");
    }
    out[app] = cand;
    rebuilt.push(app + "(源=" + src + ")");
  }
  if (rebuilt.length) logFn("  ↺ pgUrls 自愈重建 " + rebuilt.length + " 项: " + rebuilt.join("，") + "；已 psql 连通验证 OK");
  return out;
}

function regenerateEnv(ctx, newRelease, oldRelease) {
  const written = [];
  // 2026-11-16 22:2x hotfix（运营团队，r6 实撞）：同版本 repair 时 stageRelease 已 rm+cp 覆盖目标目录，
  //   oldRelease === newRelease，旧 .env 随之丢失 -> regenerateEnv 读不到 MIGRATE URL，回落到
  //   config/pg-password+127.0.0.1:5432（test 实际 55433）-> fail-closed -> 回滚也失败 -> 毁掉可运行树。
  //   修法：同目录时改用 stage 前快照 <home>/backups/repair-env-baseline-<ts>/ 作旧 .env 来源。
  const envOld = (oldRelease && oldRelease !== newRelease) ? oldRelease : (ctx.repairEnvBaselineDir || oldRelease);
  // P3-余 ④b：pgUrls 在三 app 循环外算一次（自愈可能触发 psql 探测，不能每 app 重探）；预读旧 .env 判 isPg。
  const prevEnvs = {};
  for (const app of START_ORDER) {
    if (!APPS[app]) continue;
    const p = readOldEnvPath(envOld, app);  // U-34 ①：兼容 baseline 扁平布局
    if (!p) continue;
    try { prevEnvs[app] = I.parseEnvFile(fs.readFileSync(p, "utf8")); } catch (_e) {}
  }
  const drvKeys = { mind: "MIND_DB_DRIVER", session: "SESSION_DB_DRIVER", selfimproving: "SELFIMPROVING_DB_DRIVER" };
  // U-34 ④（2026-11-17 运营团队立项）：实际 .env 里 session/selfimproving 也写 MIND_DB_DRIVER（不写
  //   SESSION_DB_DRIVER/SELFIMPROVING_DB_DRIVER）-> 只按驱动键判断会误判 sqlite -> 静默兜底。
  //   统一口径：ctx.dbMode=pg **或** 任一 app 的 .env 有 postgresql:// URL **或** 驱动键=pg。
  const isPgUrl = (e2) => /^postgresql:\/\//.test(String((e2 && (e2.DATABASE_URL || e2.MIND_DATABASE_URL)) || "").trim());
  const pgMode = ctx.dbMode === "pg" ||
    ["mind", "session", "selfimproving"].some((a) => prevEnvs[a] && (prevEnvs[a][drvKeys[a]] === "pg" || isPgUrl(prevEnvs[a])));
  let resolvedPgUrls = null;
  if (pgMode) {
    const merged = Object.assign({}, prevEnvs.mind || {}, prevEnvs.session || {}, prevEnvs.selfimproving || {});
    resolvedPgUrls = resolvePgUrls(ctx, merged, envOld, { log: (m) => (ctx.args ? log(ctx.args, m) : console.log(m)) });
  }
  for (const app of START_ORDER) {
    const appDir = path.join(newRelease, APPS[app].dir);
    // 2026-10-27 (运营团队): open 版导出没有 portal 目录；升级不能对它写 .env。
    if (!fs.existsSync(appDir)) continue;
    const examplePath = path.join(appDir, ".env.example");
    const exampleEnv = fs.existsSync(examplePath) ? I.parseEnvFile(fs.readFileSync(examplePath, "utf8")) : {};
    const oldEnvPath = readOldEnvPath(envOld, app);  // U-34 ①：兼容 baseline 扁平布局
    const oldEnvRaw = oldEnvPath ? I.parseEnvFile(fs.readFileSync(oldEnvPath, "utf8")) : {};
    // 不继承生成模型键；.env.local override 不在此文件，升级不会覆盖它。
    const oldEnv = Object.fromEntries(Object.entries(oldEnvRaw).filter(([k]) => !RELEASE_MODEL_KEYS.has(k)));
    const answers = Object.assign({}, oldEnv);
    const isPg = ctx.dbMode === "pg" || isPgUrl(oldEnv) || oldEnv.MIND_DB_DRIVER === "pg" ||
      oldEnv.SESSION_DB_DRIVER === "pg" || oldEnv.SELFIMPROVING_DB_DRIVER === "pg";
    const pairs = I.buildAppEnv(app, {
      home: ctx.home, ports: ctx.ports, answers, exampleEnv,
      dbMode: isPg ? "pg" : "sqlite",
      // P3-余 ④b：pg 模式用自愈解析结果（含连通验证）；sqlite 模式保持旧值（不参与）
      pgUrls: resolvedPgUrls || {
        mind: oldEnv.MIND_DATABASE_URL || "",
        session: oldEnv.SESSION_DATABASE_URL || "",
        selfimproving: oldEnv.SELFIMPROVING_DATABASE_URL || "",
      },
    });
    for (const k of Object.keys(oldEnv)) if (pairs[k] === undefined) pairs[k] = oldEnv[k];
    // 写盘前 fail-closed：宁可升级失败，不产出坏 .env（P3，2026-11-16 运营团队 15:26）
    maybeAssertPgUrlKey(isPg, app, pairs, examplePath, oldEnvPath);
    const envPath = path.join(appDir, ".env");
    fs.writeFileSync(envPath, I.renderEnv(pairs), { mode: 0o600 });
    try { fs.chmodSync(envPath, 0o600); } catch (_e) {}
    written.push(app);
  }
  return written;
}

// 2026-11-10（同版本 repair 自基线缺陷，DEC-20261110 后续）：
//   同版本 repair 时 stageRelease 先 rm 再 cp 到同一路径 -> regenerateEnv 的 oldRelease
//   与 newRelease 指向同一目录，.env 基线=新包自身（无 MIND/SESSION/SELFIMPROVING_DATABASE_URL）
//   -> mind/session/selfimproving 起不来 -> health 失败 -> 回滚。
//   修法：stage 前把旧 release 的 .env 快照到 `<home>/backups/repair-env-baseline-<ts>/`，
//   stage 后把基线中**缺失**的 KEY 合并回新 release 的 .env（只补缺，不覆盖新值）。
/** U-34 ①（2026-11-17 19:04 devops 复验实证）：baseline 快照写的是**扁平** baseline/<app>.env，
 *  而读取旧 env 时用的是嵌套 path.join(envOld, APPS[app].dir, ".env") -> 永远不存在 -> prevEnvs 空。
 *  本函数统一布局：优先扁平 <envOld>/<app>.env；不存在再回退嵌套 <envOld>/packages/apps/<app>/.env。 */
function readOldEnvPath(envOld, app) {
  const flat = path.join(envOld, app + ".env");
  if (fs.existsSync(flat)) return flat;
  const nested = path.join(envOld, APPS[app].dir, ".env");
  if (fs.existsSync(nested)) return nested;
  return "";
}

function snapshotRepairEnvBaseline(fromRelease, dir) {
  const got = [];
  for (const app of START_ORDER) {
    const f = path.join(fromRelease, APPS[app].dir, ".env");
    if (!fs.existsSync(f)) continue;
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, app + ".env");
    fs.copyFileSync(f, dst);
    try { fs.chmodSync(dst, 0o600); } catch (_e) {}
    got.push(app);
  }
  return got;
}

function mergeEnvText(baselineText, targetText) {
  // 纯函数：把 baseline 中 target 缺失的 KEY 追加到 target（保留 target 原内容与顺序）。
  const parse = (t) => {
    const m = new Map();
    for (const line of String(t).split(/\r?\n/)) {
      const mm = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (mm) m.set(mm[1], line.trim());
    }
    return m;
  };
  const b = parse(baselineText), t = parse(targetText);
  const missing = [...b.keys()].filter((k) => !t.has(k));
  if (!missing.length) return { text: targetText, added: [] };
  const text = String(targetText).replace(/\s*$/, "") + "\n" + missing.map((k) => b.get(k)).join("\n") + "\n";
  return { text, added: missing };
}

function mergeRepairEnvBaseline(dir, newRelease) {
  if (!dir) return 0;
  let added = 0;
  for (const app of START_ORDER) {
    const bf = path.join(dir, app + ".env");
    const tf = path.join(newRelease, APPS[app].dir, ".env");
    if (!fs.existsSync(bf) || !fs.existsSync(tf)) continue;
    const r = mergeEnvText(fs.readFileSync(bf, "utf8"), fs.readFileSync(tf, "utf8"));
    if (r.added.length) { fs.writeFileSync(tf, r.text, { mode: 0o600 }); added += r.added.length; }
  }
  return added;
}

// 2026-11-12（DEC-37 P1-4）：升级脚本错误分类——区分 EACCES（权限/不可读 cwd）与 ENOENT（缺包）。
//   背景：2026-11-10 test 升级因 cwd=~/lions 对 test 不可读，pnpm spawn 返回 EACCES，
//   旧代码统一抛“缺 pnpm”，导致根因误判。
function classifyPnpmFailure(cwdOverride) {
  const cwd = cwdOverride || process.cwd();
  const probes = [
    { cmd: "pnpm", pre: [] },
    { cmd: "corepack", pre: ["pnpm"] },
  ];
  const errs = [];
  for (const p of probes) {
    const r = spawnSync(p.cmd, p.pre.concat(["--version"]), { encoding: "utf8", timeout: 20000, cwd });
    if (r.status === 0) return { ok: true, cmd: p.cmd, pre: p.pre, version: String(r.stdout || "").trim(), cwd };
    const code = (r.error && r.error.code) || ("status=" + (r.status === null ? "null" : String(r.status)));
    errs.push(code);
  }
  const eacces = errs.some((c) => c === "EACCES" || c === "EPERM");
  if (eacces) {
    return { ok: false, cls: "EACCES", cwd, errs,
      msg: "pnpm 不可执行/无权限（EACCES/EPERM）：cwd 或 PATH 不可读/无执行权限（spawn 探针=" + errs.join(",") + "）—— 请 cd 到可读目录（如 /media/operator/数据/tmp-work）后重试；这不是缺 pnpm" };
  }
  return { ok: false, cls: "ENOENT", cwd, errs,
    msg: "缺 pnpm（pnpm/corepack 均未找到，spawn 探针=" + errs.join(",") + "）—— 请安装 pnpm 或 corepack enable" };
}

function resolvePnpmOrThrow() {
  const r = classifyPnpmFailure();
  if (!r.ok) throw new Error("[pnpm-classify:" + r.cls + "] " + r.msg);
  return { cmd: r.cmd, pre: r.pre, version: r.version };
}

/** P1 纯函数（供自检 --selftest-p1p2）：目标目录与 current 同目录时的动作。
 *  2026-11-16（运营团队终裁 A · P1 / devops-release 缺陷报备）：同版本 --repair 时 staged 目录 ==
 *  current 指向目录属正常形态，旧实现无条件拒绝 -> repair 永远无法对正在运行的树换包（test 实撞）。
 *  --replace-current 由调用方显式声明，preflight 保证只与 --repair 同用。 */
function sameTargetAction(curTarget, releaseDir, replaceCurrent) {
  if (curTarget !== releaseDir) return "other";
  return replaceCurrent ? "replace" : "throw";
}

/** U-34⑤ 快照根目录：优先外置盘（/media/operator/数据/系统盘迁移/release-snapshots，256G 可用），
 *  否则回落 releases/（系统盘，87% 接近 88% 守卫线）。 */
function snapshotRoot(home) {
  const ext = "/media/operator/数据/系统盘迁移/release-snapshots";
  try {
    if (fs.existsSync("/media/operator/数据")) { fs.mkdirSync(ext, { recursive: true }); return ext; }
  } catch (_e) {}
  return H.releasesDir(home);
}

/** 当前系统盘使用率（%）。用于 U-34⑤ 水位检查：>85 只快照关键文件；>90 跳过快照。 */
function diskUsedPct() {
  try {
    const r = spawnSync("df", ["-k", "/"], { encoding: "utf8" });
    const line = String(r.stdout || "").split("\n")[1] || "";
    const p = line.split(/\s+/);
    const used = Number(p[2]), avail = Number(p[3]);
    if (used > 0 && avail > 0) return Math.round((used / (used + avail)) * 100);
  } catch (_e) {}
  return 0;
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
    const act = sameTargetAction(curTarget, releaseDir, !!args["replace-current"]);
    if (act === "throw") {
      throw new Error("目标目录就是当前运行目录: " + releaseDir +
        "（同版本换包请加 --repair --replace-current 显式声明原地替换；否则请先把 current 切走）");
    }
    if (act === "replace") log(args, "  ⚠ --replace-current: current 指向目标目录，将原地替换（rm+cp）: " + releaseDir);
    // U-34 第五条（2026-11-18 运营团队 01:22 开工令）：同版本 repair 的 rm 会毁掉旧树
    //   （.env/.next/node_modules）-> rm 前整体快照到 <releases>/<ver>.bak-<ts>/，回滚可 link 快照。
    //   · 限最近 2 份（系统盘 87% 接近红线；单份 1.5-2G，2 份约 3-4G）；
    //   · 快照失败不阻断升级（记日志、继续原流程）——快照是增强，不是前置。
    try {
      const root = snapshotRoot(home);
      const pct = diskUsedPct();
      // 水位检查（运营团队 01:50）：>90 跳过；>85 只快照关键文件（.env/.next/BUILD_ID，不复制 node_modules）。
      if (pct > 90) {
        log(args, "  ⚠ U-34⑤ 系统盘 " + pct + "% (>90%) -> 跳过快照（回滚将退回 fromRelease）");
      } else {
        const keyOnly = pct > 85;
        const snapDir = path.join(root, version + ".bak-" + ts());
        if (keyOnly) {
          log(args, "  ↺ U-34⑤ 系统盘 " + pct + "% (>85%) -> 只快照关键文件（.env/.next/BUILD_ID）");
          const appDirs = fs.readdirSync(releaseDir).includes("packages") ? [] : [];
          fs.mkdirSync(snapDir, { recursive: true });
          const appsBase = path.join(releaseDir, "packages", "apps");
          if (fs.existsSync(appsBase)) {
            for (const an of fs.readdirSync(appsBase)) {
              const ad = path.join(appsBase, an);
              if (!fs.existsSync(path.join(ad, "package.json"))) continue;
              const dst = path.join(snapDir, "packages", "apps", an);
              fs.mkdirSync(dst, { recursive: true });
              for (const k of [".env", ".env.local", ".next"]) {
                const src = path.join(ad, k);
                if (!fs.existsSync(src)) continue;
                try { fs.cpSync(src, path.join(dst, k), { recursive: true, dereference: false }); } catch (_e) {}
              }
            }
          }
          // 关键顶层文件
          for (const k of ["VERSION", "pnpm-lock.yaml", "install.json"]) {
            const src = path.join(releaseDir, k);
            if (fs.existsSync(src)) { try { fs.cpSync(src, path.join(snapDir, k)); } catch (_e) {} }
          }
        } else {
          fs.cpSync(releaseDir, snapDir, { recursive: true, dereference: false });
          log(args, "  ↺ U-34⑤ 旧树快照（全量，系统盘 " + pct + "%）: " + snapDir);
        }
        // 清理旧快照（保留最近 2 份，外置盘同理）
        const snaps = fs.readdirSync(root).filter((n) => n.startsWith(version + ".bak-")).sort();
        while (snaps.length > 2) {
          const old = snaps.shift();
          fs.rmSync(path.join(root, old), { recursive: true, force: true });
          log(args, "  ↺ U-34⑤ 清理旧快照（保留 2 份）: " + old);
        }
      }
    } catch (e) {
      log(args, "  ⚠ U-34⑤ 快照失败（不阻断升级）: " + e.message);
    }
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(releaseDir), { recursive: true });
  fs.cpSync(srcDir, releaseDir, { recursive: true, dereference: false, filter: (s) => { const b = path.basename(s); return b !== ".git" && b !== "node_modules"; } });
  return { version, releaseDir };
}
/** U-34 第五条（2026-11-18 运营团队 01:22 开工令）：回滚目标选择——
 *  优先同版本快照（releases/<ver>.bak-*，最近一份），否则退回原 fromRelease。
 *  原因：同版本 repair 的 stageRelease 已 rm+cp 覆盖 releases/<ver>，原 fromRelease 可能缺 .env/.next。 */
function pickRollbackTarget(args, home, fromRelease) {
  try {
    // U-34⑤（运营团队 01:50）：快照优先落外置盘 snapshotRoot()，回滚也从同一根找。
    const relRoot = snapshotRoot(home);
    const ver = path.basename(fromRelease);
    const snaps = fs.existsSync(relRoot) ? fs.readdirSync(relRoot).filter((n) => n.startsWith(ver + ".bak-")).sort() : [];
    if (snaps.length) {
      const last = snaps[snaps.length - 1];
      log(args, "  ↺ U-34⑤ 回滚目标改用快照: " + last);
      return path.join(relRoot, last);
    }
  } catch (_e) {}
  return fromRelease;
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

/** P2a 纯函数（供自检 --selftest-p1p2）：回滚后的 verdict 三态。
 *  2026-11-16（终裁 A · P2a / dr 缺陷报备）：同版本 repair 失败时 linkCurrent(fromRelease) 与 staged
 *  同路径 = 回滚 no-op（current 从未切走）；此时记 ROLLBACK_FAILED 会假装"旧状态已恢复"，
 *  正是本轮三方绕三圈的真源头。samePath=同版本 repair。 */
function rollbackVerdict(samePath, healthy) {
  if (healthy) return "ROLLED_BACK_OK";
  return samePath ? "ROLLBACK_NOOP_SAMEPATH" : "ROLLBACK_FAILED";
}

/** P2b 纯函数（供自检 --selftest-p1p2）：健康行 = "探针path=状态码" 或 "探针path 失败形态"。
 *  2026-11-16（终裁 A · P2b）：旧日志只有「✗ app :port」，失败被误诊成「探针打 /api/health 404」
 *  （实际探针走 healthPaths 单一来源，且 404 属于 waitHealth 的通过区间）。 */
function healthLine(app, port, h) {
  const fallback = (APPS[app] && APPS[app].healthPaths && APPS[app].healthPaths[0]) || "/";
  const p = (h && h.path) || fallback;
  if (h && h.ok) return String(p) + "=" + (h.status || 200);
  const why = (h && h.how) || (h && h.status ? "http=" + h.status : "no-response");
  return String(p) + " " + why;
}

/** U-34 ③（2026-11-17 复验）：回滚后服务状态回执 —— 每 unit active/failed + 每端口 http 码。
 *  运营团队要求：回滚失败时不得只 return，必须带 rollbackServiceStatus 让调用者/运维看到具体哪 unit/哪个端口挂了。 */
function collectRollbackServiceStatus(args, rec) {
  const units = {}, portMap = {};
  const portList = (rec && rec.ports) || {};
  for (const app of START_ORDER) {
    const u = unitNameFor(args, rec, app);
    if (!u) continue;
    try {
      const r = sysctl(args, ["is-active", u]);
      units[u] = String((r && r.stdout) || "").trim() || "unknown";
    } catch (_e) { units[u] = "unknown"; }
    const p = portList[app];
    if (p) {
      try {
        const r = require("child_process").spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8", "http://127.0.0.1:" + p + "/"], { encoding: "utf8" });
        portMap[String(p)] = String(r.stdout || "000").trim() || "000";
      } catch (_e) { portMap[String(p)] = "000"; }
    }
  }
  return { units, ports: portMap, at: new Date().toISOString() };
}

async function healthAll(args, rec, ports) {
  const out = {};
  for (const app of START_ORDER) {
    // 2026-11-02（devops 线，dev 实测）：open 版没有 portal，但 START_ORDER 里有；
    //   旧实现会对 portal 的 14006 做健康检查并判红，把一次**成功的回滚**写成 ROLLBACK_FAILED
    //   （假失败比不判更危险：运维会以为回滚也坏了）。产物里没有的 app 一律跳过。
    if (!APPS[app]) continue;
    if (rec && rec.apps && !rec.apps[app]) continue;
    const h = await I.waitHealth(app, ports[app], 90000);
    out[app] = h;
    // P2b（终裁 A）：带上探针 path 与失败形态；失败不再是"✗ app :port"这种猜谜行。
    log(args, "    " + (h.ok ? "✓" : "✗") + " " + app + " :" + ports[app] + " " + healthLine(app, ports[app], h));
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
  const markSkipped = (name, detail) => { steps.push({ name, ok: false, skipped: true, detail: detail || "skipped" }); log(args, "[" + steps.length + "] " + name + " — " + (detail || "skipped") + "（skipped: ok=false）"); };

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
  // P1（2026-11-16 终裁 A）：--replace-current 是"原地替换正在运行的树"的显式声明，
  //   只允许与 --repair 同用（跨版本升级没有原地替换语义）。
  if (args["replace-current"] && !isRepair) fail("preflight", "--replace-current 仅可与 --repair 同用（同版本原地换包）");
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
  const noServices = computeNoServices(rec, args);
  try { ensureToolsReplica(false); } catch (e) { fail("preflight", String(e.message)); }
  mark("preflight", fromVersion + " -> " + toVersion + "（" + (args["dry-run"] ? "dry-run" : "real") + "）");
  if (args["dry-run"]) { cleanupStaging(staging); return { ok: true, dryRun: true, from: fromVersion, to: toVersion, steps }; }

  // 2 backup
  const backupDir = path.join(H.backupsDir(home), ts());
  const backups = args["skip-backup"] ? [] : backupDbs(args, home, fromRelease, backupDir);
  mark("backup", backups.length + " 库 -> " + backupDir);
  evidence(home, { schema: SCHEMA, phase: "start", from: fromVersion, to: toVersion, fromEdition, toEdition, at: startedAt, backupDir, backups: backups.map((b) => ({ app: b.app, sha256: b.sha256 })) });

  // 3 stop（2026-11-14 P0 修正：先停会拉起 5 unit 的 timer，再停单元）
  // 事故：lions-acceptance.timer（OnCalendar=*:0/10）在 stop 与 timers-stopped 之间触发，
  // 经 Wants=lions-mind.service 把旧树 mind 拉起 → FIX_NOT_LIVE → 自动回滚。
  // 故顺序改为：timers 先停（含 service），再 stopUnits。
  let auxStopped = [];
  try { auxStopped = stopAuxTimers(args, auxTimerBlockers(args, rec)); mark("timers-stopped", auxStopped.length + " 个: " + auxStopped.join(",")); } catch (_e) { markSkipped("timers-stopped", "未能暂停（fail-open 记录）: " + _e.message); }
  stopUnits(args, rec);
  mark("stop", "服务已停（Restart=no drop-in 已写；timers 已先停）");

  let switched = false;
  try {
    // 4 apply
    // 2026-11-10（同版本 repair 自基线缺陷）：stage 前快照旧 release 的 .env（stage 会覆盖同路径）。
    let repairEnvBaseline = null;
    if (isRepair && fromRelease && fs.existsSync(fromRelease)) {
      repairEnvBaseline = path.join(H.backupsDir(home), "repair-env-baseline-" + ts());
      const envApps = snapshotRepairEnvBaseline(fromRelease, repairEnvBaseline);
      mark("repair-env-baseline", envApps.length + " app -> " + repairEnvBaseline);
    }
    const staged = stageRelease(args, home, srcDir);
    // 2026-10-29 (运营团队): 升级解包可能丢可执行位；systemd 直接执行 wrapper，必须 0755。
    try { fs.chmodSync(path.join(staged.releaseDir, "scripts", "lions-service-wrapper.sh"), 0o755); } catch (_e) {}
    regenerateEnv({ home, ports, dbMode: rec.dbMode, answers: {}, args, repairEnvBaselineDir: repairEnvBaseline }, staged.releaseDir, fromRelease);
    // 2026-11-10：同版本 repair 时 fromRelease==staged.releaseDir（已被 stage 覆盖），
    //   用 stage 前快照把缺失键（含 MIND/SESSION/SELFIMPROVING_DATABASE_URL）合并回新 .env。
    const repairEnvAdded = mergeRepairEnvBaseline(repairEnvBaseline, staged.releaseDir);
    if (!args["skip-deps"]) {
      const pnpm = resolvePnpmOrThrow();
      const hasLock = fs.existsSync(path.join(staged.releaseDir, "pnpm-lock.yaml"));
      // 2026-10-27 (运营团队): open 导出没有 lockfile；不能再用 --frozen-lockfile。
      // 2026-11-14: canvas 等可选依赖的 postinstall 会联网下载（Node22 ABI 无预编译）导致 install 挂起；
  //   提供 --ignore-scripts-install 只在本步跳过依赖生命周期脚本（build 步骤不受影响）。
  const depArgs = ["install", hasLock ? "--frozen-lockfile" : "--no-frozen-lockfile"];
  if (args["ignore-scripts-install"]) depArgs.push("--ignore-scripts");
  I.run(pnpm.cmd, pnpm.pre.concat(depArgs), { cwd: staged.releaseDir });
    }
    if (!args["skip-generate"]) generateAll(staged.releaseDir, home);
    mark("apply", toVersion + " -> " + staged.releaseDir + (repairEnvAdded ? "（repair .env 基线合并 " + repairEnvAdded + " 键）" : ""));

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
    startAuxTimers(args, auxStopped);
    mark("switch", "current -> " + toVersion);
    const health = noServices ? { skipped: true } : await healthAll(args, rec, ports);
    const healthy = health.skipped || Object.values(health).every((h) => h.ok);
    if (!healthy) fail("health", "上线后健康检查未通过");
    if (health.skipped) markSkipped("health", "skipped(noServices)"); else mark("health", "全部通过");

    // C-DL-1（DEC-49，2026-11-13）：运行态校验 —— 每个 unit 必须真实加载新树
    //   （MainPID start >= current 切换时刻；/proc/<pid>/cwd = releases/<toVersion>/packages/apps/<app>）
    //   不满足自动 restart 一次再复验；仍失败 => FIX_NOT_LIVE：写证据并失败返回（不静默、不自动切回文件）。
    let runtimeSkipped = false;
    if (args["skip-runtime-verify"]) {
      runtimeSkipped = true;
      log(args, "  ⚠ runtime verify skipped（--skip-runtime-verify）：verdict=UPGRADED_SKIP_VERIFY");
      evidence(home, { schema: SCHEMA, phase: "runtime_verify_skipped", at: new Date().toISOString(), reason: "--skip-runtime-verify", steps });
      markSkipped("runtime-verify", "skipped(--skip-runtime-verify) -> UPGRADED_SKIP_VERIFY");
    } else if (!noServices) {
      const rv = await RV.verifyRuntime({ home, toVersion, timeoutSec: Number(args["runtime-verify-timeout"]) || 60, repair: true });
      for (const u of rv.units) evidence(home, Object.assign({ schema: SCHEMA, phase: "runtime_verify", at: new Date().toISOString() }, u));
      if (!rv.ok) {
        evidence(home, { schema: SCHEMA, phase: "done", from: fromVersion, to: toVersion, verdict: "FIX_NOT_LIVE", failed: rv.failed, steps, at: new Date().toISOString(),
          rollbackHint: "bash scripts/prod-down-up.sh --action=stop; ln -sfn releases/" + fromVersion + " current; bash scripts/prod-down-up.sh --action=start（见 RUNBOOK）" });
        log(args, "  ✗ runtime-verify 失败（FIX_NOT_LIVE）: " + rv.failed.join(",") + "；current 仍指向 " + toVersion + "，按 RUNBOOK 回滚（不自动切回）");
        cleanupStaging(staging);
        return { ok: false, fixNotLive: true, from: fromVersion, to: toVersion, steps, backupDir, failed: rv.failed, runtimeVerify: rv.units };
      }
      mark("runtime-verify", rv.summary);
    } else {
      runtimeSkipped = true;
      markSkipped("runtime-verify", "skipped(noServices)");
    }

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

    Object.assign(rec, applyInstallRecord(rec, toVersion, new Date().toISOString()));
    writeInstall(home, rec);
    mark("record", H.installRecordPath(home));
    evidence(home, { schema: SCHEMA, phase: "done", from: fromVersion, to: toVersion, verdict: runtimeSkipped ? "UPGRADED_SKIP_VERIFY" : "UPGRADED_OK", steps, at: new Date().toISOString(),
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
      // U-34 第五条：回滚目标优先快照（stageRelease 已覆盖 fromRelease，原树可能缺 .env/.next）。
      I.linkCurrent(home, pickRollbackTarget(args, home, fromRelease));
      // U-34 ③（2026-11-17 复验实证 FAIL）：回滚时 current 已切回旧树，FIX_NOT_LIVE 判据不适用
      //   （回滚后 pid 可能 0/startSec 晚于 switch）-> 传 skipRuntimeVerify，改由下面轮询端口探活。
      startUnits(args, rec, { skipRuntimeVerify: true });
      startAuxTimers(args, auxStopped);
      const health = noServices ? { skipped: true } : await healthAll(args, rec, ports);
      const healthy = health.skipped || Object.values(health).every((h) => h.ok);
      const rollbackServiceStatus = noServices ? { skipped: true } : collectRollbackServiceStatus(args, rec);
      // P2a（终裁 A）：同版本 repair 的回滚是 no-op，verdict 必须诚实（不再假装 ROLLBACK_FAILED）。
      const rbVerdict = rollbackVerdict(!!(toVersion && toVersion === fromVersion), healthy);
      // U-34 ③（2026-11-17 运营团队）：回滚后 health 不通过 = 服务不可用，必须 fail-closed 告警。
      if (!healthy) {
        console.error("[rollback] " + rbVerdict + " 但 health 不通过 —— 3002/3004/3006 等端口未全部 200，必须人工介入");
        process.exitCode = 1;
      }
      if (rbVerdict === "ROLLBACK_NOOP_SAMEPATH") {
        log(args, "  ↺ 同版本 repair：回滚为空操作（current 从未切走），现场=" + path.join(H.releasesDir(home), String(toVersion)) + "——请核验 sha/buildId 后人工处置");
      }
      evidence(home, { schema: SCHEMA, phase: "rollback", from: toVersion, to: fromVersion, verdict: rbVerdict, restored, rollbackServiceStatus, reason: e.message, steps, at: new Date().toISOString() });
      cleanupStaging(staging);
      if (!healthy) {
        // U-34 ③（2026-11-17 复验）：回滚后仍不健康 -> 汇总失败原因 + exit 非 0 + 明确「需人工介入」。
        const badUnits = Object.entries(rollbackServiceStatus.units || {}).filter(([, v]) => v !== "active");
        const badPorts = Object.entries(rollbackServiceStatus.ports || {}).filter(([, v]) => v !== "200");
        console.error("[rollback] " + rbVerdict + " 但服务不健康：unit 异常=" + JSON.stringify(badUnits) +
          "；端口非 200=" + JSON.stringify(badPorts) + " —— 需人工介入");
        process.exitCode = 1;
      }
      return { ok: false, rolledBack: healthy, noopRollback: rbVerdict === "ROLLBACK_NOOP_SAMEPATH", from: fromVersion, to: toVersion, steps, error: e.message, backupDir, rollbackServiceStatus };
    } catch (e2) {
      evidence(home, { schema: SCHEMA, phase: "rollback", verdict: "ROLLBACK_FAILED", reason: e.message, rollbackError: e2.message, steps, at: new Date().toISOString() });
      cleanupStaging(staging);
      // U-34 ③（2026-11-17 运营团队）：回滚失败**不得静默留 DOWN** —— fail-closed：
      //   明确告警（stderr）+ exitCode=1 + 回执字段 rollbackFailed=true，让调用者/运维立刻看到。
      //   旧实现只 return { ok:false }，调用者若只看 ok 会以为"回滚失败但服务还在"，实际可能是 DOWN。
      console.error("[rollback] ROLLBACK_FAILED: " + e2.message +
        " —— 服务可能仍 DOWN，必须人工介入（evidence: phase=rollback verdict=ROLLBACK_FAILED；现场 " + path.join(H.releasesDir(home), String(toVersion)) + "）");
      process.exitCode = 1;
      return { ok: false, rolledBack: false, rollbackFailed: true, from: fromVersion, to: toVersion, steps, error: e.message, rollbackError: e2.message };
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
  const noServices = computeNoServices(rec, args);
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
  // 2026-11-16 运营团队裁决：完整性判定（3 个闭源全在才 sales；残缺 -> throw fail-closed）
  assert("detectEdition: 单个闭源 -> 残缺 WARN 但判 sales（裁 C 不抛错）", detectEdition(fx) === "sales");
  fs.mkdirSync(path.join(fx, "packages/apps/mcp-server"), { recursive: true });
  assert("detectEdition: 两个闭源 -> 残缺 WARN 但判 sales", detectEdition(fx) === "sales");
  fs.mkdirSync(path.join(fx, "packages/apps/doc-portal"), { recursive: true });
  assert("detectEdition=sales（3 个闭源齐全）", detectEdition(fx) === "sales");
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
  // DEC-55：noServices 判定 —— systemdDir=null 但 apps[].unit 非空时必须仍有服务
  assert("DEC-55 hasAppsUnits: systemdDir=null + apps[].unit 非空 -> true", hasAppsUnits({ systemdDir: null, apps: { mind: { unit: "lions-mind.service" } } }) === true);
  assert("DEC-55 hasAppsUnits: apps 为空 -> false", hasAppsUnits({ systemdDir: null, apps: {} }) === false);
  assert("DEC-55 computeNoServices: /opt 形态（systemdDir=null + units）-> false", computeNoServices({ systemdDir: null, apps: { mind: { unit: "lions-mind.service" } } }, {}) === false);
  assert("DEC-55 computeNoServices: 真无服务 -> true", computeNoServices({ systemdDir: null, apps: {} }, {}) === true);
  assert("DEC-55 computeNoServices: skip-start 强制 true", computeNoServices({ systemdDir: "/x", apps: { mind: { unit: "u" } } }, { "skip-start": true }) === true);

  // U-34 ①（2026-11-17 19:08 运营团队要求）：readOldEnvPath 三态（扁平/嵌套/缺失）
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), "lions-ug-readoldenv-"));
  try {
    assert("readOldEnvPath: 缺失 -> 空串", readOldEnvPath(ro, "mind") === "");
    fs.mkdirSync(path.join(ro, "packages", "apps", "mind"), { recursive: true });
    fs.writeFileSync(path.join(ro, "packages", "apps", "mind", ".env"), "A=1\n");
    assert("readOldEnvPath: 嵌套 -> 命中嵌套", readOldEnvPath(ro, "mind") === path.join(ro, "packages", "apps", "mind", ".env"));
    fs.writeFileSync(path.join(ro, "mind.env"), "A=1\n");
    assert("readOldEnvPath: 扁平优先 -> 命中扁平（baseline 布局）", readOldEnvPath(ro, "mind") === path.join(ro, "mind.env"));
  } finally { fs.rmSync(ro, { recursive: true, force: true }); }

  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + (r.detail ? " :: " + r.detail : ""));
  const bad = results.filter((r) => !r.ok).length;
  console.log(bad === 0 ? "SELFTEST OK (" + results.length + " 断言)" : "SELFTEST FAILED (" + bad + ")");
  process.exit(bad === 0 ? 0 : 1);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args["selftest-repair-env"]) {
    const r1 = mergeEnvText("A=1\nB=2\n", "A=9\n");
    const ok1 = r1.text.includes("B=2") && r1.text.includes("A=9") && r1.added.length === 1;
    const r2 = mergeEnvText("A=1\n", "A=9\nB=8\n");
    const ok2 = r2.added.length === 0 && r2.text === "A=9\nB=8\n";
    const r3 = mergeEnvText("MIND_DATABASE_URL=postgres://x\nSESSION_DATABASE_URL=postgres://y\nSELFIMPROVING_DATABASE_URL=postgres://z\n", "DATABASE_URL=q\n");
    const ok3 = ["MIND_DATABASE_URL", "SESSION_DATABASE_URL", "SELFIMPROVING_DATABASE_URL"].every((k) => r3.text.includes(k)) && r3.added.length === 3;
    console.log(ok1 && ok2 && ok3 ? "SELFTEST-REPAIR-ENV OK (3/3)" : "SELFTEST-REPAIR-ENV FAIL " + JSON.stringify({ ok1, ok2, ok3 }));
    process.exit(ok1 && ok2 && ok3 ? 0 : 1);
  }
  if (args["selftest-pg-url-key"]) {
    // P3 fail-closed 自检（2026-11-16 运营团队 15:26）：7 例覆盖 缺键/空值/有值/sqlite/未取证 app/console 必需键
    const checks = [];
    const ex = "/rel/.env.example", oe = "/old/.env";
    const throws = (isPg, app, pairs) => { try { maybeAssertPgUrlKey(isPg, app, pairs, ex, oe); return false; } catch (e) { return /fail-closed/.test(String(e.message)); } };
    const passes = (isPg, app, pairs) => { try { maybeAssertPgUrlKey(isPg, app, pairs, ex, oe); return true; } catch (e) { return false; } };
    checks.push(["pg session 缺键 -> throw", throws(true, "session", {})]);
    checks.push(["pg session 空值 -> throw", throws(true, "session", { SESSION_DATABASE_URL: "" })]);
    checks.push(["pg session 有值 -> 过", passes(true, "session", { SESSION_DATABASE_URL: "postgresql://x" })]);
    checks.push(["pg console 缺 MIND 键 -> throw（r4 丢键场景）", throws(true, "console", {})]);
    checks.push(["pg console 有 MIND 键（缺 SESSION 不误报）-> 过", passes(true, "console", { MIND_DATABASE_URL: "postgresql://x" })]);
    checks.push(["pg portal（未取证 app）-> 不检查", passes(true, "portal", {})]);
    checks.push(["sqlite 缺键 -> 不检查（空占位无害）", passes(false, "session", {})]);
    for (const [n, c] of checks) console.log((c ? "PASS " : "FAIL ") + n);
    const bad = checks.filter((c) => !c[1]).length;
    console.log("SELFTEST-PG-URL-KEY " + (bad ? "FAIL " + bad : "OK (" + checks.length + "/" + checks.length + ")"));
    process.exit(bad ? 1 : 0);
  }
  if (args["selftest-pnpm-classify"]) {
    const checks = [];
    const ok = classifyPnpmFailure();
    checks.push(["正常环境可解析", ok.ok === true, JSON.stringify({ ok: ok.ok, cls: ok.cls || null, cmd: ok.cmd || null })]);
    const fsx = require("fs");
    const px = path.join(os.tmpdir(), "lions-pnpm-deny-" + process.pid);
    try { fsx.mkdirSync(px, { recursive: true }); fsx.chmodSync(px, 0o000); } catch (_e) {}
    let cls = "";
    try { const r = classifyPnpmFailure(px); cls = r.ok ? "OK" : r.cls; } catch (e) { cls = "THROW:" + String(e.message).slice(0, 40); }
    try { fsx.chmodSync(px, 0o700); fsx.rmSync(px, { recursive: true, force: true }); } catch (_e) {}
    checks.push(["不可读 cwd -> EACCES（非缺 pnpm）", cls === "EACCES", "cls=" + cls]);
    const r2 = classifyPnpmFailure("/nonexistent-dir-for-pnpm-probe");
    checks.push(["不存在 cwd -> 非 EACCES", r2.cls !== "EACCES" || r2.ok === true, "cls=" + (r2.ok ? "OK" : r2.cls)]);
    for (const [n, c, d] of checks) console.log((c ? "PASS " : "FAIL ") + n + (d ? "  " + d : ""));
    const bad = checks.filter((c) => !c[1]).length;
    console.log("SELFTEST-PNPM-CLASSIFY " + (bad ? "FAIL " + bad : "OK (" + checks.length + "/" + checks.length + ")"));
    process.exit(bad ? 1 : 0);
  }
  if (args["selftest-p1p2"]) {
    // P1+P2 自检（2026-11-16 终裁 A 同窗交付）：纯函数行为锁定，防止后续改动回退语义。
    const checks = [];
    const eq = (n, got, want) => checks.push([n + "（实=" + String(got) + "）", got === want]);
    eq("P1 同目录+无 flag -> throw", sameTargetAction("/r/0.6.0-pg", "/r/0.6.0-pg", false), "throw");
    eq("P1 同目录+flag -> replace", sameTargetAction("/r/0.6.0-pg", "/r/0.6.0-pg", true), "replace");
    eq("P1 不同目录 -> other", sameTargetAction("/r/old", "/r/new", false), "other");
    eq("P2a 同路径+不健康 -> ROLLBACK_NOOP_SAMEPATH", rollbackVerdict(true, false), "ROLLBACK_NOOP_SAMEPATH");
    eq("P2a 跨版本+不健康 -> ROLLBACK_FAILED", rollbackVerdict(false, false), "ROLLBACK_FAILED");
    eq("P2a 健康 -> ROLLED_BACK_OK", rollbackVerdict(true, true), "ROLLED_BACK_OK");
    eq("P2b 成功行 path=status", healthLine("mind", 14100, { ok: true, path: "/api/health/db", status: 200 }), "/api/health/db=200");
    eq("P2b 失败行 conn 形态", healthLine("session", 14102, { ok: false, path: "/", how: "conn=REFUSED" }), "/ conn=REFUSED");
    eq("P2b 失败行 http 形态", healthLine("mind", 14100, { ok: false, path: "/api/health/db", status: 500 }), "/api/health/db http=500");
    for (const [n, c] of checks) console.log((c ? "PASS " : "FAIL ") + n);
    const bad = checks.filter((c) => !c[1]).length;
    console.log("SELFTEST-P1P2 " + (bad ? "FAIL " + bad : "OK (" + checks.length + "/" + checks.length + ")"));
    process.exit(bad ? 1 : 0);
  }
  if (args["selftest-p3"]) {
    // P3-余 自检（2026-11-16 终裁）：backupDbs 四态分类 / pgUrls 自愈 / 探测错误分类 / fail-closed 语义。
    const checks = [];
    const ok = (n, cond) => checks.push([n, !!cond]);
    const c1 = classifyEnvUrlSource({ MIND_DATABASE_URL: "" }, "MIND_DATABASE_URL");
    ok("backup 四态: 键在值空 -> why 含「键在值空」", c1.url === "" && /键在值空/.test(c1.why));
    const c2 = classifyEnvUrlSource({ DATABASE_URL: "" }, "MIND_DATABASE_URL");
    ok("backup 四态: 缺键+DATABASE_URL空 -> why 区分", c2.url === "" && /缺键且 DATABASE_URL 行在值空/.test(c2.why));
    const c3 = classifyEnvUrlSource({}, "MIND_DATABASE_URL");
    ok("backup 四态: 双缺 -> why 含「缺键」且不含「值空」", c3.url === "" && /缺键（/.test(c3.why) && !/值空/.test(c3.why));
    const c4 = classifyEnvUrlSource({ MIND_DATABASE_URL: "postgresql://u:***@127.0.0.1:55433/lions_mind?connection_limit=30" }, "MIND_DATABASE_URL");
    ok("backup 四态: 有值 -> 去查询串", c4.url === "postgresql://u:***@127.0.0.1:55433/lions_mind");
    ok("派生: 换库名+去 query", derivePgUrl("postgresql://u:***@h:55433/lions_mind?x=1", "lions_session") === "postgresql://u:***@h:55433/lions_session");
    ok("派生: 非法短串 -> 空", derivePgUrl("nope", "lions_mind") === "");
    ok("探测分类: 密码错 -> 配置错误", /配置错误/.test(classifyPgProbeError("FATAL: password authentication failed for user \"test\"")));
    ok("探测分类: 库不存在 -> 配置错误", /配置错误/.test(classifyPgProbeError("FATAL: database \"lions_x\" does not exist")));
    ok("探测分类: 拒连 -> PG 临时不可用", /临时不可用/.test(classifyPgProbeError("psql: error: connection to server at \"127.0.0.1\", port 55433 failed: Connection refused")));
    ok("探测分类: 超时 -> PG 临时不可用", /临时不可用/.test(classifyPgProbeError("timeout expired")));
    ok("探测分类: 未知 -> 探测失败", /探测失败/.test(classifyPgProbeError("weird thing")));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p3-selftest-"));
    try {
      const put = (app, text) => { const d = path.join(tmp, APPS[app].dir); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, ".env"), text); };
      put("console", "MIND_DATABASE_URL=postgresql://u:***@127.0.0.1:55433/lions_mind?connection_limit=30\n");
      const probes = [];
      const r1 = resolvePgUrls({ home: tmp }, {}, tmp, { probe: (u) => { probes.push(u); return { ok: true }; }, log: () => {} });
      ok("自愈: 三 app 全部派生（兄弟 .env）", r1.mind === "postgresql://u:***@127.0.0.1:55433/lions_mind" && r1.session === "postgresql://u:***@127.0.0.1:55433/lions_session" && r1.selfimproving === "postgresql://u:***@127.0.0.1:55433/lions_selfimproving");
      ok("自愈: 每项都做了连通探测（3 次）", probes.length === 3);
      const r2 = resolvePgUrls({ home: tmp }, { MIND_DATABASE_URL: "postgresql://x/y" }, tmp, { probe: () => ({ ok: true }), log: () => {} });
      ok("自愈: 旧值优先", r2.mind === "postgresql://x/y");
      let noopThrow = false;
      try { resolvePgUrls({ home: tmp }, {}, tmp, { probe: () => ({ ok: false, why: "PG 临时不可用（探测超时）" }), log: () => {} }); } catch (e) { noopThrow = /fail-closed\(自愈探测失败\)/.test(String(e.message)) && /临时不可用/.test(String(e.message)); }
      ok("自愈: 探测失败必须 throw（fail-closed 不放松）", noopThrow);
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "p3-selftest2-"));
      try {
        let missThrow = false;
        try { resolvePgUrls({ home: tmp2 }, {}, tmp2, { probe: () => ({ ok: true }), log: () => {} }); } catch (e) { missThrow = /fail-closed\(自愈失败\)/.test(String(e.message)); }
        ok("自愈: 无来源 -> throw 且文案点名缺键", missThrow);
      } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    // ⑤ 0 库断言反向用例（dr 门禁要求：0 库必 FAIL）
    let zeroThrew = false;
    try {
      assertBackupNotEmpty([], [{ app: "mind", why: "键在值空（MIND_DATABASE_URL 存在但为空）" }, { app: "session", why: "缺键（SESSION_DATABASE_URL 与 DATABASE_URL 均不存在）" }]);
    } catch (e) { zeroThrew = /0 库/.test(String(e.message)) && /键在值空/.test(String(e.message)) && /缺键（/.test(String(e.message)); }
    ok("0 库断言: made=[] 必 throw 且列四态原因", zeroThrew);
    let oneOk = true;
    try { assertBackupNotEmpty([{ app: "mind" }], []); } catch (_e) { oneOk = false; }
    ok("0 库断言: made 非空不误伤", oneOk);
    // ⑥ edition-ts 行为用例（dr 门禁要求：repair 成功刷 updatedAt）
    const rec6 = applyInstallRecord({ version: "0.6.0-pg", updatedAt: "2026-11-15T22:48:00.000Z", installedAt: "2026-11-13T02:24:24.226Z" }, "0.6.0-pg", "2026-11-16T11:30:00.000Z");
    ok("edition-ts: 成功刷 updatedAt/installedAt", rec6.updatedAt === "2026-11-16T11:30:00.000Z" && rec6.installedAt === "2026-11-16T11:30:00.000Z" && rec6.version === "0.6.0-pg");
    ok("edition-ts: 不污染其它字段", rec6.updatedAt !== "2026-11-15T22:48:00.000Z");
    for (const [n, c] of checks) console.log((c ? "PASS " : "FAIL ") + n);
    const bad = checks.filter((c) => !c[1]).length;
    console.log("SELFTEST-P3 " + (bad ? "FAIL " + bad : "OK (" + checks.length + "/" + checks.length + ")"));
    process.exit(bad ? 1 : 0);
  }
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
