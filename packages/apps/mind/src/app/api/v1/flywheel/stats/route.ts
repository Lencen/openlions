import { NextResponse } from "next/server";
import { Worker } from "node:worker_threads";
import { parseStructuredFindings } from "@/server/pipeline/findings-parse";
import { prisma } from "@/lib/prisma";

// 2026-10-15 round-78: 本路由读**实时**库统计(FlywheelReflection/Task groupBy + topic coverage)。
//   无参 GET 且无 dynamic 声明 -> build 期预渲染 + 永不重验(实测 x-nextjs-cache: HIT) -> 冻结快照。
//   口径同 /api/health/db、/api/v1/rbac、/api/v1/org。
export const dynamic = "force-dynamic";

// ══════════════════════════════════════════════════════════════════════════════
// A1(c) 2026-10-17(父 agent 批准): 把"**全量** structuredFindings 的 JSON.parse + 聚合"搬进
//   `worker_thread` —— 依据是 B 的 CPU profile 点名:
//     `parseStructuredFindings`(压缩后 `s`) 占非 idle CPU **15.4%**(3582ms, 全进程第一业务热点),
//     且**与数据量成正比**(本路由把**所有** FlywheelReflection 的 structuredFindings 全捞出来逐条 JSON.parse;
//     由此产生的大分配又喂出 Prisma 结果装配 16.8% 与 GC 12.4%)。详见
//     verification/reflect-http-availability-2026-10-17/EVIDENCE.md §7/§8。
//
// 口径保证(**不改语义**):
//   · worker 里那份 `parse` 与 `@/server/pipeline/findings-parse::parseStructuredFindings` **逐分支同构**
//     (数组 / {picked} / {findings} / {items} / 其它 -> []), 聚合口径与改前逐字相同;
//   · **回退开关**: `STATS_FINDINGS_WORKER=0` -> 直接走同步路径(改前行为); worker 超时/异常 -> **自动同步兜底**;
//   · 响应体在**非调试**下与改前逐字相同(调试字段只在 `STATS_FINDINGS_DEBUG=1` 时附加)。
//
// 已知代价(诚实): 传参要把 findings 字符串**结构化克隆**给 worker(字符串不可转移) —— 这笔开销是否小于
//   省下的 parse, 由实测决定; 若反而更慢就回退(见 EVIDENCE 的四项对照)。
// ══════════════════════════════════════════════════════════════════════════════

interface FindingsAgg {
  totalFindings: number;
  byCategory: Record<string, number>;
  byActionType: Record<string, number>;
  byStatus: Record<string, number>;
}

/** worker 源码(自包含、零依赖; 与 findings-parse 同分支)。 */
const WORKER_SRC = `
const { parentPort } = require("node:worker_threads");
function parse(raw) {
  if (!raw) return [];
  var v;
  try { v = JSON.parse(raw); } catch (e) { return []; }
  if (Array.isArray(v)) return v.filter(function (x) { return x && typeof x === "object"; });
  if (v && typeof v === "object") {
    if (Array.isArray(v.picked)) return v.picked.filter(function (x) { return x && typeof x === "object"; });
    if (Array.isArray(v.findings)) return v.findings.filter(function (x) { return x && typeof x === "object"; });
    if (Array.isArray(v.items)) return v.items.filter(function (x) { return x && typeof x === "object"; });
    return [];
  }
  return [];
}
parentPort.on("message", function (msg) {
  var t0 = process.threadCpuUsage ? process.threadCpuUsage() : null;
  var out = { totalFindings: 0, byCategory: {}, byActionType: {}, byStatus: {} };
  var values = (msg && msg.values) || [];
  for (var i = 0; i < values.length; i++) {
    var parsed;
    try { parsed = parse(values[i]); } catch (e) { parsed = []; }
    for (var j = 0; j < parsed.length; j++) {
      var f = parsed[j];
      out.totalFindings++;
      out.byCategory[f.category] = (out.byCategory[f.category] || 0) + 1;
      out.byActionType[f.actionType] = (out.byActionType[f.actionType] || 0) + 1;
      out.byStatus[f.status] = (out.byStatus[f.status] || 0) + 1;
    }
  }
  var cpuUs = 0;
  if (t0 && process.threadCpuUsage) { var t1 = process.threadCpuUsage(); cpuUs = (t1.user - t0.user) + (t1.system - t0.system); }
  parentPort.postMessage({ id: msg && msg.id, agg: out, workerCpuUs: cpuUs });
});
`;

/** 同步口径(回退路径): 与改前**逐字相同**。 */
function aggregateFindingsSync(values: unknown[]): FindingsAgg {
  let totalFindings = 0;
  const byCategory: Record<string, number> = {};
  const byActionType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const raw of values) {
    try {
      const parsed = parseStructuredFindings(typeof raw === "string" ? raw : JSON.stringify(raw ?? null));
      if (Array.isArray(parsed)) {
        for (const f of parsed) {
          totalFindings++;
          byCategory[f.category] = (byCategory[f.category] || 0) + 1;
          byActionType[f.actionType] = (byActionType[f.actionType] || 0) + 1;
          byStatus[f.status] = (byStatus[f.status] || 0) + 1;
        }
      }
    } catch { /* 单行脏数据不致命(与改前一致) */ }
  }
  return { totalFindings, byCategory, byActionType, byStatus };
}

// ── worker 单例 + 请求/响应配对(避免每请求 spawn 的 ~10-30ms 固定开销) ──
let wt: Worker | null = null;
let wseq = 0;
const wpending = new Map<number, { resolve: (v: { agg: FindingsAgg; workerCpuUs: number }) => void; reject: (e: unknown) => void }>();

function ensureWorker(): Worker {
  if (wt) return wt;
  const w = new Worker(WORKER_SRC, { eval: true });
  w.unref(); // 不阻止进程退出
  w.on("message", (m: { id: number; agg: FindingsAgg; workerCpuUs: number }) => {
    const p = wpending.get(m.id);
    if (p) { wpending.delete(m.id); p.resolve({ agg: m.agg, workerCpuUs: m.workerCpuUs }); }
  });
  const fail = (e: unknown) => {
    for (const [, p] of wpending) p.reject(e);
    wpending.clear();
    wt = null; // 下次请求重建
  };
  w.on("error", fail);
  w.on("exit", (code) => { if (code !== 0) fail(new Error("worker exit " + code)); else wt = null; });
  wt = w;
  return w;
}

function aggregateFindingsInWorker(values: string[], timeoutMs: number): Promise<{ agg: FindingsAgg; workerCpuUs: number }> {
  const w = ensureWorker();
  const id = ++wseq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { wpending.delete(id); reject(new Error("stats-findings worker timeout after " + timeoutMs + "ms")); }, timeoutMs);
    wpending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    w.postMessage({ id, values });
  });
}

function workerEnabled(): boolean {
  return String(process.env.STATS_FINDINGS_WORKER ?? "1") !== "0";
}
function workerTimeoutMs(): number {
  const n = Number(process.env.STATS_FINDINGS_WORKER_TIMEOUT_MS ?? "2000");
  return Number.isFinite(n) && n >= 50 ? n : 2000;
}

/** 本线程 CPU 累计(µs)。`process.threadCpuUsage()` 是 Node ≥22.5 的 API, 但本仓 @types/node 尚未声明 ->
 *  显式窄化, 取不到就返回 null(调试字段降级为 0, 不影响业务)。 */
function threadCpu(): { user: number; system: number } | null {
  const f = (process as unknown as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage;
  return typeof f === "function" ? f.call(process) : null;
}

export async function GET() {
  const [reflections, findings, tasks, topics] = await Promise.all([
    prisma.flywheelReflection.groupBy({ by: ["status"], _count: true }),
    prisma.flywheelReflection.findMany({
      where: { structuredFindings: { not: null } },
      select: { structuredFindings: true },
    }),
    prisma.task.groupBy({ by: ["status"], _count: true }),
    prisma.memoryTopic.aggregate({ _avg: { coverageScore: true }, _count: true }),
  ]);

  const refStats = reflections.reduce((acc, r) => {
    acc[r.status] = r._count;
    return acc;
  }, {} as Record<string, number>);

  // Parse structuredFindings —— A1(c): worker 优先, 失败/超时/开关关闭时**同步兜底**。
  const rawValues = findings.map((r) =>
    typeof r.structuredFindings === "string" ? r.structuredFindings : JSON.stringify(r.structuredFindings ?? null)
  );
  let agg: FindingsAgg;
  let mode = "sync";
  let workerCpuUs = 0;
  let mainCpuUs = 0;
  if (workerEnabled() && rawValues.length > 0) {
    const m0 = threadCpu();
    try {
      const r = await aggregateFindingsInWorker(rawValues, workerTimeoutMs());
      agg = r.agg;
      workerCpuUs = r.workerCpuUs;
      mode = "worker";
    } catch (e) {
      console.warn("[stats] findings worker 失败, 同步兜底: " + String((e as Error)?.message || e).slice(0, 120));
      agg = aggregateFindingsSync(findings.map((r) => r.structuredFindings));
      mode = "sync-fallback";
    }
    const m1 = threadCpu();
    if (m0 && m1) mainCpuUs = (m1.user - m0.user) + (m1.system - m0.system);
  } else {
    agg = aggregateFindingsSync(findings.map((r) => r.structuredFindings));
  }
  const totalFindings = agg.totalFindings;
  const byCategory = agg.byCategory;
  const byActionType = agg.byActionType;
  const byStatus = agg.byStatus;

  const taskStats = tasks.reduce((acc, t) => {
    acc[t.status] = t._count;
    return acc;
  }, {} as Record<string, number>);

  return NextResponse.json({
    success: true,
    data: {
      reflections: {
        total: Object.values(refStats).reduce((a, b) => a + b, 0),
        ok: refStats["OK"] || 0,
        failed: refStats["FAILED"] || 0,
        skipped: refStats["SKIPPED"] || 0,
      },
      structuredFindings: {
        covered: findings.length,
        total: Object.values(refStats).reduce((a, b) => a + b, 0),
        rate: findings.length / Math.max(1, Object.values(refStats).reduce((a, b) => a + b, 0)),
      },
      findings: { total: totalFindings, byCategory, byActionType, byStatus },
      tasks: taskStats,
      coverage: {
        avg: topics._avg.coverageScore || 0,
        total: topics._count,
      },
      health: {
        completion: 95, runtime: 90, logic: 95,
        dataMath: 98, structure: 95, quality: 88, overall: 93.5,
      },
      // 仅调试可见(默认不出现 -> 响应体与改前逐字相同): 用于"worker 是否真跑在别的核"的对照。
      ...(String(process.env.STATS_FINDINGS_DEBUG ?? "") === "1"
        ? { _perf: { mode, values: rawValues.length, workerCpuUs, mainCpuUs } }
        : {}),
    },
  });
}
