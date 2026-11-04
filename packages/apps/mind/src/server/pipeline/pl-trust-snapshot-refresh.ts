/**
 * pl-trust-snapshot-refresh.ts — PL-TRUST 快照刷新与降级(机制层,2026-09-24)
 *
 * 背景(根因): audit_violations 走 `goal-gap.ts` 回读"最后一条 FlywheelEvent(stage=QUALITY_AUDIT)"
 *   —— 这是**开环**数据流。任何"没人主动跑 quality-audit"的时间窗,快照自然陈旧;
 *   goal-gap.ts 原本在超龄 26h 后判 missing(null),平台就开单"塌在 -"。
 *   `scripts/install-pl-trust-timer.sh` 设计上每 6h 触发 `pl-trust-guard-cron.cjs`
 *   (cron 内部还会先 curl GET /api/v1/flywheel/quality-audit 刷新快照),但**从未真正安装**:
 *   单元文件不在 ~/.config/systemd/user/。任何 agent/重启/换机都丢触发,导致
 *   09-21 22:49 → 09-24 10:21 这种 60h 空窗直接塌死。
 *
 * 治本(本模块,机制修复): 把"快照超龄"从"返 null"改成
 *   ① 进程内节流地 lazy 调 runQualityAudit() 刷新快照(写库);
 *   ② 仍失败则调守门脚本 `node scripts/pl-trust-guard.cjs`(spawnSync 30s timeout)做独立复算;
 *   ③ 仍失败则给降级响应(stale 标记 + 重放命令),**不再 null**。
 *   让"塌在 -"在指标层**结构上无法再次发生**。
 *
 * 边界(明示不隐藏):
 *   - lazy 触发有写库副作用(FlywheelEvent QUALITY_AUDIT),靠 5min 进程内节流控频;
 *   - 守门降级是同步阻塞,但 goal-check 是低频(平台目标检查),30s timeout 内完成;
 *   - 不修改 audit_violations 口径(= quality-audit 不变量违约 + living 文档漂移),只把数据流闭环;
 *   - timer 仍由集成者装,本模块只补 timer 之外的兜底层(让 timer 装/没装都不塌)。
 */
import { execSync } from "child_process";
import { prisma } from "@/lib/prisma";

/** 快照超龄阈值(小时):超过此值触发 lazy refresh(对齐 pl-trust-guard-cron.cjs 的 6h timer 周期)。 */
const THRESHOLD_LAZY_H = Number(process.env.PL_TRUST_LAZY_REFRESH_H ?? 6);

/** 进程内 lazy 触发节流(毫秒):同进程 5min 内不重复 lazy 调 runQualityAudit。 */
const THROTTLE_MS = Number(process.env.PL_TRUST_LAZY_THROTTLE_MS ?? 5 * 60 * 1000);

/** 守门脚本 spawnSync 超时(毫秒)。 */
const GUARD_TIMEOUT_MS = Number(process.env.PL_TRUST_GUARD_TIMEOUT_MS ?? 30_000);

/** 进程内 lazy 触发时间戳(模块级,跨请求共享)。 */
let lastLazyRefreshAt = 0;
/** 进程内 lazy 触发的最近一次结果(避免失败时每请求都重跑)。 */
let lastLazyRefreshResult: { ok: boolean; reason: string; at: number } | null = null;

/** 单次 lazy refresh 的结果。 */
export type RefreshResult =
  | { ok: true; source: "snapshot" | "lazy-refresh" | "guard-fallback"; audit_violations: number | null }
  | { ok: false; source: "snapshot" | "lazy-refresh" | "guard-fallback"; reason: string; replay: string };

/** 解析 audit_violations = violations + docDriftDocs(sourceTitle 里的 observations)。 */
function parseSnapshot(row: { sourceId: string | null; sourceTitle: string | null } | null): number | null {
  if (!row) return null;
  const v = Number(row.sourceId ?? 0);
  let drift = 0;
  try { drift = Number((JSON.parse(row.sourceTitle || "{}")?.observations?.docDriftDocs) ?? 0); } catch {}
  if (!Number.isFinite(v)) return null;
  return v + drift;
}

/** 调守门脚本 spawnSync 复算 audit_violations。 */
// 2026-09-24 独立复核建议(避免主库/工作树 DB 分裂): cwd 不再硬编码 " + (process.env.LIONS_HOME || process.cwd()) + ",
//   而是用 process.cwd() — — 与上层 next dev / cron 启动时所在的仓库一致;若上游是 worktree,
//   则 tier-3 读的是同一 worktree 的 DB,避免"tier-2 写 worktree / tier-3 读主库"的口径分裂。
// 兜底: process.cwd() 解析失败时(很罕见, e.g. cwd 被删),回退到 " + (process.env.LIONS_HOME || process.cwd()) + "(平台默认主库)。
function runGuardAndParse(): { code: number; audit_violations: number | null; stdout: string } {
  const repoCwd = process.cwd() || "" + (process.env.LIONS_HOME || process.cwd()) + "";
  try {
    const r = execSync(
      "node scripts/pl-trust-guard.cjs",
      { cwd: repoCwd, encoding: "utf-8", timeout: GUARD_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }
    );
    const m = r.match(/^audit_violations\s*=\s*violations\(\d+\)\s*\+\s*docDriftDocs\(\d+\)\s*=\s*(\d+)/m);
    const code = m && Number(m[1]) <= 0 ? 0 : 1;
    return { code, audit_violations: m ? Number(m[1]) : null, stdout: r };
  } catch (e: any) {
    // execSync 抛错时,stderr/stdout 在 e.stdout/e.stderr;输出末尾可能有 audit_violations 行
    const out = String(e?.stdout || "") + String(e?.stderr || "");
    const m = out.match(/^audit_violations\s*=\s*violations\(\d+\)\s*\+\s*docDriftDocs\(\d+\)\s*=\s*(\d+)/m);
    return { code: typeof e?.status === "number" ? e.status : 2, audit_violations: m ? Number(m[1]) : null, stdout: out };
  }
}

/**
 * 获取 audit_violations 真值(机制闭环入口)。
 *
 * 流程:
 *   1) 读最新 QUALITY_AUDIT 快照;
 *   2) 若快照新鲜(年龄 ≤ THRESHOLD_LAZY_H)→ 直接返回 snapshot 读数;
 *   3) 否则尝试 lazy refresh(runQualityAudit 写新快照),5min 节流;
 *   4) lazy 失败/lazy 后仍无快照 → 调守门脚本独立复算;
 *   5) 全部失败 → 返回 ok:false 但带 replay 命令(永远不返回 null,避免"塌在 -")。
 *
 * 不抛异常(任何内部失败都降级到 ok:false + reason + replay,让上层 detail 字段有 traceable 信息)。
 */
export async function getAuditViolationsWithFallback(): Promise<RefreshResult> {
  const now = Date.now();
  let last: { sourceId: string | null; sourceTitle: string | null; createdAt: Date } | null = null;
  try {
    last = await prisma.flywheelEvent.findFirst({
      where: { stage: "QUALITY_AUDIT" },
      orderBy: { createdAt: "desc" },
      select: { sourceId: true, sourceTitle: true, createdAt: true },
    });
  } catch { /* db 不可用走 fallback */ }

  if (last) {
    const ageH = (now - new Date(last.createdAt).getTime()) / 3600000;
    if (ageH <= THRESHOLD_LAZY_H) {
      return { ok: true, source: "snapshot", audit_violations: parseSnapshot(last) };
    }
  }

  // ② lazy refresh(进程内节流:同进程 5min 内只跑一次)
  const sinceLastRefresh = now - lastLazyRefreshAt;
  if (sinceLastRefresh >= THROTTLE_MS) {
    lastLazyRefreshAt = now;
    try {
      // 直接 require,避免 next dev HMR 时循环依赖
      const mod = require("./quality-audit") as typeof import("./quality-audit");
      await mod.runQualityAudit();
      lastLazyRefreshResult = { ok: true, reason: "lazy-refresh", at: now };
      // 重读最新快照
      const fresh = await prisma.flywheelEvent.findFirst({
        where: { stage: "QUALITY_AUDIT" },
        orderBy: { createdAt: "desc" },
        select: { sourceId: true, sourceTitle: true, createdAt: true },
      });
      const freshParsed = parseSnapshot(fresh);
      // 2026-09-24 独立复核补: lazy-refresh 写库成功但 fresh 读为 null(read-your-write 异常/事务回滚等),
      //   不应返 {ok:true, audit_violations:null} 让人误以为是 tier-1 命中, 应直接走 tier-3 guard fallback。
      if (freshParsed != null) return { ok: true, source: "lazy-refresh", audit_violations: freshParsed };
      // fresh == null → 走 tier-3
    } catch (e: any) {
      lastLazyRefreshResult = { ok: false, reason: String(e?.message || e).slice(0, 200), at: now };
      // 不致命,继续走守门 fallback
    }
  }

  // ③ 守门 fallback(独立复算,30s timeout,即使上游 DB 全坏仍可走 git)
  try {
    const g = runGuardAndParse();
    if (g.audit_violations != null) {
      return { ok: true, source: "guard-fallback", audit_violations: g.audit_violations };
    }
    return {
      ok: false,
      source: "guard-fallback",
      reason: "guard-script-no-value(exit=" + g.code + ")",
      replay: "node " + (process.env.LIONS_HOME || process.cwd()) + "/scripts/pl-trust-guard.cjs",
    };
  } catch (e: any) {
    return {
      ok: false,
      source: "guard-fallback",
      reason: "guard-script-threw:" + String(e?.message || e).slice(0, 200),
      replay: "node " + (process.env.LIONS_HOME || process.cwd()) + "/scripts/pl-trust-guard.cjs",
    };
  }
}

/** 暴露给 selftest 用的内部节流状态(便于测试时清零)。 */
export function __resetLazyThrottleForTest(): void {
  lastLazyRefreshAt = 0;
  lastLazyRefreshResult = null;
}