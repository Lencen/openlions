/**
 * llm-calls-5h.ts — 平台滚动 5h LLM 调用计量 (**单一事实源**, 2026-10-11 PL-COST 机制修复)
 *
 * 为什么存在 (根因):
 *   订阅约束 = 每 5 小时 6000 次调用(token 不限), PL-COST 目标 ≤4800。此前有**两套互相脱节**的计数:
 *     - goal-gap.ts 只数 FlywheelEvent.stage='CALL_LLM', 查询任何异常直接把 llm_calls_5h 置 null
 *       => goal-check 每 6h 开单 "指标 llm_calls_5h 塌在 -"(本次任务的直接触发)。
 *     - agent-quota.ts 同口径, 异常返回 0 —— 把"测不到"伪装成"没用量", 对 cap 指标更危险。
 *   更根本的缺陷: macs_responder.call_brain() 每次大脑调用都 _record_brain_call(),
 *   但 flush_brain_call_stat() 把累计次数放在 **top-level `calls`** 字段且 batch 只发 1 条;
 *   后端 brain-calls 路由只遍历 batch => **每次 flush 只写 1 条 CALL_LLM**, 聚合次数被丢弃。
 *   实测证据 (2026-10-11):
 *     - `node scripts/llm-usage-real.cjs` => 真实 666 次/5h, 平台可见 58 次, 盲区 608 次;
 *     - `journalctl --user -u macs-responder-deepseek` => 每轮 "brain_call_stat flush OK: written=1"(与真实 calls 无关)。
 *
 * 口径 (goal-gap 与 agent-quota 共用, 只此一份):
 *   platform = COUNT(FlywheelEvent stage='CALL_LLM' AND createdAt >= w5)  // 后端修复后每次调用 1 条
 *   real     = SUM(CAST(json_extract(sourceTitle,'$.calls') AS INTEGER)) over stage='LLM_USE_REAL'
 *              (responder /api/flywheel/agents/usage 逐次上报的真实调用; 网络失败不计次)
 *   value    = max(platform, real)
 *   为什么取 max 而不是相加: platform 与 real 是**对同一批调用的两路独立埋点**
 *     (call_brain 的 CALL_LLM 累计 与 _report_usage 的 LLM_USE_REAL 逐次), 相加会重复计数;
 *     取 max 既避免双计, 又是真实用量的**下界**(对 cap 指标宁可高估不可低估的镜像: 这里是下界, 见下)。
 *
 * 为什么"永不返回 null"(兜底链):
 *   上游任一环节断裂不应让指标塌成 "-", 否则每 6h 会自动开一条无法复算的机制修复单(实测反复发生)。
 *   读路径: prisma -> 直连 better-sqlite3(只读, 绕开 prisma 连接池) -> 本地快照(~/.cache/lions)。
 *   全部失败才返回 0 且 degraded=true —— 值由 detail 显式标注, **不静默**(D1: 不把缺失伪装成达标)。
 */

import fs from "fs";
import os from "os";
import path from "path";
import { prisma } from "@/lib/prisma";

export const LLM_CALLS_5H_WINDOW_MS = 5 * 3600 * 1000;

/**
 * L3b 口径落点 (2026-10-11 PL-COST 实践遗留 cmv301qbc00rcoy3kt 落地):
 *   docs/platform-logic/goals.md:113 明文 —— "网络不通的调用不计入次数, 故该指标只统计
 *   targetStage=OK 与非网络类失败(网络失败单列观测)"。
 *   但修复前的 SQL 完全没看 targetStage;实测全时段 CALL_LLM 里有 `FAIL:NETWORK` 929 条被误计入 PL-COST。
 *   (口径依赖的窗口边界是 createdAt 内联整数毫秒: 见头注 L2 实测 —— `datetime('now',...)` 或
 *    显式 ISO 字符串参数在该库返回 0, 而整数毫秒/Date 参数返回真值。此处统一内联整数, 消除绑定歧义。)
 */
export const COUNTED_TARGET_PREDICATE = "(targetStage IS NULL OR targetStage NOT LIKE '%NETWORK%')";
export const NETWORK_FAILURE_PREDICATE = "(targetStage LIKE '%NETWORK%')";

export interface LlmCalls5hReading {
  /** 用于指标判定的滚动 5h 调用数(下界, 永不 null) */
  value: number;
  /** 平台自记 CALL_LLM 事件数(已按 goals.md:113 排除网络失败) */
  platform: number;
  /** responder 逐次上报的真实调用 SUM(LLM_USE_REAL.calls) */
  real: number;
  /** 5h 窗口内被口径排除的网络类失败数(单列观测, 不计入 value) */
  networkFailures: number;
  source: "prisma" | "sqlite" | "snapshot" | "none";
  degraded: boolean;
  at: number;
}

const SNAPSHOT_FILE =
  process.env.LIONS_LLM_CALLS_SNAPSHOT || path.join(os.homedir(), ".cache", "lions", "llm-calls-5h.json");

/** 候选 mind 库路径(直连兜底用); 与 todo-store.ts / llm-usage 路由同口径, 额外补主库绝对路径。 */
function dbCandidates(): string[] {
  const out: string[] = [];
  if (process.env.MIND_DB_PATH) out.push(process.env.MIND_DB_PATH);
  out.push(path.join(process.cwd(), "prisma", "dev.db"));
  out.push("" + (process.env.LIONS_HOME || process.cwd()) + "/packages/apps/mind/prisma/dev.db");
  return [...new Set(out)];
}

/** 主路径: prisma 原生查询 */
async function readViaPrisma(sinceMs: number): Promise<{ platform: number; real: number; networkFailures: number }> {
  // 内联整数毫秒窗口边界(非用户输入): 不依赖驱动对 Date/ISO 的序列化, 实测最稳。
  const w = Math.trunc(sinceMs);
  const calls: any[] = await prisma.$queryRawUnsafe(
    "SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt >= " + w + " AND " + COUNTED_TARGET_PREDICATE
  );
  const net: any[] = await prisma.$queryRawUnsafe(
    "SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt >= " + w + " AND " + NETWORK_FAILURE_PREDICATE
  );
  const real: any[] = await prisma.$queryRawUnsafe(
    "SELECT COALESCE(SUM(CAST(json_extract(sourceTitle,'$.calls') AS INTEGER)),0) s FROM FlywheelEvent " +
      "WHERE stage='LLM_USE_REAL' AND json_valid(sourceTitle) AND createdAt >= " + w
  );
  return {
    platform: Number(calls?.[0]?.c ?? 0),
    real: Math.round(Number(real?.[0]?.s ?? 0)),
    networkFailures: Number(net?.[0]?.c ?? 0),
  };
}

/** 兜底 1: 直连只读 sqlite(绕开 prisma 连接池; 连接池故障/脏视图时仍可复算) */
async function readViaSqlite(sinceMs: number): Promise<{ platform: number; real: number; networkFailures: number }> {
  const mod: any = await import("better-sqlite3");
  const Database = mod.default ?? mod;
  let lastErr: any = null;
  for (const p of dbCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const db = new Database(p, { readonly: true, fileMustExist: true });
      try {
        const platform = Number(
          db
            .prepare(
              "SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt >= ? AND " + COUNTED_TARGET_PREDICATE
            )
            .get(sinceMs).c
        );
        const networkFailures = Number(
          db
            .prepare(
              "SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt >= ? AND " + NETWORK_FAILURE_PREDICATE
            )
            .get(sinceMs).c
        );
        const real = Math.round(
          Number(
            db
              .prepare(
                "SELECT COALESCE(SUM(CAST(json_extract(sourceTitle,'$.calls') AS INTEGER)),0) s FROM FlywheelEvent " +
                  "WHERE stage='LLM_USE_REAL' AND json_valid(sourceTitle) AND createdAt >= ?"
              )
              .get(sinceMs).s
          )
        );
        return { platform, real, networkFailures };
      } finally {
        db.close();
      }
    } catch (e: any) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no readable mind db candidate");
}

/** 兜底 2: 上次成功读到的快照(本地缓存, 跨进程重启可用) */
function readSnapshot(): { platform: number; real: number; at: number } | null {
  try {
    const j = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
    if (j && Number.isFinite(Number(j.value))) {
      return { platform: Number(j.platform ?? 0), real: Number(j.real ?? 0), at: Number(j.at ?? 0) };
    }
  } catch {
    /* 无快照 */
  }
  return null;
}

function writeSnapshot(platform: number, real: number, value: number, at: number): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ value, platform, real, at }), "utf-8");
  } catch {
    /* 快照写失败非致命 */
  }
}

/** 纯合成(可单测, 不碰 DB): value = max(platform, real) */
export function composeLlmCalls5h(platform: number, real: number): number {
  const p = Number.isFinite(platform) && platform > 0 ? Math.trunc(platform) : 0;
  const r = Number.isFinite(real) && real > 0 ? Math.round(real) : 0;
  return Math.max(p, r);
}

/**
 * 纯函数(可单测): 把 responder 的"汇总 batch + top-level calls=N"展开成 N 条事件。
 * 这是 PL-COST 后端修复的核心 —— 旧实现只遍历 batch(1 条) => 聚合次数被丢弃。
 * - declared <= 0 或无 batch: 原样返回(向后兼容逐条语义)
 * - declared > maxBatch: 截断到 maxBatch 并如实回报 truncated(不静默丢数)
 */
export function expandBrainCallEntries<T>(batch: T[], declaredCalls: number, maxBatch = 500): { entries: T[]; truncated: number } {
  const declared = Number.isFinite(declaredCalls) ? Math.trunc(declaredCalls) : 0;
  if (declared > 0 && Array.isArray(batch) && batch.length > 0) {
    return {
      entries: Array.from({ length: Math.min(declared, maxBatch) }, () => batch[0]),
      truncated: declared > maxBatch ? declared - maxBatch : 0,
    };
  }
  return { entries: Array.isArray(batch) ? batch : [], truncated: 0 };
}

/**
 * 读滚动 5h 调用数。**永不 null**: prisma -> 直连 sqlite -> 快照 -> 0(degraded)。
 * @param nowMs 便于测试注入
 */
export async function llmCalls5h(nowMs: number = Date.now()): Promise<LlmCalls5hReading> {
  const sinceMs = nowMs - LLM_CALLS_5H_WINDOW_MS;
  try {
    const r = await readViaPrisma(sinceMs);
    const value = composeLlmCalls5h(r.platform, r.real);
    writeSnapshot(r.platform, r.real, value, nowMs);
    return { value, platform: r.platform, real: r.real, networkFailures: r.networkFailures, source: "prisma", degraded: false, at: nowMs };
  } catch (e: any) {
    console.warn("[llm-calls-5h] prisma 读取失败, 走直连兜底: " + String(e?.message || e).slice(0, 120));
  }
  try {
    const r = await readViaSqlite(sinceMs);
    const value = composeLlmCalls5h(r.platform, r.real);
    writeSnapshot(r.platform, r.real, value, nowMs);
    return { value, platform: r.platform, real: r.real, networkFailures: r.networkFailures, source: "sqlite", degraded: true, at: nowMs };
  } catch (e: any) {
    console.warn("[llm-calls-5h] 直连读取失败, 走快照兜底: " + String(e?.message || e).slice(0, 120));
  }
  const snap = readSnapshot();
  if (snap) {
    const value = composeLlmCalls5h(snap.platform, snap.real);
    return { value, platform: snap.platform, real: snap.real, networkFailures: 0, source: "snapshot", degraded: true, at: nowMs };
  }
  return { value: 0, platform: 0, real: 0, networkFailures: 0, source: "none", degraded: true, at: nowMs };
}
