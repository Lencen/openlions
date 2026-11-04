/**
 * open-mind-db.ts — **mind 活库(dev.db) 直连的唯一入口**(2026-10-16 第 4 次事故后收口)
 * ================================================================================================
 * 为什么要有它(实测, 见 docs/platform-logic/mind-db-direct-sqlite-consolidation-plan-2026-10-16.md):
 *   · 全仓曾有 **29 处 `new Database()`**(mind 库 23 处 = 19 读写 / 4 只读), **0 处** pin
 *     `wal_autocheckpoint`, **0 处**设 `journal_mode`, 1 处完全没有 `busy_timeout`;
 *   · Prisma 主连接刻意 `connection_limit=1`("从机制上消灭世代漂移", 2026-09-17 RCA) —— 这条不变式
 *     被那 19 条读写直连打破: **它们各自都能触发 autocheckpoint = WAL 重置/换代**;
 *   · 仪器(`scripts/mind-db-openers-watch.cjs`)实测: 仪器上线 35 分钟内 7 条强信号换代事件里,
 *     有的事件当刻**有非 mind 进程以 `dev.db[读写]` 持库**(cron / service-check-5h / session-extract)
 *     ⇒ 换代来源无法唯一归因。
 *
 * **本模块是那条不变式的代码化**:唯一 owner 换代, 其余直连只写帧。
 *   role = "owner"      仅 Prisma 以外的**经批准的唯一换代方**(当前不用; Prisma 主连接自带默认阈值)
 *   role = "direct-rw"  读写直连: `busy_timeout` + **`wal_autocheckpoint = 0`**(不主动换代)
 *   role = "readonly"   只读直连: `busy_timeout`(读者不 commit, 天然不换代)
 *
 * 纪律(与本仓既有约定一致):
 *   · **绝不设置 `journal_mode`** —— WAL 是**持久在库文件里**的模式; 逐连接再设等于一次库级切换
 *     (平台有 `journal-mode-guard` 专守此线)。本模块只做**只读断言**, 不符即**大声失败**。
 *   · **总开关** `MIND_SQLITE_POLICY=legacy` ⇒ 完全按 2026-10-16 收口之前的现状行为(不打 autocheckpoint),
 *     用于秒级回滚与 A/B。
 *   · **连接留痕**: 每次打开追加一行到 `logs/mind-db-connects.jsonl`(role/pid/路径/rw/busy/pragma),
 *     与 `/proc` 那件常开仪器**互为印证**(应用内视角 + 应用外视角)。`MIND_SQLITE_TRACE=0` 可关。
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export type MindDbRole = "owner" | "direct-rw" | "readonly";

const POLICY: "strict" | "legacy" = process.env.MIND_SQLITE_POLICY === "legacy" ? "legacy" : "strict";
/** owner 的换代阈值(第 4 批才生效: `MIND_WAL_AUTOCHECKPOINT=4000`; 默认 1000 = SQLite 默认, 即"不降频") */
const OWNER_AUTOCHECKPOINT = Number(process.env.MIND_WAL_AUTOCHECKPOINT ?? "1000");
const DEFAULT_BUSY_MS = Number(process.env.MIND_SQLITE_BUSY_MS ?? "4000");
const TRACE = process.env.MIND_SQLITE_TRACE !== "0";
const TRACE_CAP = 32 * 1024 * 1024;

/**
 * 留痕目录的**健壮解析**(2026-10-17 修: 早期版本只按 `cwd/../../logs` 推, 若进程 cwd 不是
 * `packages/apps/mind` 就会静默写失败 —— 而 `trace()` 当时吞掉异常 ⇒ "看着有留痕、其实没有")。
 * 顺序: `LIONS_LOG_DIR` → `cwd/../../logs` → `cwd/logs` → 仓库根的 `logs`(按 cwd 向上找 `packages` 目录)。
 */
function resolveLogDir(): string | null {
  const cands: string[] = [];
  if (process.env.LIONS_LOG_DIR) cands.push(process.env.LIONS_LOG_DIR);
  cands.push(path.resolve(process.cwd(), "..", "..", "logs"));
  cands.push(path.resolve(process.cwd(), "logs"));
  let d = process.cwd();
  for (let i = 0; i < 5; i++) { d = path.resolve(d, ".."); cands.push(path.join(d, "logs")); if (fs.existsSync(path.join(d, "package.json"))) break; }
  for (const c of cands) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) { fs.accessSync(c, fs.constants.W_OK); return c; } } catch { /* 试下一个 */ }
  }
  return null;
}
const LOG_DIR = resolveLogDir();

let tracedBytes = -1;
let traceWarned = false;

function trace(rec: Record<string, unknown>): void {
  if (!TRACE) return;
  if (!LOG_DIR) {   // 找不到可写 logs 目录 ⇒ **说出来**(绝不静默)
    if (!traceWarned) { traceWarned = true; console.error("[open-mind-db] 连接留痕被跳过: 找不到可写的 logs 目录(设 LIONS_LOG_DIR 可指定)"); }
    return;
  }
  try {
    const f = path.join(LOG_DIR, "mind-db-connects.jsonl");
    if (tracedBytes < 0) { try { tracedBytes = fs.statSync(f).size; } catch { tracedBytes = 0; } }
    if (tracedBytes >= TRACE_CAP) {
      try { fs.renameSync(f, f + ".1"); } catch { /* ignore */ }
      tracedBytes = 0;
    }
    const s = JSON.stringify(rec) + "\n";
    fs.appendFileSync(f, s);
    tracedBytes += Buffer.byteLength(s, "utf8");
  } catch (e) {
    if (!traceWarned) { traceWarned = true; console.error("[open-mind-db] 连接留痕写入失败: " + String(e)); }
  }
}

export interface OpenMindDbOpts {
  role: MindDbRole;
  dbPath: string;
  /** 覆盖默认 4000ms(批量路径如 retract=10000 / retraction-scan=15000, 需在调用点写明理由) */
  busyTimeoutMs?: number;
  fileMustExist?: boolean;
  /** 留痕里标注调用者(route/pipeline 名), 便于按来源聚合 */
  caller?: string;
}

/** 连接实例类型: 该模块只导出默认构造器(见 src/types/better-sqlite3.d.ts), 故用 ReturnType 取实例类型 */
type SqliteDb = ReturnType<typeof Database>;

export function openMindDb(opts: OpenMindDbOpts): SqliteDb {
  const readonly = opts.role === "readonly";
  const db = readonly
    ? new Database(opts.dbPath, { readonly: true, fileMustExist: opts.fileMustExist ?? true })
    : new Database(opts.dbPath, opts.fileMustExist ? { fileMustExist: true } : undefined);
  const busyMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_MS;
  db.pragma("busy_timeout = " + busyMs);
  let walAutocheckpoint: number | null = null;
  if (!readonly && POLICY === "strict") {
    walAutocheckpoint = opts.role === "owner" ? OWNER_AUTOCHECKPOINT : 0;
    db.pragma("wal_autocheckpoint = " + walAutocheckpoint);
  }
  // 只读断言(绝不设置): WAL 是持久模式; 不符 ⇒ 大声失败(不静默切换)
  let journalMode = "?";
  try { journalMode = String(db.pragma("journal_mode", { simple: true }) ?? "?"); } catch { /* 读不到就只留痕 */ }
  if (POLICY === "strict" && !readonly && journalMode.toLowerCase() !== "wal") {
    try { db.close(); } catch { /* ignore */ }
    throw new Error("mind 活库不是 WAL 模式(journal_mode=" + journalMode + ") —— 拒绝静默切换; 见 src/server/lib/open-mind-db.ts");
  }
  trace({
    t: new Date().toISOString(), role: opts.role, caller: opts.caller ?? null,
    pid: process.pid, db: opts.dbPath, rw: !readonly, busyMs, walAutocheckpoint,
    journalMode, policy: POLICY,
  });
  return db;
}
