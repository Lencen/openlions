import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// 2026-10-27 飞轮业务看板：只读 run/flywheel-business-snapshot-latest.json（O(1)），不查库。
// 业务快照 = canonical schema v1 + business 扩展；缺失时降级到 canonical 快照并显式标 degraded。
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const BUSINESS_FILE = "flywheel-business-snapshot-latest.json";
const CANONICAL_FILE = "flywheel-snapshot-latest.json";
const MAX_AGE_MIN = 30;

function candidates(file: string): string[] {
  const roots = [
    process.env.LIONS_REPO_ROOT,
    process.cwd(),
    path.resolve(process.cwd(), "../.."),
    path.resolve(process.cwd(), "../../.."),
    path.resolve(process.cwd(), ".."),
  ].filter(Boolean) as string[];
  const out: string[] = [];
  if (process.env.LIONS_FLYWHEEL_SNAPSHOT_DIR) out.push(path.join(process.env.LIONS_FLYWHEEL_SNAPSHOT_DIR, file));
  for (const r of roots) out.push(path.join(r, "run", file));
  return Array.from(new Set(out));
}

function findFile(file: string): string | null {
  for (const f of candidates(file)) {
    try { if (fs.existsSync(f)) return f; } catch { /* ignore */ }
  }
  return null;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function repoRootOf(snapshotFile: string | null): string | null {
  if (snapshotFile) {
    const root = path.resolve(snapshotFile, "../..");
    if (fs.existsSync(path.join(root, "scripts", "flywheel-business-report.cjs"))) return root;
  }
  for (const f of candidates(BUSINESS_FILE)) {
    const root = path.resolve(f, "../..");
    if (fs.existsSync(path.join(root, "scripts", "flywheel-business-report.cjs"))) return root;
  }
  return null;
}

// 同一时刻只允许一个刷新，避免并发点按钮把 DB 打多次。
let refreshing: Promise<void> | null = null;
async function regenerate(root: string): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    await execFileAsync(process.execPath, [path.join(root, "scripts", "flywheel-business-report.cjs"), "--hours=24", "--write", "--quiet"], {
      cwd: root,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
  })().finally(() => { refreshing = null; }) as Promise<void>;
  return refreshing;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const wantRefresh = url.searchParams.get("refresh") === "1";
  let bizFile = findFile(BUSINESS_FILE);
  let canonicalFile = findFile(CANONICAL_FILE);
  const root = repoRootOf(bizFile || canonicalFile);

  if (wantRefresh && root) {
    try { await regenerate(root); } catch (e: any) {
      // 刷新失败不吞：在响应里明确写出来，页面会显示“生成失败 + 复算命令”。
      return NextResponse.json({
        ok: false,
        error: "业务快照生成失败：" + String((e && e.message) || e).slice(0, 300),
        hint: "在仓库根目录运行 node scripts/flywheel-business-report.cjs --hours=24 --write",
        source: null, data: null,
      }, { status: 502, headers: { "cache-control": "no-store" } });
    }
    bizFile = findFile(BUSINESS_FILE);
    canonicalFile = findFile(CANONICAL_FILE);
  }

  const pick = bizFile || canonicalFile;
  if (!pick) {
    return NextResponse.json({
      ok: false,
      error: "未找到飞轮快照文件",
      expected: candidates(BUSINESS_FILE).concat(candidates(CANONICAL_FILE)),
      hint: "在仓库根目录运行 node scripts/flywheel-business-report.cjs --hours=24 --write",
      source: null, data: null,
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  let data: any;
  try { data = readJson(pick); } catch (e: any) {
    return NextResponse.json({
      ok: false, error: "快照文件解析失败：" + String((e && e.message) || e),
      path: pick, hint: "重新生成 node scripts/flywheel-business-report.cjs --hours=24 --write",
      source: null, data: null,
    }, { status: 500, headers: { "cache-control": "no-store" } });
  }

  const degraded = !bizFile || !data || !data.business;
  const generatedAt = data && data.generatedAt ? data.generatedAt : null;
  const ageMinutes = generatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(generatedAt)) / 60000)) : null;
  const stale = ageMinutes == null ? true : ageMinutes > MAX_AGE_MIN;
  const notice = degraded
    ? "业务扩展快照未生成或不可读：业务维度显示 NO_DATA；canonical 指标仍可用。运行 node scripts/flywheel-business-report.cjs --hours=24 --write"
    : stale
      ? "快照已 " + ageMinutes + " 分钟未更新（阈值 " + MAX_AGE_MIN + " 分钟）；数字可能不是现状。运行 node scripts/flywheel-business-report.cjs --hours=24 --write"
      : null;

  return NextResponse.json({
    ok: true,
    source: degraded ? "canonical" : "business",
    path: pick,
    data,
    asOf: generatedAt,
    ageMinutes,
    stale,
    degraded,
    maxAgeMinutes: MAX_AGE_MIN,
    noData: (data && data.business && data.business.noData) || [],
    notice,
  }, { headers: { "cache-control": "no-store" } });
}
