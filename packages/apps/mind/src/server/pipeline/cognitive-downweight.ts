/**
 * cognitive-downweight.ts — 认知行降权/升权 的**核心服务实现** (2026-10-16)
 * =============================================================================================
 * 为什么有这个文件(不是"又加一条写入路径", 而是**收回**一条)
 * ---------------------------------------------------------------------------------------------
 * 业务逻辑原本只在 `scripts/downweight-cognitive-rows.cjs` 里, 由 `lions-cognitive-downweight.timer`
 * 每日 04:00 以 **直连账本(better-sqlite3 读写句柄)** 的方式执行。2026-10-16 的根因收尾给所有
 * 直连写者加了统一维护窗口闸门(`scripts/lib/mind-db-write-window.cjs`), 于是它每天被**正确拒绝**
 * (rc=3) —— 业务停摆。人类裁决(2026-10-16 及更早):
 *   · "暂停检修不是一个可持续的办法, 肯定是不能每天停 mind 的";
 *   · "需要改统一核心服务入库。不能分散各写各的"。
 * 所以正确解法 = 把这个重算搬进核心服务(mind 是 DB-ACCESS-RULE 下**唯一**允许读写生产库的进程),
 * 由脚本经 HTTP 调用。**公式/判据/写入列与直连脚本逐行等价**(见 computeWeightTier 与
 * scripts/acceptance 的逐行比对验收), 差别只有一个: 写入入口是 Prisma(唯一构造点)。
 *
 * 公式(与 round 72-E 逐字相同)
 * ---------------------------------------------------------------------------------------------
 *   effectiveAge = daysSinceCreated * (1 - clamp(usageCount / 50, 0, 0.9))
 *   weight       = qualityScore * 2^(-effectiveAge / 90)        // 90 天半衰期
 *   tier         = weight < deep ? DEEP_COLD : weight < floor ? COLD : WARM
 *   · HOT / GLOBAL 是别处赋的"核心层"标记(agent-memory-snapshot.ts 只选这两类), **一律不碰**
 *     (2026-10-10 round 72-U 的实测事故: 原实现把 3,777 行 HOT/GLOBAL 压成 WARM, 核心记忆候选集归零);
 *   · Memory 落 tier + decayScore; Knowledge/Skill 落 tier + staleReason(可追溯的文本原因, 不是裸浮点);
 *   · Practice 无 usageCount/qualityScore 强制列 -> 只统计不降权(留口)。
 *
 * 与原直连脚本的**唯一**行为差异(显式声明, 且在验收里逐列复算)
 * ---------------------------------------------------------------------------------------------
 *   三张表的 updatedAt 是 `@updatedAt`(Prisma 会在 update 时自动刷新)。原直连 SQL **不碰**
 *   updatedAt。为保持"同样的更新", 本实现对每条要写的行**显式回写原 updatedAt 值**
 *   (Prisma 会以显式值为准)。验收会断言"除 tier/decayScore/staleReason 外**无任何列变化**"。
 *
 * 护栏(今天血的教训, 一条都不能少)
 * ---------------------------------------------------------------------------------------------
 *   ① **并发不得重复执行**: FlywheelJob(idempotencyKey UNIQUE) 上的 **CAS 认领** —— 与
 *      `src/server/pipeline/improving-tasks-cron.ts` / `structure-fragments.ts` 同一约定
 *      ("`UPDATE ... WHERE status<>'PROCESSING'` 影响行数=1 才拿到执行权"), 另有进程内互斥。
 *   ② **账本损坏/冻结期禁写**: `logs/MIND_DB_FROZEN.json`(冻结单点文件) + `logs/db-state.json`
 *      的 state=corrupt + `LIONS_DB_WRITE_FROZEN=1` 三道, 任一命中即**拒绝**; 定位不到冻结标记
 *      时 **fail-closed**(拒绝)。干跑(只读)不受此限 —— 事故期也要能看数据。
 *   ③ **可观测**: 每次执行写一条 `AuditLog`(经 `src/server/lib/audit-log.ts` 的**单一实现**),
 *      并把末次状态写回 FlywheelJob(既有"job 行存末次摘要"约定, 见 structure-fragments.ts)。
 *   ④ **失败显式**: 写入/记录失败一律向上抛 -> 路由返 5xx; 绝不吞掉。
 */
import path from "node:path";
import fs from "node:fs";
import { prisma } from "@/lib/prisma";

// ── 常量(默认值与直连脚本一致) ────────────────────────────────────────────────
export const DAY_MS = 86_400_000;
export const DOWNWEIGHT_ACTOR = "cron:cognitive-downweight";
export const DOWNWEIGHT_LOCK_KEY = "cognitive-downweight:lock";
export const DOWNWEIGHT_JOB_TYPE = "COGNITIVE_DOWNWEIGHT";
export const DEFAULT_HALFLIFE = 90;
export const DEFAULT_FLOOR = 0.3;
export const DEFAULT_DEEP = 0.05;
/** 锁的租约: 超过它仍未结束的 PROCESSING 行视为"上次进程崩了", 允许接管 */
export const DEFAULT_LOCK_LEASE_MS = 30 * 60 * 1000;

export type Tier = "WARM" | "COLD" | "DEEP_COLD";

export interface WeightParams {
  halflife: number;
  floor: number;
  deep: number;
}

/** 三张参与降权的表 -> 字段映射(与直连脚本的表定义逐字相同) */
export interface DownweightTable {
  table: "Memory" | "Knowledge" | "Skill";
  quality: string;
  usage: string | null;
  time: string;
}

export const DOWNWEIGHT_TABLES: DownweightTable[] = [
  { table: "Memory", quality: "importance", usage: null, time: "createdAt" },
  { table: "Knowledge", quality: "confidence", usage: "usageCount", time: "createdAt" },
  { table: "Skill", quality: "qualityScore", usage: "totalUsageCount", time: "createdAt" },
];

/** 纯函数: 与 scripts/downweight-cognitive-rows.cjs 的 compute() **逐字等价**(可单测/可复算) */
export function computeWeightTier(
  qualityScore: unknown,
  usageCount: unknown,
  createdAtMs: unknown,
  nowMs: number,
  p: WeightParams,
): { weight: number; tier: Tier; days: number; effectiveAge: number; usageCount: number; qualityScore: number } {
  const q =
    typeof qualityScore === "number" && isFinite(qualityScore)
      ? Math.max(0, Math.min(1, qualityScore))
      : 0.5;
  const u =
    typeof usageCount === "number" && isFinite(usageCount) ? Math.max(0, usageCount) : 0;
  const days = Math.max(0, (nowMs - Number(createdAtMs)) / DAY_MS);
  const effectiveAge = days * (1 - Math.min(0.9, u / 50));
  const weight = q * Math.pow(2, -effectiveAge / p.halflife);
  const tier: Tier = weight < p.deep ? "DEEP_COLD" : weight < p.floor ? "COLD" : "WARM";
  return { weight, tier, days, effectiveAge, usageCount: u, qualityScore: q };
}

/** 与直连脚本同一格式: Number(n).toFixed(4) */
export function fmt4(n: number): string {
  return Number(n).toFixed(4);
}

/** staleReason 文案(与直连脚本逐字相同; 非 Memory 表写它, 保证"退休原因可追溯") */
export function staleReasonText(
  weight: number,
  tier: Tier,
  p: WeightParams,
  dateStr: string,
  id: string,
): string {
  return (
    "[round 72-E 降权 " + dateStr + "] w=" + fmt4(weight) +
    " floor=" + p.floor + " deep=" + p.deep + " halflife=" + p.halflife + "d" +
    (tier === "DEEP_COLD" ? " deep_cold" : "") + " id=" + id
  );
}

// ── 参数归一(与直连脚本同一口径) ─────────────────────────────────────────────
export function normalizeParams(input: { halflife?: unknown; floor?: unknown; deep?: unknown }): WeightParams {
  const halflife = Math.max(1, Number(input.halflife ?? DEFAULT_HALFLIFE) || DEFAULT_HALFLIFE);
  const floor = Math.max(0, Math.min(1, Number(input.floor ?? DEFAULT_FLOOR)));
  const deep = Math.max(0, Math.min(floor, Number(input.deep ?? DEFAULT_DEEP)));
  return { halflife, floor, deep };
}

// ── 账本写保护(冻结/损坏) ─────────────────────────────────────────────────────
export interface LedgerPaths {
  dbFile: string;
  repoRoot: string | null;
  freezeStatePath: string | null;
  dbStatePath: string | null;
  rootHow: string;
}

/** 与 packages/apps/mind/src/lib/prisma.ts:32-33 同口径的库路径(用于反推仓库根) */
function configuredDbFile(): string {
  const env = process.env.LIONS_MIND_DB || process.env.MIND_DB_PATH;
  return env ? path.resolve(env) : path.resolve(process.cwd(), "prisma", "dev.db");
}

/** 从某个起点向上找"仓库根": 判据 = 存在 scripts/mind-db-freeze.sh(该文件的唯一位置就是仓库根) */
function findRepoRoot(startDir: string): string | null {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    try {
      if (fs.existsSync(path.join(cur, "scripts", "mind-db-freeze.sh"))) return cur;
    } catch { /* 继续向上 */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

export function resolveLedgerPaths(): LedgerPaths {
  const dbFile = configuredDbFile();
  let root = findRepoRoot(path.dirname(dbFile));
  let rootHow = "db-file-walk-up";
  if (!root) {
    root = findRepoRoot(process.cwd());
    rootHow = "cwd-walk-up";
  }
  if (!root) {
    // 退化: 假定 <root>/packages/apps/mind/prisma/dev.db 的经典布局
    const guess = path.resolve(path.dirname(dbFile), "..", "..", "..", "..");
    root = fs.existsSync(guess) ? guess : null;
    rootHow = root ? "classic-layout-guess" : "not-found";
  }
  const freezeStatePath = process.env.MIND_DB_FREEZE_STATE
    ? path.resolve(process.env.MIND_DB_FREEZE_STATE)
    : root
      ? path.join(root, "logs", "MIND_DB_FROZEN.json")
      : null;
  const dbStatePath = process.env.MIND_DB_STATE_FILE
    ? path.resolve(process.env.MIND_DB_STATE_FILE)
    : root
      ? path.join(root, "logs", "db-state.json")
      : null;
  return { dbFile, repoRoot: root, freezeStatePath, dbStatePath, rootHow };
}

export interface LedgerRefusalReport {
  refused: boolean;
  reasons: string[];
  notes: string[];
  paths: LedgerPaths;
}

/**
 * 写前账本状态判定(**只读**)。只判"能不能写", 不发写动作。
 * 三道判据全部来自平台既有机制(冻结单点文件 / db-state 单点文件 / 应用层冻结环境变量),
 * 本函数不新造状态。定位不到冻结标记时 **fail-closed**(拒绝), 绝不"看不到就当没冻结"。
 */
export function ledgerWriteRefusals(): LedgerRefusalReport {
  const paths = resolveLedgerPaths();
  const reasons: string[] = [];
  const notes: string[] = [];

  if (process.env.LIONS_DB_WRITE_FROZEN === "1") {
    reasons.push("LIONS_DB_WRITE_FROZEN=1 -> mind 写入入口已被置为只读(检测即冻结)");
  }

  if (!paths.freezeStatePath) {
    reasons.push("无法定位冻结标记(logs/MIND_DB_FROZEN.json) -> fail-closed, 拒绝写入");
  } else {
    const dir = path.dirname(paths.freezeStatePath);
    if (!fs.existsSync(dir)) {
      reasons.push("冻结标记所在目录不存在(" + dir + ") -> 无法核验账本是否冻结, fail-closed 拒绝写入");
    } else if (fs.existsSync(paths.freezeStatePath)) {
      let why = "";
      try {
        const j = JSON.parse(fs.readFileSync(paths.freezeStatePath, "utf8"));
        why = String(j?.reason || j?.engagedAt || "").slice(0, 120);
      } catch { /* 打不开也当冻结 */ }
      reasons.push(
        "账本处于**冻结**状态(" + paths.freezeStatePath + " 存在" + (why ? "; 原因: " + why : "") +
        ") -> 冻结期一律禁写(解除见 scripts/mind-db-freeze.sh release)",
      );
    } else {
      notes.push("冻结标记不存在(未冻结): " + paths.freezeStatePath);
    }
  }

  if (paths.dbStatePath && fs.existsSync(paths.dbStatePath)) {
    try {
      const j = JSON.parse(fs.readFileSync(paths.dbStatePath, "utf8"));
      const st = String(j?.state || "unknown");
      if (st === "corrupt") {
        reasons.push(
          "账本当前状态 state=corrupt(" + paths.dbStatePath + "; checkedAt=" + String(j?.checkedAt || "?") +
          ") -> 损坏期一律禁写",
        );
      } else {
        notes.push("db-state 当前 state=" + st + "(非 corrupt, 不阻塞)");
      }
    } catch (e: any) {
      notes.push("db-state 不可解析(视为 unknown, 不阻塞): " + String(e?.message || e).slice(0, 80));
    }
  } else if (paths.dbStatePath) {
    notes.push("db-state 文件不存在(视为 unknown, 不阻塞): " + paths.dbStatePath);
  }

  return { refused: reasons.length > 0, reasons, notes, paths };
}

// ── 并发锁(FlywheelJob CAS; 既有约定) ─────────────────────────────────────────
/**
 * 2026-10-16 线上复盘(端点首发后"重复调用 500"的缺陷修复, 见 verification/cognitive-downweight-endpoint-*):
 *   · 干跑**不再建锁/不写库** —— 预览不该开写句柄(同 backfill-skill-describe-2026-10-09.cjs 的处置),
 *     这正是"账本坏了/冻结了, 干跑照样能看数据"的前提;
 *   · `apply` 的重复调用按**冷却窗**返回 409 `ALREADY_RAN_RECENTLY`(而不是默默再跑一遍),
 *     但**绝不**用冷却去挡一个正在跑的持有者(那种情况是 ALREADY_RUNNING);
 *   · `force` 只绕过冷却, **不**绕过"有人正在跑"。
 */
export const DEFAULT_MIN_INTERVAL_MS = 30 * 60 * 1000; // 与租约同量级: 一个窗口内只跑一次 apply

export interface LockState {
  acquired: boolean;
  reason?: "ALREADY_RUNNING" | "ALREADY_RAN_RECENTLY";
  heldSince?: string;
  lastCompletedAt?: string;
  lastSummary?: string;
}

/** 读锁行(只读 SELECT; 仅用于决定"该报哪种拒绝理由", 权威判据仍是下面的 CAS) */
async function readLockRow(): Promise<{ status: string; startedAt: Date | null; completedAt: Date | null; error: string | null } | undefined> {
  const rows: any = await prisma.$queryRawUnsafe(
    "SELECT status, startedAt, completedAt, error FROM FlywheelJob WHERE idempotencyKey = ? LIMIT 1",
    DOWNWEIGHT_LOCK_KEY,
  );
  const r = Array.isArray(rows) ? rows[0] : rows;
  if (!r) return undefined;
  return {
    status: String(r.status),
    startedAt: r.startedAt ? new Date(r.startedAt) : null,
    completedAt: r.completedAt ? new Date(r.completedAt) : null,
    error: r.error == null ? null : String(r.error),
  };
}

/**
 * CAS 认领执行位: `updateMany(... WHERE idempotencyKey=? AND (status<>'PROCESSING' OR startedAt<租约下限))`
 * 的影响行数=1 才算拿到执行权(与 improving-tasks-cron 的 CAS 认领同一判据)。
 * 行不存在时 create; create 撞 UNIQUE(P2002) = 另一路刚抢到 -> ALREADY_RUNNING。
 */
export async function acquireDownweightLock(
  leaseMs: number,
  actor: string,
  opts: { minIntervalMs?: number; force?: boolean } = {},
): Promise<LockState> {
  const now = Date.now();
  const minIntervalMs = Math.max(0, Number(opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS));
  const staleBefore = new Date(now - leaseMs);

  // 先读一眼: 只为了给出**准确的拒绝理由**(正在跑 / 刚跑过); 真正的互斥仍靠下面的 CAS
  const row = await readLockRow();
  if (row && row.status === "PROCESSING" && row.startedAt && row.startedAt.getTime() >= now - leaseMs) {
    return { acquired: false, reason: "ALREADY_RUNNING", heldSince: row.startedAt.toISOString() };
  }
  if (
    row && row.status === "DONE" && !opts.force && minIntervalMs > 0 &&
    row.completedAt && row.completedAt.getTime() > now - minIntervalMs
  ) {
    return {
      acquired: false,
      reason: "ALREADY_RAN_RECENTLY",
      lastCompletedAt: row.completedAt.toISOString(),
      lastSummary: row.error || undefined,
    };
  }

  const res = await prisma.flywheelJob.updateMany({
    where: {
      idempotencyKey: DOWNWEIGHT_LOCK_KEY,
      OR: [{ status: { not: "PROCESSING" } }, { startedAt: null }, { startedAt: { lt: staleBefore } }],
    },
    data: {
      status: "PROCESSING",
      agentId: actor,
      startedAt: new Date(now),
      completedAt: null,
      error: null,
      priority: "P2",
      attempts: { increment: 1 },
    },
  });
  if (res.count === 1) return { acquired: true };
  // 0 行: 要么行不存在(首次), 要么正被持有
  try {
    await prisma.flywheelJob.create({
      data: {
        jobType: DOWNWEIGHT_JOB_TYPE,
        status: "PROCESSING",
        agentId: actor,
        priority: "P2",
        idempotencyKey: DOWNWEIGHT_LOCK_KEY,
        startedAt: new Date(now),
        scheduledAt: new Date(now),
        attempts: 1,
        maxAttempts: 1,
      },
    });
    return { acquired: true };
  } catch (e: any) {
    if (e?.code === "P2002") {
      const cur = await readLockRow();
      return {
        acquired: false,
        reason: "ALREADY_RUNNING",
        heldSince: cur?.startedAt ? cur.startedAt.toISOString() : undefined,
      };
    }
    throw e;
  }
}

/**
 * 端点异常分类: **结构化 + 状态码准确 + 不泄密**(不含栈/环境; message 截断 300)。
 * 为什么必须有它: 2026-10-16 首发时账本损坏(SQLITE_CORRUPT=11)导致 `flywheelJob.updateMany`
 * 抛错, 而那次调用落在错误信封之外 -> Next 返回**空 body 500**, 客户端完全无法诊断。
 */
export interface ClassifiedError {
  error: string;
  status: number;
  errorName: string;
  errorCode: string | null;
  message: string;
}

export function classifyLedgerError(e: any): ClassifiedError {
  const name = String(e?.name || "Error");
  const msg = String(e?.message || e || "").slice(0, 300);
  const code = e?.code != null ? String(e.code) : null;
  const ext = /extended_code:\s*(\d+)/.exec(String(e?.message || ""))?.[1] || null;
  const hay = name + " " + msg;
  const mk = (error: string, status: number): ClassifiedError => ({ error, status, errorName: name, errorCode: code || (ext ? "SQLITE_" + ext : null), message: msg });

  // SQLITE_CORRUPT(11) / malformed: 账本读不出来 —— 与"被冻结/只读"区分开
  if (/malformed|SQLITE_CORRUPT|extended_code:\s*11\b/i.test(hay)) return mk("LEDGER_UNREADABLE", 503);
  // 冻结(LIONS_DB_WRITE_FROZEN / 文件级只读): 写被明确拒绝
  if (/LedgerWriteFrozenError|ledger-frozen/.test(hay)) return mk("LEDGER_FROZEN", 503);
  if (/readonly database|SQLITE_READONLY|disk I\/O error|SQLITE_IOERR/i.test(hay)) return mk("LEDGER_NOT_WRITABLE", 503);
  // 开库世代闸门(别人的在制品: scripts/lib/mind-db-open-gate.cjs) fail-closed
  if (/ledger-open-gate|LedgerGenerationRefused/i.test(hay)) return mk("LEDGER_OPEN_GATE_REFUSED", 503);
  if (/AbortError|aborted/i.test(name + " " + code)) return mk("ABORTED", 408);
  return mk("ENDPOINT_ERROR", 500);
}

/** 末次状态回写(与 structure-fragments.ts 的 markJobDone 同约定: 摘要落在 error 列) */
export async function finishDownweightLock(
  status: "DONE" | "FAILED",
  summary: string,
): Promise<void> {
  await prisma.flywheelJob.updateMany({
    where: { idempotencyKey: DOWNWEIGHT_LOCK_KEY },
    data: { status, completedAt: new Date(), error: summary.slice(0, 500) },
  });
}

// ── 业务主体 ─────────────────────────────────────────────────────────────────
export interface DownweightCandidate {
  table: string;
  id: string;
  from: string;
  to: Tier;
  weight: number;
}

export interface DownweightTableReport {
  table: string;
  scanned: number;
  wouldWarm: number;
  wouldCold: number;
  wouldDeep: number;
  protectedHotGlobal: number;
  wouldUpdate: number;
  updated: number;
  skipped: number;
  candidates?: DownweightCandidate[];
}

export interface DownweightResult {
  dryRun: boolean;
  params: WeightParams & { apply: boolean };
  nowMs: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scanned: number;
  wouldUpdate: number;
  updated: number;
  skipped: number;
  unchanged: number;
  protected: number;
  practiceScanned: number;
  tables: DownweightTableReport[];
  candidates?: DownweightCandidate[];
}

export interface RunDownweightOptions {
  apply?: boolean;
  halflife?: unknown;
  floor?: unknown;
  deep?: unknown;
  /** 测试/复算用; 生产不传(= Date.now())。**只允许在 dryRun 下使用**(路由层强制) */
  nowMs?: number;
  /** 是否返回逐行候选清单(验收逐行比对用) */
  details?: boolean;
  signal?: AbortSignal;
}

interface ScanRow {
  id: string;
  q: unknown;
  u?: unknown;
  t: unknown;
  tier: string | null;
  updatedAt: unknown;
}

export async function runCognitiveDownweight(opts: RunDownweightOptions = {}): Promise<DownweightResult> {
  const apply = opts.apply === true;
  const p = normalizeParams(opts);
  const nowMs = typeof opts.nowMs === "number" && isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const startedAtMs = Date.now();
  const dateStr = new Date(nowMs).toISOString().slice(0, 19);

  const tables: DownweightTableReport[] = [];
  let scanned = 0;
  let wouldUpdate = 0;
  let updated = 0;
  let skipped = 0;
  let unchanged = 0;
  const allCandidates: DownweightCandidate[] = [];

  for (const spec of DOWNWEIGHT_TABLES) {
    if (opts.signal?.aborted) throw new Error("ABORTED");

    // 与直连脚本同一 SQL(多取 updatedAt 用于"逐列等价"的回写; 见文件头"唯一行为差异")
    const cols = ["id", spec.quality + " as q"];
    if (spec.usage) cols.push(spec.usage + " as u");
    cols.push(spec.time + " as t", "tier", "updatedAt");
    const rows = (await prisma.$queryRawUnsafe(
      "SELECT " + cols.join(", ") + " FROM " + spec.table,
    )) as ScanRow[];

    let wouldWarm = 0;
    let wouldCold = 0;
    let wouldDeep = 0;
    let protectedHotGlobal = 0;
    const plan: Array<{ id: string; to: Tier; weight: number; updatedAt: unknown; reason: string }> = [];

    for (const r of rows) {
      const c = computeWeightTier(r.q, r.u, r.t, nowMs, p);
      if (c.tier === "DEEP_COLD") wouldDeep++;
      else if (c.tier === "COLD") wouldCold++;
      else wouldWarm++;

      const currentTier = r.tier || "WARM";
      // HOT/GLOBAL 是"核心层"标记, 一律不碰(round 72-U 实测事故)
      if (currentTier === "HOT" || currentTier === "GLOBAL") {
        protectedHotGlobal++;
        continue;
      }
      if (c.tier === currentTier) {
        unchanged++;
        continue;
      }
      const reason = staleReasonText(c.weight, c.tier, p, dateStr, r.id);
      plan.push({ id: r.id, to: c.tier, weight: c.weight, updatedAt: r.updatedAt, reason });
      const cand: DownweightCandidate = { table: spec.table, id: r.id, from: currentTier, to: c.tier, weight: c.weight };
      allCandidates.push(cand);
    }

    let tableUpdated = 0;
    if (apply && plan.length > 0) {
      // 每表一个事务(与直连脚本的 per-table db.transaction 同粒度)
      const ops = plan.map((x) =>
        spec.table === "Memory"
          ? prisma.memory.update({
              where: { id: x.id },
              // 显式回写 updatedAt: 原直连 SQL 不碰它, 保持"同样的更新"(见文件头)
              data: { tier: x.to, decayScore: x.weight, updatedAt: new Date(x.updatedAt as any) },
            })
          : spec.table === "Knowledge"
            ? prisma.knowledge.update({
                where: { id: x.id },
                data: { tier: x.to, staleReason: x.reason, updatedAt: new Date(x.updatedAt as any) },
              })
            : prisma.skill.update({
                where: { id: x.id },
                data: { tier: x.to, staleReason: x.reason, updatedAt: new Date(x.updatedAt as any) },
              }),
      );
      await prisma.$transaction(ops);
      tableUpdated = plan.length;
    }

    scanned += rows.length;
    wouldUpdate += plan.length;
    updated += tableUpdated;
    skipped += apply ? 0 : plan.length;
    tables.push({
      table: spec.table,
      scanned: rows.length,
      wouldWarm,
      wouldCold,
      wouldDeep,
      protectedHotGlobal,
      wouldUpdate: plan.length,
      updated: tableUpdated,
      skipped: apply ? 0 : plan.length,
    });
  }

  // Practice: 只统计, 不参与降权(与直连脚本同口径)
  let practiceScanned = 0;
  try {
    const pr: any = await prisma.$queryRawUnsafe("SELECT COUNT(*) AS n FROM Practice");
    practiceScanned = Number(Array.isArray(pr) ? pr[0]?.n : pr?.n ?? 0);
  } catch (e: any) {
    // 计数失败不改变业务结论, 但要可见
    console.warn("[cognitive-downweight] Practice 计数失败: " + String(e?.message || e).slice(0, 120));
  }

  if (opts.details) {
    tables.forEach((t) => {
      t.candidates = allCandidates.filter((c) => c.table === t.table);
    });
  }

  const finishedAtMs = Date.now();
  const result: DownweightResult = {
    dryRun: !apply,
    params: { ...p, apply },
    nowMs,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    scanned,
    wouldUpdate,
    updated,
    skipped,
    unchanged,
    protected: tables.reduce((s, t) => s + t.protectedHotGlobal, 0),
    practiceScanned,
    tables,
  };
  if (opts.details) result.candidates = allCandidates;
  return result;
}

/** 执行记录的一条人读摘要(写进 FlywheelJob.error 与日志) */
export function summarizeRun(r: DownweightResult): string {
  return (
    (r.dryRun ? "DRY_RUN" : "DONE") +
    " scanned=" + r.scanned + " wouldUpdate=" + r.wouldUpdate +
    " updated=" + r.updated + " skipped=" + r.skipped +
    " unchanged=" + r.unchanged + " protected=" + r.protected +
    " durationMs=" + r.durationMs
  );
}
