import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

// 2026-10-27：商业化 Gate 看板的只读取数口（console BFF）。
// 契约（商业化线 v1.1 收缩后只做这一块）：
//   - 只读：不新增写接口、不触发评估动作；
//   - **不在前端算指标**：本路由取上游原值后原样投影，聚合（通过数/红绿）也在服务端算好；
//   - **空数据/上游失败 → 未知，不是 0**：缺数据时字段为 null，页面显示「未知」。
//
// 两个数据源：
//   1) goal-check：mind 的 `GET /api/v1/flywheel/goal-check`（只评估不建任务，快）；
//   2) readiness：`scripts/refresh-readiness-snapshot.cjs` 定时落盘的 `run/readiness-latest.json`
//      （CLI 全量跑要 3–5 分钟，绝不能在请求路径里现跑）。
export const dynamic = "force-dynamic";

const S1_DEADLINE = process.env.S1_DEADLINE || "2026-12-01"; // S1 公开开源节点（plan §3）
// 2026-10-27 修（商业化线实测 /api/commercial-gate 挂 20s 无响应）：
//   原来对上游 fetch **没有超时**——mind 一旦"进程在但请求挂住"，BFF 就跟着一起挂，
//   页面永远 loading，看板的"可见"就不成立。现在：有界超时 + 失败快速降级为 degraded。
const GOAL_CHECK_URL = process.env.GOAL_CHECK_URL || "http://localhost:3000/api/v1/flywheel/goal-check";
// 请求路径**不等待**上游（上游 2.5–3s，等它就必然 >2s）。首次访问只负责"踢一次后台刷新"，
//   后台给足 8s；拿到值后所有后续请求零延迟。这才是"BFF <2s"与"数据能出来"同时成立的做法。
const UPSTREAM_TIMEOUT_MS = Number(process.env.GOAL_CHECK_TIMEOUT_MS || 8000);
// 上游实测 2.5–3s，若"等它返回"，看板就永远 >2s。所以改成 **stale-while-revalidate**：
//   有上次成功值就**立刻返回**（标 stale），后台顺带刷新；没有才等一次（≤1.5s）。
const GOAL_REFRESH_AFTER_MS = 60_000;

let goalCache: { at: number; data: GoalData | null; reason: string | null } = { at: 0, data: null, reason: null };
let refreshing = false;

/** 后台刷新（不阻塞响应；失败也不影响本次返回） */
function refreshGoalsInBackground() {
  if (refreshing) return;
  refreshing = true;
  void readGoals({ force: true }).finally(() => {
    refreshing = false;
  });
}
// cwd 在不同启动方式下不同（dev=packages/apps/console, prod 亦同），所以按候选路径找，别写死层级
function snapshotPath(): string | null {
  const candidates = [
    path.join(process.cwd(), "..", "..", "..", "run", "readiness-latest.json"),
    path.join(process.cwd(), "..", "..", "run", "readiness-latest.json"),
    path.join(process.cwd(), "run", "readiness-latest.json"),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p);
      return p;
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}
const SNAPSHOT_MAX_AGE_MS = 36 * 60 * 60 * 1000;

interface GoalData {
  at: string;
  items: {
    id: string;
    value: number | null;
    target: number | null;
    direction: string | null;
    ok: boolean;
    missing: boolean;
    detail: string | null;
  }[];
}

interface GoalMetric {
  id?: string;
  value?: number | null;
  target?: number | null;
  direction?: string | null;
  ok?: boolean;
  missing?: boolean;
  detail?: string | null;
}

interface ReadinessSnap {
  at?: string;
  total?: number;
  pass?: number;
  fail?: number;
  results?: { key?: string; ok?: boolean; last?: string }[];
}

function daysLeft(deadline: string): number | null {
  const d = new Date(deadline + "T00:00:00+08:00");
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

async function readGoals(opts?: { force?: boolean }): Promise<{ data: GoalData | null; reason: string | null }> {
  // 请求路径一律不等待：有值直接给（顺带按需后台刷新），没值就踢一次刷新后立刻返回"加载中"
  if (!opts?.force) {
    if (goalCache.data) {
      if (Date.now() - goalCache.at > GOAL_REFRESH_AFTER_MS) refreshGoalsInBackground();
      return { data: goalCache.data, reason: null };
    }
    refreshGoalsInBackground();
    return { data: null, reason: "首次读数加载中，请稍后刷新" };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(GOAL_CHECK_URL, { cache: "no-store", signal: ac.signal });
    if (!r.ok) {
      // 失败不覆盖已有成功值：宁可给"稍旧"，不给"未知"
      return { data: goalCache.data, reason: "上游返回 " + r.status };
    }
    const j = (await r.json()) as { at?: string; metrics?: GoalMetric[] };
    const metrics = Array.isArray(j.metrics) ? j.metrics : [];
    const data: GoalData = {
      at: typeof j.at === "string" ? j.at : new Date().toISOString(),
      items: metrics.map((m) => ({
        id: String(m.id || ""),
        value: typeof m.value === "number" ? m.value : null,
        target: typeof m.target === "number" ? m.target : null,
        direction: typeof m.direction === "string" ? m.direction : null,
        ok: m.ok === true,
        missing: m.missing === true,
        detail: typeof m.detail === "string" ? m.detail : null,
      })),
    };
    goalCache = { at: Date.now(), data, reason: null };
    return { data, reason: null };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    // 同上：保留 lastGood，只在从未成功过时才返回 null（页面显示"未知"）
    return {
      data: goalCache.data,
      reason: aborted ? "上游读超时（" + UPSTREAM_TIMEOUT_MS + "ms）" : "上游暂时不可达",
    };
  } finally {
    clearTimeout(timer); // 必须清：否则成功路径也留着定时器
  }
}

function readReadiness() {
  try {
    const sp = snapshotPath();
    if (!sp) return null;
    const st = fs.statSync(sp);
    const age = Date.now() - st.mtimeMs;
    const snap = JSON.parse(fs.readFileSync(sp, "utf8")) as ReadinessSnap;
    const total = typeof snap.total === "number" ? snap.total : null;
    const pass = typeof snap.pass === "number" ? snap.pass : null;
    const fail = typeof snap.fail === "number" ? snap.fail : null;
    const failed = (snap.results || []).filter((x) => x && x.ok === false).map((x) => String(x.key || ""));
    return {
      total,
      pass,
      fail,
      failed,
      asOf: typeof snap.at === "string" ? snap.at : new Date(st.mtimeMs).toISOString(),
      stale: age > SNAPSHOT_MAX_AGE_MS,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const { data: g, reason: goalReason } = await readGoals();
  const rd = readReadiness();
  const degraded = !g || !rd;

  const items = g?.items ?? null;
  const okCount = items ? items.filter((m) => m.ok).length : null;
  // 2026-10-27 修（商业化线 msg_b4c538833f024b66）：原来把"未达标"和"缺数"都塞进 missing，
  //   于是页面把"红了"显示成"没数据"。两者是不同事实，必须分开：
  //     missing = 窗口内没有可用产物（missing:true）
  //     unmet   = 有数据但没到目标（!ok && !missing）
  const missing = items ? items.filter((m) => m.missing === true).map((m) => m.id) : null;
  const unmet = items ? items.filter((m) => !m.ok && m.missing !== true).map((m) => m.id) : null;

  // 发布门禁：红 = 有未达标/缺失指标 或 readiness 有失败；绿 = 两者都有数据且全过；否则未知
  let gate: { state: "green" | "red" | "unknown"; reasons: string[] } = { state: "unknown", reasons: [] };
  if (items && rd && typeof rd.fail === "number") {
    const reasons: string[] = [];
    if (missing && missing.length) reasons.push("目标指标缺数 " + missing.length + " 项");
    if (unmet && unmet.length) reasons.push("目标指标未达标 " + unmet.length + " 项");
    if (rd.fail > 0) reasons.push("就绪检查未通过 " + rd.fail + " 项");
    gate = { state: reasons.length ? "red" : "green", reasons };
  }

  return NextResponse.json({
    ok: true,
    asOf: new Date().toISOString(),
    s1: { deadline: S1_DEADLINE, daysLeft: daysLeft(S1_DEADLINE) },
    // 降级标记：前端据此显示"未知"，且**仍返回 200**（不是 5xx、更不是挂住）
    degraded,
    degradedReason: goalReason ?? (rd ? null : "就绪快照尚未生成"),
    goals: g ? { at: g.at, total: items?.length ?? null, okCount, missing, unmet, items } : null,
    readiness: rd,
    releaseGate: gate,
  });
}
