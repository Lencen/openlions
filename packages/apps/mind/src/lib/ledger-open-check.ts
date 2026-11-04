/**
 * ledger-open-check.ts — **开库即校验世代**(mind 唯一写者的开库门) 2026-10-16
 * ==========================================================================================
 *
 * 为什么存在(见 `docs/platform-logic/mind-db-corruption-rootcause-and-nonrecurrence-2026-10-16.md` §G.0/G.1):
 *   三次账本损坏是同一类 —— **同一主库被多个 WAL 世代 checkpoint**。checkpoint 回写主库时
 *   **页号只来自 `-shm.aPgno`、内容来自 WAL 帧**, release 构建里没有任何交叉校验。
 *   既有防线都是"事后"(guard 每 5 分钟巡检 / 检出即冻结); 本模块把判据前移到**唯一写者开库那一刻**:
 *   **就算"外来世代"出现了, 错配的页号表也没机会被用于 checkpoint。**
 *
 * 落点为什么在这里:
 *   `src/lib/prisma.ts` 是**全 mind 应用唯一的 PrismaClient 构造点**(标题归一钩子、"检测即冻结"都在那里),
 *   所以开库门也挂在同一处 —— 不另造第二套入口。
 *
 * 行为(fail-closed):
 *   · 模块加载时**后台**跑一次 `ensureGeneration`(不阻塞进程启动; 判据=全量 `aPgno[i]` vs 帧头 `pgno`);
 *   · 任何**写操作**在放行前 `await` 这次自检:
 *       - pass    ⇒ 原样执行;
 *       - rebuilt ⇒ 原样执行(已在开库前把错配的 wal-index 从 WAL 重建, 并全量复验通过);
 *       - refuse  ⇒ **抛错拒写**(错误信息写清"为什么"与"怎么查"), 读操作不受影响。
 *   · 判据自身异常 ⇒ 也拒写(fail-closed), 绝不静默放行。
 *
 * 诚实边界:
 *   · 本机制**不能替代** guard/冻结/备份: 它只管"开库那一刻的世代自检";
 *   · 判据与"重建"动作的**权威实现在 CJS**(`scripts/lib/mind-db-open-gate.cjs` +
 *     `scripts/lib/wal-generation-identity.cjs`), 本文件只是一层薄接线(避免两套实现漂移);
 *   · **需 `next build` 才生效**(构建产物才含本模块), 在此之前行为不变 —— 验收见
 *     `packages/apps/mind/scripts/ledger-open-check-smoke.ts`(含"生产 cwd = app 目录"那一条)。
 */
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

/**
 * ★ 仓库根**不能**用 `process.cwd()` 锚定(2026-10-16 生产构建前的机器判据抓到, 已修):
 *   生产 mind 的 cwd 是 **app 目录**(`scripts/lions-service-wrapper.sh` 有 `cd "$APP_DIR"`,
 *   实测 `readlink /proc/<mind-pid>/cwd` = `<repo>/packages/apps/mind`), 不是仓库根。
 *   用 cwd 拼 `scripts/lib/mind-db-open-gate.cjs` 会 MODULE_NOT_FOUND ⇒ 在 fail-closed 设计下
 *   **每一笔写都被拒、而 `/api/health/db` 仍 200**(正是"绿着死掉")。
 *
 * 修法: 从**本模块自身所在目录**(`import.meta.url` ⇒ .next/server/... )**逐级向上**找
 *   含 `scripts/lib/mind-db-open-gate.cjs` 的目录; 允许 `LIONS_REPO_ROOT` 显式覆盖;
 *   cwd 只作为**最后的**候选(向后兼容从仓库根启动的脚本)。找不到 ⇒ **显式失败**并写状态
 *   (不再"静默 fail-closed" —— 静默与"判据异常"无法区分, 正是要避免的形态)。
 */
/**
 * 仓库根锚点解析(纯函数, 可对任意"模块目录"复算 —— 便于对**构建产物**做验证)。
 *
 * 优先级(从最确定到最不确定; 任一命中即返回该目录, 并要求该目录下**确实存在**
 * `scripts/lib/mind-db-open-gate.cjs`):
 *   ① `LIONS_REPO_ROOT` / `MIND_REPO_ROOT`(显式; 打包后路径稳定的**正解**, 建议发版时注入);
 *   ② **账本路径锚**: 从 `LIONS_MIND_DB`/`MIND_DB_PATH`(或其默认 `<cwd>/prisma/dev.db`)所在目录向上找
 *      —— 这个锚**不依赖打包布局**(本机形态: `<repo>/packages/apps/mind/prisma/dev.db` ⇒ 4 层到仓库根);
 *   ③ 从**模块自身目录**向上找(到文件系统根为止, 上限 64 层, 不再用 12 层这种"看似够"的魔数);
 *   ④ 从 `process.argv[1]` 所在目录向上(Next CLI 通常位于仓库内);
 *   ⑤ 从 `process.cwd()` 向上(兼容从仓库根启动)。
 *
 * ⚠️ 为什么要把上限从 12 提到 64 并走到根: 实测**打包后**的最深产物路径已达
 *   `packages/apps/mind/.next/server/app/api/v1/global-organizer/status/[taskId]/route.js`
 *   —— 从该目录到仓库根 **11 层**(12 层上限只差 1 层就会失效); Next 的动态段再嵌套一层就会挂。
 *   12 层这种"粗算够用"的魔数正是"打包后路径"这一类事故的温床。
 */
export function resolveRepoRootFrom(opts: {
  moduleDir?: string | null;
  dbPath?: string | null;
  argv1?: string | null;
  cwd?: string | null;
  env?: Record<string, string | undefined>;
}): { root: string | null; searched: string[]; via: string | null } {
  const env = opts.env || (process.env as Record<string, string | undefined>);
  const GATE_REL = path.join("scripts", "lib", "mind-db-open-gate.cjs");
  const searched: string[] = [];
  const cands: { dir: string; via: string }[] = [];
  const push = (d: string | null | undefined, via: string) => {
    if (!d) return;
    const r = path.resolve(d);
    if (!cands.some((c) => c.dir === r)) cands.push({ dir: r, via });
  };
  const up = (startDir: string | null | undefined, via: string, limit = 64) => {
    if (!startDir) return;
    let d = path.resolve(startDir);
    push(d, via);
    for (let i = 0; i < limit; i++) {
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
      push(d, via);
    }
  };

  // ① 显式 env
  push(env.LIONS_REPO_ROOT, "env:LIONS_REPO_ROOT");
  push(env.MIND_REPO_ROOT, "env:MIND_REPO_ROOT");
  // ② 账本路径锚(不依赖打包布局)
  const db =
    env.LIONS_MIND_DB ||
    env.MIND_DB_PATH ||
    (opts.dbPath || null) ||
    null;
  if (db) up(path.dirname(path.resolve(db)), "db-path");
  else if (opts.cwd) push(path.join(path.resolve(opts.cwd), "prisma"), "cwd-default-db");
  // ③ 模块自身目录
  up(opts.moduleDir || null, "module-dir");
  // ④ argv[1]
  up(opts.argv1 ? path.dirname(path.resolve(opts.argv1)) : null, "argv1");
  // ⑤ cwd
  up(opts.cwd || null, "cwd");

  for (const c of cands) {
    if (searched.includes(c.dir)) continue;
    searched.push(c.dir);
    try {
      if (fs.existsSync(path.join(c.dir, GATE_REL))) return { root: c.dir, searched, via: c.via };
    } catch { /* 继续 */ }
  }
  return { root: null, searched, via: null };
}

function moduleDirOfThisFile(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

function resolveRepoRoot(): { root: string | null; searched: string[]; via: string | null } {
  return resolveRepoRootFrom({
    moduleDir: moduleDirOfThisFile(),
    argv1: process.argv && process.argv[1],
    cwd: process.cwd(),
  });
}

const REPO_RESOLVED = resolveRepoRoot();
/** 判据/动作的权威实现(仓库内 CJS; 供 CLI 与 mind 共用同一份)。null = 锚不到仓库根(显式失败)。 */
const REPO = REPO_RESOLVED.root;
/** 解析所用的锚(env:… / db-path / module-dir / argv1 / cwd) —— 失败时报出来便于定位 */
const REPO_VIA = REPO_RESOLVED.via;
const GATE_CJS = REPO ? path.join(REPO, "scripts", "lib", "mind-db-open-gate.cjs") : null;

export type LedgerOpenVerdict = "pass" | "rebuilt" | "refuse";

export interface LedgerOpenResult {
  ok: boolean;
  verdict: LedgerOpenVerdict | string;
  cached?: boolean;
  reason: string;
  blockers?: string[];
  /** 仅当锚不到仓库根时给出(便于定位"门为什么不可用") */
  searchedRepoRoots?: string[];
  /** 判据 CLI 的 stderr 逐字留痕(可诊断; 今天"闸门日志窗口内 0 条"就是因为它自己没加载成功) */
  gateStderr?: string;
  /** 判据 CLI 的完整命令行(便于复算) */
  gateCmd?: string;
  elapsedMs?: number;
  checkedFrames?: number;
  mismatchCount?: number;
  mismatches?: Array<{ frame: number; aPgno: number; framePgno: number }>;
}

export class LedgerGenerationRefusedError extends Error {
  constructor(public readonly detail: LedgerOpenResult) {
    super(
      "[ledger-open-gate] 账本**开库世代自检未通过**, 已拒绝写入(fail-closed; 读操作不受影响)。\n" +
        "  判据: 全量核对 `-shm.aPgno[i]` vs 第 i 帧帧头 `pgno`(唯一决定性判据)。\n" +
        "  结论: " +
        (detail.reason || "(无)") +
        (detail.blockers && detail.blockers.length ? "\n  阻塞: " + detail.blockers.join(" ; ") : "") +
        (detail.mismatchCount
          ? "\n  错配 " + detail.mismatchCount + " 处, 例: " + JSON.stringify((detail.mismatches || []).slice(0, 3))
          : "") +
        "\n  复算: node scripts/lib/mind-db-open-gate.cjs --db=<库> --json\n" +
        "         node scripts/lib/wal-generation-identity.cjs --db=<库> --json\n" +
        "  机制: docs/platform-logic/mind-db-corruption-rootcause-and-nonrecurrence-2026-10-16.md §G.0",
    );
    this.name = "LedgerGenerationRefusedError";
  }
}

let checkPromise: Promise<LedgerOpenResult> | null = null;
let lastResult: LedgerOpenResult | null = null;

/** 本次运行实际使用的库路径(供"写前复核"用同一个目标) */
let activeDbPath: string | null = null;
/** 判据 CLI 路径(允许夹具覆盖: LIONS_LEDGER_OPEN_GATE_CLI) */
const gateCliPath = () => process.env.LIONS_LEDGER_OPEN_GATE_CLI || GATE_CJS;

/* ======================================================================================
 * ★ "用出页号之前"的复核(2026-10-16 第 4 件根治项: **开库时判一次不充分**)
 *
 * 今天咬了三次: ① 18:04 原始错配(进程在"当时 pass"的世代开库; WAL restart 造新世代后门不复核);
 * ② 冻结态起服务(幸而被拒); ③ release 后进程缓存 `refuse(frozen)` ⇒ 服务只读。
 * "把错页号用出去"的**唯一动作是 checkpoint**, 而 checkpoint 可能在任何一次提交里由 SQLite 触发
 * ⇒ 只在开库判一次 = 给"开库后世界变了"整段时间不设防。三层判据(成本从低到高):
 *   ① **世代 token 变化 ⇒ 立即全量复核**: 廉价 token = `-wal` inode + `-wal` 头 salt + `-shm` inode;
 *      **刻意不含 mxFrame**(它每次提交都变, 含进去会退化成"每笔写都全量复核")。每笔写前 1 次 stat
 *      + 2 次 32/120B pread ⇒ 微秒级(实测 p50/p95 见 REPORT §1.4i)。
 *   ② **有界周期性复核**: 距上次全量复核 > RECHECK_MS, 或 `mxFrame` 增长 > RECHECK_FRAMES ⇒ 全量复核。
 *      这层兜住 token **看不见**的形态: "同 inode 就地改 aPgno"(本次 P0 的 aPgno[52]=105378 就是它)。
 *      默认 RECHECK_FRAMES=512 < SQLite 默认 autocheckpoint 阈值(1000 帧) ⇒ **复核节奏快过一次
 *      autocheckpoint**, 因此"坏世代最多写出去 ~512 帧"就会被复核撞上。
 *   ③ **命中错配先复采确认再拒**(间隔 CONFIRM_DELAY_MS; 连续两次都非 ok 才拒) ⇒ 不把瞬时读抖动
 *      当损坏(今天的教训: 误拒 = 绿着死掉)。
 * ==================================================================================== */
const RECHECK_MS = Number(process.env.LIONS_LEDGER_OPEN_GATE_RECHECK_MS || 60000);
const RECHECK_FRAMES = Number(process.env.LIONS_LEDGER_OPEN_GATE_RECHECK_FRAMES || 512);
const CONFIRM_DELAY_MS = Number(process.env.LIONS_LEDGER_OPEN_GATE_CONFIRM_MS || 200);

let lastVerified: { key: string; mxFrame: number; at: number } | null = null;
/** 诊断计数(可被端点/日志读): 各触发路径命中次数 */
export const recheckStats = { writesChecked: 0, fastPath: 0, noExposure: 0, fullByToken: 0, fullByAge: 0, fullByFrames: 0, refused: 0, confirmedRefusals: 0, jitterIgnored: 0 };

function statIno(p: string): number | null {
  try { return fs.statSync(p).ino; } catch { return null; }
}

/**
 * 廉价世代 token(微秒级): `-wal` inode + `-wal` 头 salt(偏移 16/20, 大端) + `-shm` inode。
 * 返回 null = "没有待回写的 WAL" ⇒ 没有"错页号可被用出去"的暴露面(与本层判据同口径)。
 */
export function cheapGenerationToken(dbPath: string): { key: string; mxFrame: number; walIno: number | null; shmIno: number | null; salt: string | null } | null {
  const walIno = statIno(dbPath + "-wal");
  if (walIno === null) return null;
  let salt: string | null = null;
  try {
    const f = fs.openSync(dbPath + "-wal", "r");
    try {
      const b = Buffer.alloc(32);
      const n = fs.readSync(f, b, 0, 32, 0);
      if (n >= 24) salt = b.readUInt32BE(16).toString(16) + "-" + b.readUInt32BE(20).toString(16);
    } finally { fs.closeSync(f); }
  } catch { salt = null; }
  const shmIno = statIno(dbPath + "-shm");
  let mxFrame = 0;
  try {
    const f = fs.openSync(dbPath + "-shm", "r");
    try {
      const b = Buffer.alloc(120);
      const n = fs.readSync(f, b, 0, 120, 0);
      if (n >= 24) mxFrame = b.readUInt32LE(16);
    } finally { fs.closeSync(f); }
  } catch { /* 无 -shm */ }
  return { key: [walIno, salt, shmIno].join("|"), mxFrame, walIno, shmIno, salt };
}

/** 跑一次判据 CLI(共享实现; 含 ③ 复采确认)。 */
export function runGateCli(dbPath: string, why: string): Promise<LedgerOpenResult> {
  const cli = gateCliPath();
  if (!cli) {
    return Promise.resolve({ ok: false, verdict: "refuse", reason: "repo-root-not-found: 判据实现路径未知", blockers: ["repo-root-not-found"], searchedRepoRoots: REPO_RESOLVED.searched });
  }
  const args = [cli, "--db=" + dbPath, "--json", "--why=" + why];
  if (process.env.MIND_DB_OPEN_GATE_REBUILD === "1") args.push("--rebuild");
  if (process.env.MIND_DB_OPEN_GATE_ALLOW_FROZEN === "1") args.push("--allow-frozen", "--reason=" + (process.env.MIND_DB_OPEN_GATE_REASON || "env"));
  const once = () => new Promise<LedgerOpenResult>((resolve) => {
    execFile(
      process.execPath,
      args,
      { timeout: Number(process.env.LIONS_LEDGER_OPEN_GATE_TIMEOUT_MS || 120000), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const raw = String(stdout || "");
        const cmd = process.execPath + " " + args.join(" ");
        let r: any = null;
        const i = raw.indexOf("{");
        const j = raw.lastIndexOf("}");
        if (i >= 0 && j > i) { try { r = JSON.parse(raw.slice(i, j + 1)); } catch { r = null; } }
        if (!r) {
          resolve({ ok: false, verdict: "refuse", reason: "gate-cli-no-verdict: 判据 CLI 未返回可解析结论(fail-closed)。exit=" + String((err as any)?.code ?? "-") + "; stderr=" + String(stderr || "").trim().slice(0, 800) + "; stdout=" + raw.trim().slice(0, 400), blockers: ["gate-cli-no-verdict"], gateStderr: String(stderr || "").trim().slice(0, 4000), gateCmd: cmd });
          return;
        }
        resolve({ ok: !!r.ok, verdict: r.verdict, cached: r.cached, reason: r.reason, blockers: r.blockers, elapsedMs: r.elapsedMs, checkedFrames: r.analysis ? r.analysis.checkedFrames : undefined, mismatchCount: r.analysis ? r.analysis.mismatchCount : undefined, mismatches: r.analysis ? r.analysis.mismatches : undefined, gateStderr: String(stderr || "").trim().slice(0, 4000) || undefined, gateCmd: cmd });
      },
    );
  });
  return once().then(async (first) => {
    if (first.ok) return first;
    const isMismatch = /apgno-frame-mismatch|shm-salt-mismatch|wal-truncated|pgno-beyond/.test(String(first.reason || "") + JSON.stringify(first.blockers || []));
    if (!isMismatch) return first;
    await new Promise((res) => setTimeout(res, CONFIRM_DELAY_MS));
    const second = await once();
    if (second.ok) {
      recheckStats.jitterIgnored++;
      return { ...second, reason: "confirm-resample-cleared: 首次命中错配但 " + CONFIRM_DELAY_MS + "ms 后复采为 pass ⇒ 判瞬时读抖动, 不拒写(原始: " + String(first.reason || "").slice(0, 160) + ")" };
    }
    recheckStats.confirmedRefusals++;
    return { ...first, reason: "confirmed-mismatch(连续两次): " + String(first.reason || "") };
  });
}


/** 需要拒写的操作名(与 prisma.ts 的冻结层同一套命名)。 */
const WRITE_OPS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "executeRaw",
  "executeRawUnsafe",
  "runCommandRaw",
]);

export function isWriteOperation(op: string): boolean {
  return WRITE_OPS.has(op);
}

/**
 * 后台启动一次开库世代自检(幂等; 只跑一次)。
 * 不 await —— 进程启动与读操作不被阻塞; 写操作由 `awaitLedgerOpenCheck()` 兜底。
 */
export function startLedgerOpenCheck(dbPath?: string, why?: string): Promise<LedgerOpenResult> | null {
  // ★ 若本次请求的库与已判定的库**不是同一个**, 必须重判(而不是复用缓存的结论):
  //   实测踩到(夹具): 同一进程先判 A 库再判 B 库时, 复用了 A 的结论 ⇒ B 库的错配被完全遗漏,
  //   而且"写前复核"还会一直盯着 A 的 token。生产上同类场景: 一个进程先后打开 mind 库与 session 库。
  const want = dbPath ? path.resolve(dbPath) : null;
  if (checkPromise && want && activeDbPath && want !== activeDbPath) {
    console.error("[ledger-open-gate] 目标库变化(" + activeDbPath + " -> " + want + ") ⇒ 丢弃缓存结论, 重新做开库世代自检");
    checkPromise = null;
    lastVerified = null;
    activeDbPath = null;
  }
  if (checkPromise) return checkPromise;
  if (process.env.LIONS_LEDGER_OPEN_GATE === "0") {
    // 显式关闭(**只给夹具/离线工具**): 默认不设 ⇒ 门是开的。
    console.error("[ledger-open-gate] LIONS_LEDGER_OPEN_GATE=0 -> 开库世代自检已**显式关闭**(仅限夹具/离线工具)");
    checkPromise = Promise.resolve({ ok: true, verdict: "pass", reason: "LIONS_LEDGER_OPEN_GATE=0 显式关闭" });
    return checkPromise;
  }
  checkPromise = new Promise<LedgerOpenResult>((resolve) => {
    // 放到下一个 tick: 绝不在模块求值期阻塞(Prisma/Next 的启动路径都在这里)
    setImmediate(() => {
      try {
        if (!REPO || !GATE_CJS) {
          // ★ 锚点失败必须**显式**说清"找过哪些目录", 不许静默 fail-closed
          const out: LedgerOpenResult = {
            ok: false,
            verdict: "refuse",
            reason:
              "repo-root-not-found: 找不到含 `scripts/lib/mind-db-open-gate.cjs` 的仓库根(判据实现不可用); " +
              "已尝试目录(" + REPO_RESOLVED.searched.length + " 个): " + REPO_RESOLVED.searched.slice(0, 40).join(" , ") +
              " —— 可用 LIONS_REPO_ROOT 显式指定(发版注入最稳); 逃生: LIONS_LEDGER_OPEN_GATE=0",
            blockers: ["repo-root-not-found"],
            searchedRepoRoots: REPO_RESOLVED.searched,
          };
          lastResult = out;
          console.error("[ledger-open-gate] " + out.reason);
          resolve(out);
          return;
        }
        const db =
          dbPath ||
          process.env.LIONS_MIND_DB ||
          process.env.MIND_DB_PATH ||
          defaultDbPath();
        activeDbPath = db;
        // ★ 用 **child_process 跑判据 CLI**(不 require): webpack 会把运行期 `require(<绝对路径>)` 换成
        //   "任何参数都抛 MODULE_NOT_FOUND"的桩(产物 chunks/936.js 已坐实) ⇒ spawn/execFile 不受影响。
        //   判据共享在 runGateCli()(含"复采确认"); 开库这一次只是**第一层**, 之后每笔写还有 token/周期复核。
        runGateCli(db, why || "mind 开库(唯一写者)").then((out) => {
          lastResult = out;
          if (out.ok) {
            const t = cheapGenerationToken(db);
            if (t) lastVerified = { key: t.key, mxFrame: t.mxFrame, at: Date.now() };
          }
          if (!out.ok) {
            console.error("[ledger-open-gate] **拒写**: " + out.reason);
          } else {
            console.error("[ledger-open-gate] ok(" + out.verdict + ") 全量核对 " + (out.checkedFrames ?? "?") +
              " 帧, 错配 " + (out.mismatchCount ?? 0) + ", " +
              (out.elapsedMs ? out.elapsedMs.toFixed(1) : "?") + "ms");
          }
          resolve(out);
        }).catch((e) => {
          const out: LedgerOpenResult = { ok: false, verdict: "refuse", reason: "gate-run-failed: " + String((e as Error)?.message || e), blockers: ["gate-run-failed"] };
          lastResult = out;
          console.error("[ledger-open-gate] " + out.reason);
          resolve(out);
        });
      } catch (e) {
        // 判据自身异常 ⇒ fail-closed(拒写), 但**不崩进程**(读还要能用)
        const out: LedgerOpenResult = {
          ok: false,
          verdict: "refuse",
          reason: "开库世代自检自身异常(fail-closed): " + String((e as Error)?.message || e),
          blockers: ["gate-internal-error"],
        };
        lastResult = out;
        console.error("[ledger-open-gate] " + out.reason);
        resolve(out);
      }
    });
  });
  return checkPromise;
}

/**
 * 写操作放行前必须 await 这个(未启动则就地启动)。
 *
 * ★ 它做**两件事**(第 4 件根治项):
 *   1) 开库那一次的结果(第一层); 2) **"用出页号之前"的复核**(第二层):
 *      · 世代 token(去不掉 mxFrame 的廉价三元组)变化 ⇒ 立即全量复核(A1);
 *      · 距上次全量复核 > RECHECK_MS, 或 mxFrame 增长 > RECHECK_FRAMES ⇒ 全量复核(A2);
 *      · 全量复核命中错配时**先复采确认**才拒(A3, 在 runGateCli 里)。
 * 快路径只花"1 stat + 2 pread(32B/120B)"(微秒级, 实测见 REPORT §1.4i); 慢路径 = 跑一次判据 CLI(约 60-90ms,
 * 含 node 启动)。慢路径默认**每 60s 或每 512 帧**最多一次 ⇒ 对吞吐影响可忽略, 但把"坏世代被写出去"的
 * 上界压到"一次 autocheckpoint(默认 1000 帧)以内"。
 */
export async function awaitLedgerOpenCheck(op?: string): Promise<void> {
  // 2026-10-21 Phase 2: PG 下没有 -wal/-shm 文件级世代，账本开库自检不适用。
  if ((process.env.MIND_DB_DRIVER || "").toLowerCase() === "pg") return;
  const p = checkPromise || startLedgerOpenCheck();
  const r = await p;
  if (!r || !r.ok) {
    throw new LedgerGenerationRefusedError(r || { ok: false, verdict: "refuse", reason: "自检无结果" });
  }
  const db = activeDbPath || process.env.LIONS_MIND_DB || process.env.MIND_DB_PATH || defaultDbPath();
  recheckStats.writesChecked++;
  const t = cheapGenerationToken(db);
  if (!t) { recheckStats.noExposure++; return; } // 无 -wal ⇒ 无暴露面(与判据同口径)
  const now = Date.now();
  let why: string | null = null;
  if (!lastVerified) why = "recheck:no-baseline";
  else if (t.key !== lastVerified.key) { why = "recheck:token-changed"; recheckStats.fullByToken++; }
  else if (now - lastVerified.at > RECHECK_MS) { why = "recheck:age>" + RECHECK_MS + "ms"; recheckStats.fullByAge++; }
  else if (t.mxFrame - lastVerified.mxFrame > RECHECK_FRAMES) { why = "recheck:frames+" + (t.mxFrame - lastVerified.mxFrame); recheckStats.fullByFrames++; }
  if (!why) { recheckStats.fastPath++; return; }
  const rr = await runGateCli(db, (op ? op + " " : "") + "[" + why + "]");
  if (!rr.ok) {
    recheckStats.refused++;
    throw new LedgerGenerationRefusedError(rr);
  }
  lastVerified = { key: t.key, mxFrame: t.mxFrame, at: Date.now() };
}

/** 只读的诊断入口(测试/端点可用; 不改变行为)。 */
export function ledgerOpenCheckSnapshot(): LedgerOpenResult | null {
  return lastResult;
}

/** 默认库路径: 仓库根下的 mind 库优先(与 cwd 无关), 再退回 cwd(生产 cwd = app 目录)。 */
function defaultDbPath(): string {
  const cands: string[] = [];
  if (REPO) cands.push(path.join(REPO, "packages", "apps", "mind", "prisma", "dev.db"));
  cands.push(path.join(process.cwd(), "prisma", "dev.db"));
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* 继续 */ }
  }
  return cands[cands.length - 1];
}

export const __internals = {
  GATE_CJS,
  REPO,
  REPO_VIA,
  REPO_SEARCHED: REPO_RESOLVED.searched,
  WRITE_OPS,
  resolveRepoRoot,
  resolveRepoRootFrom,
  defaultDbPath,
  cheapGenerationToken,
  runGateCli,
  recheckStats,
  /** 仅测试用: 清掉进程内缓存(开库结论/已验世代/统计) */
  _resetForTest: () => { checkPromise = null; lastVerified = null; activeDbPath = null; for (const k of Object.keys(recheckStats) as (keyof typeof recheckStats)[]) (recheckStats as any)[k] = 0; },
  getLastVerified: () => lastVerified,
  getActiveDbPath: () => activeDbPath,
};
