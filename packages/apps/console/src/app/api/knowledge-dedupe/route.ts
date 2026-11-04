// GET /api/knowledge-dedupe — 待评审的 dedupe clusters (2026-09-23 由 portal 迁入 console)
//   内部跑 scripts/knowledge-dedupe-clusters.cjs (spawnSync) 拿 JSON; 缓存 5 分钟。
//   GET /api/knowledge-dedupe           -> 全 clusters
//   GET /api/knowledge-dedupe?id=xxx    -> 单 cluster 详情
import { NextResponse } from "next/server";
import { spawnSync, spawn } from "child_process";
import path from "path";
import fs from "fs";

export const dynamic = "force-dynamic";

const REPO = process.env.LIONS_REPO || "" + (process.env.LIONS_HOME || process.cwd()) + "";
const CACHE_FILE = path.join(REPO, "logs/console-dedupe-clusters.json");
// 2026-10-13 round 76-EF: 这条接口原来**超时即同步阻塞 11 秒**(spawnSync 跑脚本)。
//   实测 /api/knowledge-dedupe 11.05s, 把 /cognitive/knowledge?tab=governance 整页拖到 15.7s
//   (同页其它接口只要 0.4~1.0s)。
//   改法: **stale-while-revalidate** —— 只要缓存文件存在就**立即返回**(哪怕过期),
//         同时**后台**再跑一次脚本刷新缓存; 只有第一次(完全没有缓存)才同步等。
//   TTL 只是"多久算值得刷新", 不再决定用户等多久。
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 后台刷新缓存(不阻塞请求)。同一时刻最多一个。 */
let refreshing = false;
function refreshInBackground() {
  if (refreshing) return;
  refreshing = true;
  try {
    const child = spawn("node", [SCRIPT, "--json-out=" + CACHE_FILE], { cwd: REPO, detached: true, stdio: "ignore" });
    child.on("exit", () => { refreshing = false; });
    child.on("error", () => { refreshing = false; });
    child.unref();
  } catch { refreshing = false; }
}
const SCRIPT = path.join(REPO, "scripts/knowledge-dedupe-clusters.cjs");

function loadClusters() {
  // 76-EF: 有缓存就先用(过期也先用), 并让后台去刷新 —— 用户不再为刷新等待。
  try {
    const st = fs.statSync(CACHE_FILE);
    const fresh = Date.now() - st.mtimeMs < CACHE_TTL_MS;
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!fresh) refreshInBackground();
    return cached;
  } catch {
    /* 完全没有缓存 -> 走下面的同步路径(只此一次) */
  }
  const r = spawnSync("node", [SCRIPT, "--json-out=" + CACHE_FILE], {
    encoding: "utf8",
    timeout: 120000,
    cwd: REPO,
  });
  if (r.status !== 0) {
    return { error: "script failed: " + (r.stderr || "").slice(0, 200), summary: { clusterCount: 0 } };
  }
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (e: any) {
    return { error: "parse cache: " + e?.message, summary: { clusterCount: 0 } };
  }
}

export async function GET(req: Request) {
  // 2026-11-04（open/PG 版）：本路由依赖未导出的 scripts/knowledge-dedupe-clusters.cjs（SQLite 时代）。
  //   open 版明确返回"未接入"，不要 200 + ok:false 的假成功，也不要把整页拖成错误。
  if (String(process.env.MIND_DB_DRIVER || "") === "pg") {
    return NextResponse.json({ ok: false, available: false, reason: "open/PG 版未接入知识去重评审（依赖内部脚本）" }, { status: 200 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const data = loadClusters();
  if (id) {
    const c = (data.clusters || []).find(
      (x: any) => x.keep.id === id || (x.drops || []).some((d: any) => d.id === id)
    );
    if (!c) return NextResponse.json({ ok: false, error: "cluster not found", id }, { status: 404 });
    return NextResponse.json({ ok: true, cluster: c });
  }
  return NextResponse.json({ ok: true, ...data });
}
