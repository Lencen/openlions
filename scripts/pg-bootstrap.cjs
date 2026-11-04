#!/usr/bin/env node
/**
 * pg-bootstrap.cjs — 从安装介质里拉起 PostgreSQL（A2：介质内带 PG 包/Compose）2026-11-03
 * 2026-11-04 可移植性修复：
 *   - 支持 docker compose v2 与 docker-compose v1/v5；二者都没有时明确失败；
 *   - 介质里有 pg/*.tar 时先 docker load；
 *   - 等待/建库优先用容器内 psql/pg_isready，不要求宿主机安装 psql；
 *   - 自动 CREATE EXTENSION pg_trgm（Prisma schema 的 GIN 索引需要）；
 *   - compose 的 ./pg-password secrets 文件与 run/pg-password 保持一致。
 *
 * 介质布局（--media 指向发布包根）：
 *   <media>/pg/compose.yml
 *   <media>/pg/*.tar              可选：docker save 的 PG 镜像
 *   <media>/pg/deb/*.deb          可选：离线 apt 包
 *   <media>/pg/bundle.json        可选：{mode,port,user,dbs,image}
 *
 * 用法：
 *   node scripts/pg-bootstrap.cjs --media=<dir> --plan|--apply [--mode=compose|deb]
 *   node scripts/pg-bootstrap.cjs --probe
 * 退出码：0 成功/计划正常；1 失败；2 参数或介质问题
 */
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const cp = require("node:child_process");
const NL = String.fromCharCode(10);
const REPO = path.resolve(__dirname, "..");
const RUN_DIR = path.join(REPO, "run");
const PW_FILE = path.join(RUN_DIR, "pg-password");
const URLS_FILE = path.join(RUN_DIR, "pg-urls.env");
const argOf = (name, def) => {
  const eq = process.argv.find((a) => a.startsWith("--" + name + "="));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf("--" + name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return def;
};
const has = (n) => process.argv.includes("--" + n) || process.argv.some((a) => a.startsWith("--" + n + "="));
function sh(cmd, args, opts) {
  const r = cp.spawnSync(cmd, args, Object.assign({ encoding: "utf8", timeout: 600000 }, opts || {}));
  return { code: typeof r.status === "number" ? r.status : -1, out: String(r.stdout || ""), err: String(r.stderr || "") };
}
function readBundle(media) {
  const dir = path.join(media, "pg");
  const out = { dir, compose: path.join(dir, "compose.yml"), debDir: path.join(dir, "deb"), tars: [] };
  try { out.json = JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8")); } catch { out.json = null; }
  out.debs = fs.existsSync(out.debDir) ? fs.readdirSync(out.debDir).filter((f) => f.endsWith(".deb")) : [];
  out.tars = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".tar")) : [];
  out.mode = (out.json && out.json.mode) || (fs.existsSync(out.compose) ? "compose" : (out.debs.length ? "deb" : ""));
  out.port = Number((out.json && out.json.port) || 5432);
  out.user = (out.json && out.json.user) || "lions";
  out.dbs = (out.json && out.json.dbs) || { mind: "lions_mind", session: "lions_session", selfimproving: "lions_selfimproving" };
  return out;
}
function password(b) {
  if (process.env.PG_PASSWORD) return process.env.PG_PASSWORD;
  const files = [path.join(b.dir, "pg-password"), PW_FILE];
  for (const f of files) {
    try { const p = fs.readFileSync(f, "utf8").trim(); if (p) return p; } catch { /* 继续 */ }
  }
  const p = require("node:crypto").randomBytes(18).toString("hex");
  return p;
}
function writePassword(b, pw) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(PW_FILE, pw + NL, { mode: 0o600 });
  try { fs.mkdirSync(b.dir, { recursive: true }); fs.writeFileSync(path.join(b.dir, "pg-password"), pw + NL, { mode: 0o600 }); } catch { /* 介质只读时忽略 */ }
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: Number(port) });
    const done = (v) => { try { s.destroy(); } catch { /* ignore */ } resolve(v); };
    s.setTimeout(1200);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}
async function waitPort(port, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
async function waitPg(container, port, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (container) {
      const r = sh("docker", ["exec", container, "pg_isready", "-U", "postgres"]);
      if (r.code === 0) return true;
    } else if (await portOpen(port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
function dockerCompose() {
  const v2 = sh("docker", ["compose", "version"]);
  if (v2.code === 0) return ["docker", "compose"];
  const v1 = sh("docker-compose", ["version"]);
  if (v1.code === 0) return ["docker-compose"];
  return null;
}
function loadImages(b) {
  if (!b.tars.length) return { ok: true, loaded: 0 };
  for (const t of b.tars) {
    const r = sh("docker", ["load", "-i", path.join(b.dir, t)]);
    if (r.code !== 0) return { ok: false, why: "docker load " + t + " 失败: " + (r.err || r.out).slice(0, 240) };
  }
  return { ok: true, loaded: b.tars.length };
}
function composeContainer(b, compose) {
  const r = sh(compose[0], compose.slice(1).concat(["-f", b.compose, "ps", "-q"]));
  const id = (r.out || "").split(/\s+/).filter(Boolean)[0];
  return r.code === 0 ? id : "";
}
function composeUp(b, compose, pw) {
  const r = sh(compose[0], compose.slice(1).concat(["-f", b.compose, "up", "-d"]), {
    env: Object.assign({}, process.env, { PG_PASSWORD: pw }),
    timeout: 120000,
  });
  if (r.code !== 0) return { ok: false, why: "compose up 失败: " + (r.err || r.out).slice(0, 300) };
  return { ok: true };
}
/**
 * 不用 compose、直接 docker run 的兜底（2026-11-04 100 机实测：snap 的 docker-compose 会卡死）。
 * 触发条件：bundle.json 给了 image。数据卷/容器名也可在 bundle.json 覆盖。
 */
function dockerRun(b, pw) {
  const j = b.json || {};
  const image = String(j.image || "");
  if (!image) return { ok: false, why: "bundle.json 未给 image，无法走 docker run 兜底" };
  const name = String(j.containerName || ("lions-pg-" + b.port));
  const volume = String(j.volume || ("lions-pgdata-" + b.port));
  const ps = sh("docker", ["ps", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.State}}"]);
  if ((ps.out || "").trim()) {
    if ((ps.out || "").trim() !== "running") {
      const st = sh("docker", ["start", name]);
      if (st.code !== 0) return { ok: false, why: "已有容器启动失败: " + (st.err || st.out).slice(0, 200) };
    }
    return { ok: true, container: name };
  }
  const envFile = path.join(b.dir, "pg.env");
  try {
    fs.mkdirSync(b.dir, { recursive: true });
    fs.writeFileSync(envFile, "POSTGRES_PASSWORD=" + pw + "\n", { mode: 0o600 });
  } catch (e) {
    return { ok: false, why: "写 pg.env 失败: " + String(e && e.message || e) };
  }
  const r = sh("docker", ["run", "-d", "--name", name, "--restart", "unless-stopped",
    "-p", b.port + ":5432", "-v", volume + ":/var/lib/postgresql/data", "--env-file", envFile, image]);
  if (r.code !== 0) return { ok: false, why: "docker run 失败: " + (r.err || r.out).slice(0, 300) };
  return { ok: true, container: name };
}
function psqlExec(b, container, sql, db) {
  if (container) {
    const args = ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
    if (db) args.push("-d", db);
    args.push("-c", sql);
    return sh("docker", args);
  }
  if (b.mode === "deb") {
    const args = ["-n", "-u", "postgres", "psql", "-p", String(b.port), "-v", "ON_ERROR_STOP=1", "-At"];
    if (db) args.push("-d", db);
    args.push("-c", sql);
    return sh("sudo", args);
  }
  if (sh("psql", ["--version"]).code !== 0) return { code: -1, out: "", err: "宿主没有 psql，且没有可用容器" };
  const args = ["-h", "127.0.0.1", "-p", String(b.port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
  if (db) args.push("-d", db);
  args.push("-c", sql);
  return sh("psql", args, { env: Object.assign({}, process.env, { PGPASSWORD: process.env.PGPASSWORD || "" }) });
}
function ensureDbs(b, container, pw) {
  const role = psqlExec(b, container, "SELECT 1 FROM pg_roles WHERE rolname = '" + b.user.replace(/'/g, "''") + "'");
  if (role.code !== 0) return { ok: false, why: "连不上 PG 超级用户: " + (role.err || role.out).slice(0, 240) };
  if (!/1/.test(role.out || "")) {
    const c = psqlExec(b, container, "CREATE ROLE " + b.user + " LOGIN PASSWORD '" + pw.replace(/'/g, "''") + "'");
    if (c.code !== 0) return { ok: false, why: "建角色失败: " + (c.err || "").slice(0, 200) };
  }
  for (const db of Object.values(b.dbs)) {
    const ex = psqlExec(b, container, "SELECT 1 FROM pg_database WHERE datname = '" + db.replace(/'/g, "''") + "'");
    if (ex.code !== 0) return { ok: false, why: "查库失败: " + (ex.err || "").slice(0, 200) };
    if (!/1/.test(ex.out || "")) {
      const c = psqlExec(b, container, 'CREATE DATABASE "' + db + '" OWNER ' + b.user);
      if (c.code !== 0) return { ok: false, why: "建库失败(" + db + "): " + (c.err || "").slice(0, 200) };
    }
    // Prisma schema 的 GIN 索引使用 gin_trgm_ops；扩展必须在 db push 前存在。
    const ext = psqlExec(b, container, "CREATE EXTENSION IF NOT EXISTS pg_trgm", db);
    if (ext.code !== 0) return { ok: false, why: "建扩展 pg_trgm 失败(" + db + "): " + (ext.err || "").slice(0, 200) };
  }
  return { ok: true };
}
function planLines(b, compose) {
  const L = [];
  if (b.mode === "compose") {
    L.push("mode=compose  文件=" + b.compose);
    if (b.json && b.json.image) {
      L.push("  docker run 兜底: 镜像=" + b.json.image + " 容器=" + (b.json.containerName || ("lions-pg-" + b.port)));
    } else {
      L.push("  compose 命令: " + (compose ? compose.join(" ") : "(缺失 docker compose / docker-compose)"));
    }
    if (b.tars.length) L.push("  将 docker load: " + b.tars.join(", "));
    L.push("  将执行: " + (b.json && b.json.image ? "docker run ... " + b.json.image : "PG_PASSWORD=<复用或新生成> " + (compose ? compose.join(" ") : "docker compose") + " -f " + b.compose + " up -d"));
  } else if (b.mode === "deb") {
    L.push("mode=deb  包数=" + b.debs.length + "  目录=" + b.debDir);
    L.push("  将执行: sudo -n apt-get install -y " + b.debDir + "/*.deb（需 root；无免密 sudo 会报错）");
  } else {
    L.push("mode=(无)  介质里既没有 pg/compose.yml 也没有 pg/deb/*.deb");
  }
  L.push("  将建库: " + Object.values(b.dbs).join(", ") + "（角色 " + b.user + "，端口 " + b.port + "）");
  L.push("  将建扩展: pg_trgm（每个库）");
  L.push("  将产出: " + URLS_FILE + "（0600）");
  return L;
}
function urls(b, pw) {
  const mk = (db) => "postgresql://" + b.user + ":" + encodeURIComponent(pw) + "@127.0.0.1:" + b.port + "/" + db;
  return { mind: mk(b.dbs.mind), session: mk(b.dbs.session), selfimproving: mk(b.dbs.selfimproving) };
}
async function main() {
  if (has("probe")) {
    const b = readBundle(path.resolve(argOf("media", path.join(REPO, ".."))));
    const up = await portOpen(b.port);
    console.log(JSON.stringify({ pgReachable: up, port: b.port }, null, 1));
    return up ? 0 : 1;
  }
  const mediaArg = argOf("media", "");
  if (!mediaArg) { console.error("缺 --media=<dir>（介质根，含 pg/ 子目录）"); return 2; }
  const media = path.resolve(mediaArg);
  if (!fs.existsSync(media)) { console.error("介质目录不存在: " + media); return 2; }
  const b = readBundle(media);
  const modeArg = argOf("mode", "");
  if (modeArg) b.mode = modeArg;
  const compose = dockerCompose();
  const pw = password(b);
  if (has("plan") || has("dry-run")) {
    console.log("=== PG 介质引导计划（未执行任何动作）===");
    for (const l of planLines(b, compose)) console.log(l);
    return 0;
  }
  if (b.mode === "compose") {
    if (!fs.existsSync(b.compose) && !(b.json && b.json.image)) { console.error("缺 " + b.compose); return 1; }
    writePassword(b, pw);
    const loaded = loadImages(b);
    if (!loaded.ok) { console.error(loaded.why); return 1; }
    let container = "";
    if (b.json && b.json.image) {
      // 优先 docker run：不依赖 compose 插件（snap 的 docker-compose 在 100 机实测会卡死）。
      if (!(await portOpen(b.port))) {
        const rr = dockerRun(b, pw);
        if (!rr.ok) { console.error(rr.why); return 1; }
        if (!(await waitPort(b.port, 90))) { console.error("PG 90s 内未就绪（端口 " + b.port + "）"); return 1; }
        container = rr.container || "";
      } else {
        const name = String((b.json && b.json.containerName) || ("lions-pg-" + b.port));
        const ps = sh("docker", ["ps", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.Names}}"]);
        container = (ps.out || "").trim();
      }
    } else {
      if (!compose) { console.error("缺 docker compose / docker-compose：请安装 Docker Compose 插件，或改用 pg/deb（需 root）"); return 1; }
      if (!(await portOpen(b.port))) {
        const up = composeUp(b, compose, pw);
        if (!up.ok) { console.error(up.why); return 1; }
        if (!(await waitPort(b.port, 90))) { console.error("PG 90s 内未就绪（端口 " + b.port + "）"); return 1; }
        container = composeContainer(b, compose);
      } else {
        container = composeContainer(b, compose);
      }
    }
    if (!(await waitPg(container || "", b.port, 90))) {
      console.error("PG 进程未就绪（端口 " + b.port + "）");
      return 1;
    }
    if (!container) {
      console.error("找不到 PG 容器；若端口 " + b.port + " 上已有你自己的 PG，请用 --pg-bootstrap=off 并直接提供三个 URL");
      return 1;
    }
    const ens = ensureDbs(b, container, pw);
    if (!ens.ok) { console.error(ens.why); return 1; }
  } else if (b.mode === "deb") {
    if (!b.debs.length) { console.error("pg/deb/ 下没有 .deb"); return 1; }
    if (!(await portOpen(b.port))) {
      const r = sh("sudo", ["-n", "apt-get", "install", "-y"].concat(b.debs.map((f) => path.join(b.debDir, f))));
      if (r.code !== 0) {
        console.error("deb 安装失败（需 root 或免密 sudo）: " + (r.err || r.out).slice(0, 300));
        console.error("手工命令: sudo apt-get install -y " + b.debDir + "/*.deb");
        return 1;
      }
      if (!(await waitPort(b.port, 90))) { console.error("PG 90s 内未就绪"); return 1; }
    }
    writePassword(b, pw);
    const ens = ensureDbs(b, "", pw);
    if (!ens.ok) { console.error(ens.why); return 1; }
  } else {
    console.error("介质里没有 PG 包或 Compose：请预装 PG 14+，或把 pg/ 放进介质（见 docs/productization/PG-IN-MEDIA-2026-11-03.md）");
    return 1;
  }
  const u = urls(b, pw);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(URLS_FILE, ["# pg-bootstrap 生成（0600）", "MIND_DATABASE_URL=" + u.mind, "SESSION_DATABASE_URL=" + u.session, "SELFIMPROVING_DATABASE_URL=" + u.selfimproving, ""].join(NL), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, mode: b.mode, port: b.port, dbs: Object.values(b.dbs), urlsFile: URLS_FILE, urls: u }, null, 1));
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error("pg-bootstrap failed: " + (e && e.stack || e)); process.exit(1); });
