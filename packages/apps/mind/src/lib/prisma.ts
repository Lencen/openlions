import { PrismaClient as PgClient } from "../../node_modules/.prisma/mind-client-pg";
import type { PrismaClient as SqliteClient } from "../../node_modules/.prisma/mind-client";
import fs from "fs";

// 2026-10-26 SQLite 退役(P3): 只有 PG client。没有 MIND_DATABASE_URL 就 fail-closed，
//   不再回退到 prisma/dev.db（回退会把"配置漏了"伪装成"平台正常"）。
const IS_PG_DRIVER = true;
// 2026-10-26 修（unblock 全仓 tsc）：只把运行时实现换成 PgClient，**对外类型仍按 SqliteClient 的形状**——
//   全仓有大量函数签名写成 PrismaClient<..., DefaultArgs>；若这里把 prisma 的静态类型换成 PgClient
//  （带 InternalArgs），会产生 50+ 处 "not assignable" 级联错误。这里显式断言回原类型，保持一行可回退。
const PrismaClient = PgClient as unknown as typeof SqliteClient;
type PrismaClientType = InstanceType<typeof SqliteClient>;
// 2026-10-11 round 73-B: SQLite 临时文件目录兜底已抽到**单一实现** src/lib/sqlite-tempdir.ts。
//   import 即执行(ES import 提升), 早于下面的 new PrismaClient(); 覆盖全 mind 应用唯一 Prisma 客户端。
// 2026-10-08 round 58(人类批准): 标题/名字合规的**单点保证**.
//   为什么放在这里: 平台有 28% 的新产物标题超长(Knowledge 33.9%/Practice 31.3%/Memory 17.3%/Skill 名 44.2%),
//   而写入路径有很多条(store 路径 / 各业务直写). 在**唯一 Prisma 客户端**上做一次归一, 覆盖全部写入,
//   不依赖每条路径自觉遵守 —— 这正是"格式从请求变成保证"的落点.
//   纯函数确定性(去模板前缀 + 保头保尾), 失败时**原样放行**(绝不因归一本身阻断写入).
// 2026-10-08 round 61: 写端 dedup(同义 Skill 防再生)的拦截器层**已废弃**——
//   原因: 拦截器只能跑非事务, 并发下两请求都过 findUnique 都进 步骤A→B, 仍撞 UNIQUE.
//   改用 API 端用 prisma.$transaction 做(API 路由 /api/v1/skill), 全原子.
//   拦截器只保留归一钩子, 不再尝试 dedup.
//   非 API 路径(直接 prisma.skill.create 调用,如飞轮提炼)暂**不受 dedup 保护**——
//   留 round 62+ 单独处理(把 API 端 dedup 逻辑抽到通用函数).
import { normalizeProductTitle, normalizeSkillName, TITLE_MAX, SKILL_NAME_MAX } from "@lions/product-contract";
// 2026-10-09 round 72-C: 显式说明 K/P/M 标题的归一函数(下面 TITLE_FIELDS 用 normalizeSkillName, **不**用 normalizeProductTitle):
//   normalizeProductTitle 会做"保头保尾压缩"插入省略号, 而人类口径「名称不能有省略」已经扩到 4 张表(C: 要管, 一起处理)。
//   normalizeSkillName 是**安全**版本: 只做净化(去模板前缀/去括号补充/去省略号), **不做有损截断**;
//   超长时原样返回(nameTooLong 标志, 等 round 71 B 的 LLM 批量回填收口)。
//   注意 normalizeProductTitle 仍被本文件保留为 import —— memory-expiry-sweep.cjs 等历史脚本可能用。
//   Knowledge/Practice/Memory 走 normalizeSkillName 是有意的复用, 不必为它们各写一份。

const globalForPrisma = globalThis as unknown as { prisma: SqliteClient };


/** 需要保证标题合规的表 -> 字段名、上限、以及**该表专用的归一函数** */
const TITLE_FIELDS: Record<string, { field: string; max: number; normalize: (v: unknown, max: number) => string | null }> = {
  // 2026-10-09 round 72-C: 4 张表全部走 normalizeSkillName(永不产省略号; 净化仍超长 -> 原样 + nameTooLong 标志)。
  //   人类口径"名称不能有省略"在 round 70 扩到 4 张表: K/P/M 标题 + Skill 名。normalizeProductTitle
  //   (会插省略号) 不再用于新写入; memory-expiry-sweep.cjs 等历史脚本仍可继续用 normalizeProductTitle,
  //   因为它们处理的是老数据(已带省略号), 不与本钩子冲突。
  Knowledge: { field: "title", max: TITLE_MAX, normalize: (v, m) => normalizeSkillName(v, { max: m }) },
  Practice: { field: "title", max: TITLE_MAX, normalize: (v, m) => normalizeSkillName(v, { max: m }) },
  Memory: { field: "title", max: TITLE_MAX, normalize: (v, m) => normalizeSkillName(v, { max: m }) },
  Skill: { field: "name", max: SKILL_NAME_MAX, normalize: (v, m) => normalizeSkillName(v, { max: m }) },
};

/** 就地把一条 data 的标题/名字归一为合规值(失败不动它) */
function normalizeWriteArgs(model: string, args: any): void {
  try {
    const spec = TITLE_FIELDS[model];
    if (!spec || !args || !args.data) return;
    const norm = (obj: any) => {
      if (obj && obj[spec.field] !== undefined) obj[spec.field] = spec.normalize(obj[spec.field], spec.max);
    };
    if (Array.isArray(args.data)) args.data.forEach(norm);
    else norm(args.data);
  } catch { /* 归一失败绝不阻断写入 */ }
}

// 2026-10-11 round 73-B: SQLite 临时文件目录兜底已抽到**单一实现** src/lib/sqlite-tempdir.ts
//   (原 73 版内联在此, 只覆盖 Prisma 路径; 73-B 实测 scripts/session-extract.ts 走 better-sqlite3
//    直连, 同根因(SQLITE_CANTOPEN)必红, 故抽成共享模块, 两个入口都 import)。
//   根因/修法/证据见该文件头注释; 本文件在唯一 PrismaClient 构造点之前生效。

// 2026-10-27 P0（商业化线批准）：**模块 import 不再解析 DSN、不再 throw**。
//   原因: `next build` 的 "collecting page data" 会 import 所有 route 模块 → 链式 import 到本文件 →
//   原实现在模块顶层构造 PrismaClient 时调 mindPgUrl() → 无 DB 的机器**直接 build 失败**，
//   连"这个页面运行期根本不需要数据"的情况也过不去。开源版 clean-room 就是死在这里。
//   改法（最小改动，不动 base→dialect→guarded→gated 这条链）：
//     · 缺失配置时**不抛**，用一个连不上的占位 DSN —— 构造 PrismaClient 不需要真连；
//     · 把原因记进 DB_CONFIG_ERROR，**首次真实查询会立刻失败**，由调用方转成可读错误；
//     · 绝不静默回退 SQLite（SQLite 已退役）。
let DB_CONFIG_ERROR: string | null = null;
export function getDbConfigError(): string | null { return DB_CONFIG_ERROR; }

function mindPgUrl(): string {
  if (process.env.MIND_DATABASE_URL) return process.env.MIND_DATABASE_URL;
  // 开源版不能硬编码 ~；优先 LIONS_HOME，其次 HOME，最后 /tmp（会读不到 -> fail-closed）。
  const home = process.env.LIONS_HOME || process.env.HOME || "/tmp";
  const file = process.env.LIONS_PG_PASSWORD_FILE || home + "/run/pg-password";
  try {
    const pw = fs.readFileSync(file, "utf8").trim();
    if (pw) return "postgresql://lions:" + encodeURIComponent(pw) + "@127.0.0.1:5432/lions_mind";
  } catch { /* fallthrough */ }
  DB_CONFIG_ERROR = "MIND_DATABASE_URL 未设置且 " + file + " 不可读：SQLite 已退役，PG 是唯一数据源";
  // 占位 DSN：只用于构造（不会连接）。任何真实查询会立刻 connection refused，
  // 调用方/健康检查据 DB_CONFIG_ERROR 给出可读原因。
  // 占位 DSN 不能带 user:password（开源导出敏感扫描会命中）；端口 1 必连不上，首次查询 fail-closed。
  return "postgresql://127.0.0.1:1/__no_db__?connect_timeout=1";
}

const base = globalForPrisma.prisma || new PrismaClient({
  // 2026-10-15 根因修复(第二段): **把连接池钉成 1 条连接**。
  //   为什么这是必需的: 原代码 `datasourceUrl: file:${dbPath}` 会**整体覆盖** .env 里的
  //   `DATABASE_URL=file:./dev.db?connection_limit=1&socket_timeout=30`, 于是 2026-09-17 事故 RCA
  //   的核心修复("单连接 -> 不再产生池换代导致的 deleted-WAL 世代漂移")**从未生效**。
  //   实测(2026-10-15 恢复窗口): mind 单进程持有 **4 个 dev.db fd + 5 个已删除 -wal/-shm fd**
  //   —— 同一进程同时握着多个 WAL 世代 = "Rowid N out of order / 页被两个 b-tree 共享"的直接成因。
  //   池每关闭一次最后连接, SQLite 就会 checkpoint 并 unlink -wal; 池再开新连接就产生新世代,
  //   旧连接当场孤儿化。connection_limit=1 让只有一条长驻连接, 从机制上消灭世代漂移。
  //   判据(可复算): `ls -l /proc/<mind-pid>/fd | grep dev.db` 不应出现任何 `(deleted)`。
  // Phase 2: PG 走 MIND_DATABASE_URL；SQLite 保持单连接。
  datasourceUrl: mindPgUrl(),
} as any);

// ── 2026-10-17 第 4 批: **owner 的换代阈值**(唯一换代方 = 本连接) ──────────────────────────
//   为什么必须写在这里: `MIND_WAL_AUTOCHECKPOINT` 只对经 helper(`server/lib/open-mind-db`)打开的
//   `owner` role 生效, 而 **Prisma 主连接不走 helper** ⇒ 若只改环境变量, 阈值**不会**变
//   (我此前"第 4 批只改环境变量"的说法有误, 在此更正)。
//   默认 1000 = SQLite 默认 = 收口前行为 ⇒ **不设该环境变量时零行为变化**;
//   激活 = drop-in 里加 `Environment=MIND_WAL_AUTOCHECKPOINT=4000`; 回退 = 删掉那一行(再重启)。
const OWNER_AUTOCHECKPOINT = Number(process.env.MIND_WAL_AUTOCHECKPOINT ?? "1000");
if (!IS_PG_DRIVER && Number.isFinite(OWNER_AUTOCHECKPOINT) && OWNER_AUTOCHECKPOINT > 0) {
  try {
    // ⚠️ 2026-10-17 实测: `PRAGMA wal_autocheckpoint = N` **会返回一行** ⇒ `$executeRawUnsafe` 会报
    //   "Execute returned results, which is not allowed in SQLite"(构建期 page-data 阶段就复现了);
    //   必须用 `$queryRawUnsafe`(允许返回行)。
    void (base as any).$queryRawUnsafe("PRAGMA wal_autocheckpoint = " + Math.floor(OWNER_AUTOCHECKPOINT) + ";")
      .then(() => console.error("[owner-wal-autocheckpoint] 已设置 = " + Math.floor(OWNER_AUTOCHECKPOINT) + " (第 4 批; 1000=默认)"))
      .catch((e: any) => console.error("[owner-wal-autocheckpoint] 设置失败: " + (e?.message || String(e))));
  } catch { /* 不阻断启动 */ }
}

// 2026-10-21 Phase 2: **常开**方言适配层（SQLite 下 no-op；PG 下 raw SQL 先适配再执行）。
const dialect = base.$extends({
  query: {
    $allOperations({ args, query }: any) { convertDates(args); return query(args); },
    async $queryRawUnsafe({ args, query }: any) { return query(adaptUnsafeArgs(args)); },
    async $executeRawUnsafe({ args, query }: any) { return query(adaptUnsafeArgs(args)); },
    async $queryRaw({ args, query }: any) { return query(adaptTaggedArgs(args)); },
    async $executeRaw({ args, query }: any) { return query(adaptTaggedArgs(args)); },
  },
});

const extended = dialect.$extends({
  query: {
    // 注意(2026-10-09 实测确认): 本扩展只拦 create/createMany/upsert —— **不拦 update**。
    //   所以"改名"类操作(如 round 70 的技能重命名)不会被这里归一, 必须由调用方自己保证合规。
    $allModels: {
      async create({ model, args, query }: any) {
        normalizeWriteArgs(model, args);
        return query(args);
      },
      async createMany({ model, args, query }: any) {
        normalizeWriteArgs(model, args);
        return query(args);
      },
      async upsert({ model, args, query }: any) {
        if (args) { normalizeWriteArgs(model, { data: args.create }); normalizeWriteArgs(model, { data: args.update }); }
        return query(args);
      },
    },
  },
});

// ── 2026-10-16 "检测即冻结": 账本写保护 ─────────────────────────────────────────
// 背景(见 docs/platform-logic 的根治文档): 10-16 的 8 小时损坏扩散, 根因之一是"已检出损坏却继续带病写"。
// 机制: 巡检(scripts/guard-db-integrity.sh)一旦检出损坏, 会调用 scripts/mind-db-freeze.sh engage:
//   ① **立刻停掉写者**(immediate 禁写, 不依赖本文件是否已重新构建);
//   ② 给 lions-mind 装 systemd drop-in `Environment=LIONS_DB_WRITE_FROZEN=1` —— 本文件就是它的消费点:
//      冻结期内任何**写操作**在**单一 Prisma 客户端**上被明确拒绝(错误信息写清怎么解除), 读操作不受影响。
// 为什么放在这里: 本文件是全 mind 应用唯一的 PrismaClient 构造点(既有"标题归一"钩子也挂在这里)。
// 为什么还要 query_only: 纵深防御 —— 模型级中间件挡不住 `$executeRawUnsafe` 之类的裸 SQL 写,
//   SQLite 连接级的 `PRAGMA query_only=ON` 能兜住(失败只记录, 不阻断进程启动)。
// 边界(诚实): ① 本拦截只覆盖经过 Prisma 客户端的写入; 直连 better-sqlite3 的写者不在内(那些是短命脚本,
//   由巡检的"持有者归零"闸门与维护窗口管); ② 环境变量由 systemd 注入, 需 **重新构建 + 重启** 才生效
//   (在此之前"禁写"由 ① 的停写者保证); ③ 本机制**可逆**: 解除见 `scripts/mind-db-freeze.sh release`
//   (会移除 drop-in 并要求"全量审计不早于最近一次损坏 + WAL 孤儿检查干净"两条证据)。
const LEDGER_FROZEN = process.env.LIONS_DB_WRITE_FROZEN === "1";
/** Prisma 里会产生写入的操作名(读操作一律放行) */
const LEDGER_WRITE_OPS = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert",
  "delete", "deleteMany", "executeRaw", "executeRawUnsafe", "runCommandRaw",
]);
class LedgerWriteFrozenError extends Error {
  constructor(operation: string) {
    super("[ledger-frozen] 账本处于**冻结(只读)**状态: 检测到数据库损坏后平台已禁止写入, 本次 " +
      operation + " 被拒绝(读操作正常)。解除: 走离线恢复(冻结写者 -> holders=0 -> 从最近通过 " +
      "integrity_check(1000000) 的备份恢复)后执行 `bash scripts/mind-db-freeze.sh release`; 详见 " +
      "docs/platform-logic/mind-db-wal-lifecycle-root-cause-2026-10-16.md");
    this.name = "LedgerWriteFrozenError";
  }
}
/**
 * 2026-10-16（真洞修复，实测确认）：**`$allModels.$allOperations` 不覆盖顶层 raw 操作**。
 *   夹具：`$extends({ query: { $allModels: { $allOperations } } })` 上执行
 *   `ext.$executeRawUnsafe("UPDATE …")` ⇒ 钩子**一次都没收到**（只收到 client 级钩子）。
 *   而 mind 里有 `prisma.$executeRawUnsafe("UPDATE Memory/Knowledge/Practice …")`
 *   （`context-seed.ts`、`execute-improving-task.ts`、`api/v1/flywheel/tasks/submit/route.ts` 等）
 *   ⇒ 不加这层 = **冻结/世代闸门都不是完整写闸门**，而"冻结 = 停写"是今天所有工作的支点。
 * 修法：补 **client 级 raw 钩子**（Prisma `$extends` 支持）。
 *   · `$executeRaw*` = 必然写 ⇒ 冻结/闸门一律拦；
 *   · `$queryRaw*` 名义是读（平台里大量 `$queryRawUnsafe("SELECT …")`）⇒ **只拦"看着像写"的 SQL**，
 *     这样既堵住 `$queryRawUnsafe("UPDATE …")` 这个写路径，又保住"冻结期读操作不受影响"这条承诺。
 */
function looksLikeWriteSql(sql: unknown): boolean {
  if (typeof sql !== "string") return false;
  const s = sql.trim().replace(/^(\/\*[\s\S]*?\*\/|--[^\n]*\n|\s)+/g, "").toUpperCase();
  return /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX|ATTACH|DETACH|PRAGMA\s+(?!.*\b(read|query_only)\b))/.test(s);
}

/** client 级 raw 钩子（冻结层用）：执行类一律拦；查询类只拦"看着像写"的。 */
const rawGuardsFrozen = {
  async $executeRaw({ args, query }: any) { throw new LedgerWriteFrozenError("$executeRaw"); },
  async $executeRawUnsafe({ args, query }: any) { throw new LedgerWriteFrozenError("$executeRawUnsafe"); },
  async $queryRaw({ args, query }: any) {
    if (looksLikeWriteSql(Array.isArray(args) ? args[0] : args)) throw new LedgerWriteFrozenError("$queryRaw(写语句)");
    return query(args);
  },
  async $queryRawUnsafe({ args, query }: any) {
    const sql = Array.isArray(args) ? args[0] : args;
    if (looksLikeWriteSql(sql)) throw new LedgerWriteFrozenError("$queryRawUnsafe(写语句)");
    return query(args);
  },
};

const guarded = LEDGER_FROZEN
  ? extended.$extends({
      query: {
        $allModels: {
          // 每一个模型操作都过这里; 写操作直接抛错(消息明确), 读操作原样执行。
          async $allOperations({ model, operation, args, query }: any) {
            if (LEDGER_WRITE_OPS.has(operation)) {
              throw new LedgerWriteFrozenError((model ? model + "." : "") + operation);
            }
            return query(args);
          },
        },
        // ★ 顶层 raw 写(实测: 模型级钩子看不见它们)
        ...rawGuardsFrozen,
      },
    })
  : extended;


// ── 2026-10-16 "开库即校验世代": 账本写前的**最后一道**世代自检 ─────────────────────
// 背景(见 docs/platform-logic/mind-db-corruption-rootcause-and-nonrecurrence-2026-10-16.md §G.0/G.1):
//   三次损坏的机制是"同一主库被多个 WAL 世代 checkpoint" —— checkpoint 的**页号只来自 -shm.aPgno**、
//   页内容来自 WAL 帧, release 构建里没有第二道防线 ⇒ 错配即以错页号写入。
//   判据(唯一决定性的, 全量禁抽样): aPgno[i] == 第 i 帧帧头 pgno。16:51 现场 993 帧里只有 1 处
//   (frame 641: aPgno=79074 而帧头=113), 128 抽样会漏掉它 —— 所以本层默认全量。
// 为什么放在这里: 本文件是**全 mind 应用唯一的 PrismaClient 构造点**(标题归一、检测即冻结也在这),
//   把判据挂在同一个落点, 覆盖全部经核心服务的写入, 不另造一套入口。
// 行为: 模块加载即**后台**跑一次(不阻塞启动); 每个**写操作**在放行前 await 它 —— 不通过就**抛错拒写**
//   (fail-closed), 读操作完全不受影响。判据/重建动作的权威实现在
//   scripts/lib/mind-db-open-gate.cjs(薄接线见 src/lib/ledger-open-check.ts)。
// 生效条件: 需 `next build`(构建产物才含本模块); 在此之前行为不变 —— 不重启服务就无法生效。
import { startLedgerOpenCheck, isWriteOperation, awaitLedgerOpenCheck } from "./ledger-open-check";
import { adaptSql, adaptTaggedSql, isDateColumn, isAdaptedSql, stripAdaptedMark } from "../server/lib/sql-dialect";

// 2026-10-21 Phase 2: ORM 的 DateTime 参数在 SQLite 常传毫秒数；PG 需要 Date。
function convertDates(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) { for (const x of obj) convertDates(x); return obj; }
  for (const k of Object.keys(obj)) {
    const v = (obj as any)[k];
    if (isDateColumn(k)) {
      if (typeof v === "number" && v >= 1e11) (obj as any)[k] = new Date(v);
      else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) { const d = new Date(v); if (!isNaN(d.getTime())) (obj as any)[k] = d; }
      else if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const op of Object.keys(v)) {
          const ov = v[op];
          if (typeof ov === "number" && ov >= 1e11) v[op] = new Date(ov);
          else if (Array.isArray(ov)) v[op] = ov.map((x: any) => (typeof x === "number" && x >= 1e11 ? new Date(x) : x));
        }
      }
    } else if (v && typeof v === "object") convertDates(v);
  }
  return obj;
}

// 2026-10-21 Phase 2: raw SQL 在 PG 模式下做方言适配（? -> $n；未引号表列名 -> 带引号）。
function adaptDateParam(v: any, toMs: boolean) {
  // 2026-10-27（商业化线 P0 + 我这边 submit 500 同根因）：
  //   sql-dialect 把日期列的比较/写入重写成 `to_timestamp($n::double precision / 1000.0)`，
  //   也就是**期望 $n 是毫秒整数**。而调用方常直接传 JS `Date`，PG 就会报
  //     ERROR 42846: cannot cast type timestamp with time zone to double precision
  //   异常又常被 catch 吞掉 → 指标静默为 0（goal-gap 一类）、或提交 500（submit 一类）。
  //   这里在 unsafe 路径把 Date 归一成毫秒。**只在该语句确实含 to_timestamp( 时转**：
  //   没有重写的语句（无日期列）保持原样，避免把 Date 误转成数字造成反向类型错。
  if (toMs && v instanceof Date) return v.getTime();
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v)) {
    // 字符串日期仍归一成 Date：不带 to_timestamp 的语句需要 Date；
    // 带 to_timestamp 的语句用 .getTime() 取值（下面统一处理）
    const d = new Date(v);
    if (!isNaN(d.getTime())) return toMs ? d.getTime() : d;
  }
  return v;
}
/** 幂等适配：已带 ADAPTED_SQL_MARK 的 SQL 只剥标记，不再二次规范化（2026-10-23，evidence 事故） */
function adaptUnsafeOnce(sql: string): string {
  // 注意：**不要剥离标记** —— 剥了标记，下游那层又会把它当"未适配"重新规范化（实测仍报 Evidence）。
  //   标记本身是 SQL 注释，PG 直接忽略，所以可以一路带到最终语句。
  return isAdaptedSql(sql) ? sql : adaptSql(sql);
}
function adaptUnsafeArgs(args: any) {
  if (Array.isArray(args) && typeof args[0] === "string") {
    args[0] = adaptUnsafeOnce(String(args[0]));
    // 该语句被方言层重写过日期列 → 参数按毫秒传（to_timestamp 期望 double precision）
    const toMs = /to_timestamp\s*\(/.test(String(args[0]));
    for (let i = 1; i < args.length; i++) args[i] = adaptDateParam(args[i], toMs);
  }
  return args;
}
function adaptTaggedArgs(args: any) {
  if (Array.isArray(args) && Array.isArray(args[0])) {
    const strings = args[0] as any;
    const mapped = strings.map((s: string) => adaptTaggedSql(s));
    if (strings.raw) (mapped as any).raw = strings.raw.map((s: string) => adaptTaggedSql(s));
    args[0] = mapped;
  }
  return args;
}
// 冻结态下**不挂**本层: 冻结层(LedgerWriteFrozenError)已经是权威拒写与权威错误信息,
//   两层都挂只会让"为什么被拒"变成两套说法; 且冻结期没必要再跑世代自检。
// 2026-10-26 SQLite 退役(P3): WAL 世代自检是 SQLite 专有机制，PG 下不再启用。
const OPEN_GATE_ON = false;

const gated = OPEN_GATE_ON
  ? guarded.$extends({
      query: {
        $allModels: {
          // 只拦写操作: 读操作(占绝大多数)完全不受影响, 也不承担任何额外延迟。
          async $allOperations({ model, operation, args, query }: any) {
            if (isWriteOperation(operation)) {
              await awaitLedgerOpenCheck((model ? model + "." : "") + operation);
            }
            return query(args);
          },
        },
        // ★ 顶层 raw 写(与冻结层同一个真洞): 执行类一律过闸门; 查询类只拦"看着像写"的。
        async $executeRaw({ args, query }: any) { await awaitLedgerOpenCheck("$executeRaw"); return query(adaptTaggedArgs(args)); },
        async $executeRawUnsafe({ args, query }: any) { await awaitLedgerOpenCheck("$executeRawUnsafe"); return query(adaptUnsafeArgs(args)); },
        async $queryRaw({ args, query }: any) {
          const a2 = adaptTaggedArgs(args);
          if (looksLikeWriteSql(Array.isArray(a2) ? a2[0] : a2)) await awaitLedgerOpenCheck("$queryRaw(写语句)");
          return query(a2);
        },
        async $queryRawUnsafe({ args, query }: any) {
          const a2 = adaptUnsafeArgs(args);
          const sql = Array.isArray(a2) ? a2[0] : a2;
          if (looksLikeWriteSql(sql)) await awaitLedgerOpenCheck("$queryRawUnsafe(写语句)");
          return query(a2);
        },
      },
    })
  : guarded;

// 刻意保持对外类型为 PrismaClient(扩展客户端是方法超集, 强制转换避免全仓类型级联改动);
// 运行时行为包含上面的标题归一钩子 + (冻结期)写入拒绝 + (开库)世代自检.
// 2026-10-21 Phase 2: 用 Proxy 包一层导出，确保 raw SQL 一定经过方言适配
//   （Prisma 5 的 client 是 Proxy，直接赋值 $queryRawUnsafe 不生效）。
function adaptTaggedStrings(strings: any) {
  try {
    const mapped = Array.from(strings as any).map((s: any) => adaptTaggedSql(String(s)));
    if ((strings as any).raw) (mapped as any).raw = Array.from((strings as any).raw).map((s: any) => adaptTaggedSql(String(s)));
    return mapped;
  } catch { return strings; }
}
export const prisma = new Proxy(gated as any, {
  get(target, prop, receiver) {
    if (prop === "$queryRawUnsafe") return (sql: string, ...p: any[]) => target.$queryRawUnsafe(adaptUnsafeOnce(String(sql)), ...p);
    if (prop === "$executeRawUnsafe") return (sql: string, ...p: any[]) => target.$executeRawUnsafe(adaptUnsafeOnce(String(sql)), ...p);
    if (prop === "$queryRaw") return (strings: any, ...v: any[]) => target.$queryRaw(adaptTaggedStrings(strings), ...v.map((x) => adaptDateParam(x, false)));
    if (prop === "$executeRaw") return (strings: any, ...v: any[]) => target.$executeRaw(adaptTaggedStrings(strings), ...v.map((x) => adaptDateParam(x, false)));
    return Reflect.get(target, prop, receiver);
  },
}) as unknown as PrismaClientType;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma as unknown as SqliteClient;
