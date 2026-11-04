/**
 * finding-closure-store.ts — finding 层「已裁决结单」的持久登记与跨重算重放
 *   (2026-09-15 机制修复: 由待办升级任务 cmu25rlba089oki4aj78i5v3n / finding f-001 Pipeline stale-memory)
 *
 * 根因(实测, 非推测):
 *   FlywheelReflection.structuredFindings 每次反思都被整体重算(reflect.ts 的 buildStructuredFindings +
 *   saveReflectionResult upsert), 而 buildStructuredFindings 只从本轮 LLM 原始输出重建 finding, **不携带**
 *   上一轮的结单元数据(status=RESOLVED / closureReason / resolutionNote / evidenceRef)。因此任何写进该 JSON
 *   的「已结单」标记, 都会在下一次重算里丢失:
 *     - 2026-09-14 决策落地(scripts/land-f001-v10-stale-memory-supersede.cjs)把 f-001(CONFLICT/MARK_REVIEW,
 *       Memory[mt57s0] 冲突) 置为 RESOLVED(FIX_DATA_EXECUTED), 探针当时 8/8;
 *     - 2026-09-14T13:45:03Z 一次重反思把该标记冲掉, 同一条 mt57s0 冲突以 f-001 CONFLICT/MERGE_CONFLICT、
 *       f-003 CONFLICT/FIX_DATA 重现并再次派单 —— 探针 C4 由 PASS 变 FAIL(7/8)。
 *   数据层修复(Memory.supersededBy / 新 Memory / 新 Reflection)是持久的, 只有 finding 层结单标记不持久。
 *   这不是某一条 finding 的问题: 所有经「决策/裁决」结单的 finding 都同样会被重算抹掉 -> 冲突反复派单。
 *
 * 机制(治本, 不靠一次性特判):
 *   FindingClosure 登记表, 键 = (theme, subjectType, subjectKey) —— subjectKey 是**稳定**的被裁决对象
 *   (此处 = 被取代的 Memory id), 而不是随 LLM 措辞漂移的 finding id / dedupHash。
 *   - registerFindingClosure(): 裁决方(人工决策/8 维自动决策/落地脚本)登记一次;
 *   - applyFindingClosures(): 反思保存前 + 每小时 sweep 时, 把命中登记的 finding 重放为 RESOLVED,
 *     closureReason / 证据原样保留; 证据不合格(requireEvidence 硬拦)则不置 RESOLVED。
 *   于是「结单」与「重算」解耦: 重算只会重建 finding, 重放会把结单再安回去 -> 幂等、可复算、可审计。
 *
 * 诚实边界:
 *   - 基础口径只对**冲突/数据修正类** finding(category=CONFLICT, 或 actionType∈{FIX_DATA,MERGE_CONFLICT})
 *     生效, 避免误伤 CREATE_* 类(它们只是顺带提到某条被取代的 Memory, 不代表前提消失)。
 *   - 2026-09-15(f-003 mt57s0)新增**显式 opt-in**: 登记行可用 matchCategories(JSON 数组)声明额外覆盖的
 *     category(如 RECURRING)。默认空 -> 行为与旧版完全一致; 只有裁决方明确声明的那条结单才跨 category,
 *     不做全库一刀切(实测 RECURRING 全库 302 条, 一刀切会误关 1 条仅顺带提到已修代码符号的 CREATE_PRACTICE)。
 *   - 不伪造 finding: 若重算后 LLM 不再产出该冲突 finding, 就什么也不做(冲突真的消失了, 无需重放)。
 *   - 已登记的结单不会自动失效/过期; 若被裁决对象后来真的再次损坏, 需裁决方更新或撤销该登记行
 *     (这是设计选择: 结单是权威裁决, 不靠时间自动推翻)。
 *   - 建表/读写走 better-sqlite3 原生(与 todo-store 同套路): 既不在 1GB 生产 dev.db 上跑 prisma migrate,
 *     也绕开 Prisma 对「原生建表的 INTEGER 列」原始查询的映射问题。
 */
import { openMindDb } from "@/server/lib/open-mind-db";
import path from "path";
import { createHash } from "crypto";
import { requireEvidence } from "./evidence";

const DB_PATH = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");
const TABLE = "FindingClosure";

const DDL =
  "CREATE TABLE IF NOT EXISTS " + TABLE + " (" +
  "id TEXT PRIMARY KEY, theme TEXT NOT NULL, subjectType TEXT NOT NULL, subjectKey TEXT NOT NULL, " +
  "subjectSuffix TEXT, closureReason TEXT NOT NULL, resolutionNote TEXT, evidenceRef TEXT, " +
  "owner TEXT, ownerRule TEXT, decidedBy TEXT, decidedAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, " +
  // 2026-09-15 机制修复(f-003 Pipeline mt57s0): 裁决方可显式声明「本结单额外覆盖的 finding category」(JSON 数组文本)。
  //   默认空 = 维持原口径(仅 CONFLICT / FIX_DATA / MERGE_CONFLICT); 只有确实需要跨类的裁决才 opt-in, 避免一刀切误伤。
  "matchCategories TEXT)";

async function openDb() {

  const db = openMindDb({ role: "direct-rw", dbPath: DB_PATH, caller: "finding-closure-store" });

  db.exec(DDL);
  // 已存在的旧表不会因 CREATE TABLE IF NOT EXISTS 补列 —— 幂等补一次(老库平滑升级)。
  const cols = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name?: string }>;
  if (!cols.some((c) => c?.name === "matchCategories")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN matchCategories TEXT`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS FindingClosure_key ON " + TABLE + " (theme, subjectType, subjectKey)");
  return db;
}

export interface FindingClosureRow {
  id: string;
  theme: string;
  subjectType: string; // 'memory' | ...
  subjectKey: string; // 稳定键: 被裁决对象 id(如 Memory id)
  subjectSuffix?: string | null; // 供文本匹配的短后缀(如 mt57s0), 可空
  closureReason: string; // FIX_DATA_EXECUTED / PREMISE_SATISFIED / ...
  resolutionNote?: string | null;
  evidenceRef?: string | null;
  owner?: string | null;
  ownerRule?: string | null;
  decidedBy?: string | null;
  decidedAt?: number | null;
  matchCategories?: string | null; // JSON 数组文本, 如 '["RECURRING"]'; 空 = 不额外放行
  createdAt: number;
  updatedAt: number;
}

export interface FindingClosureInput {
  theme: string;
  subjectType: string;
  subjectKey: string;
  subjectSuffix?: string | null;
  closureReason: string;
  resolutionNote?: string | null;
  evidenceRef?: string | null;
  owner?: string | null;
  ownerRule?: string | null;
  decidedBy?: string | null;
  decidedAt?: number | null;
  matchCategories?: string[] | null; // 显式 opt-in 的额外 category, 如 ["RECURRING"]
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf-8").digest("hex");
export const findingClosureId = (theme: string, subjectType: string, subjectKey: string) =>
  "fc-" + sha256(`${theme}|${subjectType}|${subjectKey}`).slice(0, 24);

/** 幂等登记(upsert)。返回登记行 id。 */
export async function registerFindingClosure(input: FindingClosureInput): Promise<string> {
  const now = Date.now();
  const id = findingClosureId(input.theme, input.subjectType, input.subjectKey);
  const db = await openDb();
  try {
    db.prepare(
      `INSERT INTO ${TABLE} (id, theme, subjectType, subjectKey, subjectSuffix, closureReason, resolutionNote, evidenceRef, owner, ownerRule, decidedBy, decidedAt, matchCategories, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(theme, subjectType, subjectKey) DO UPDATE SET
         subjectSuffix=excluded.subjectSuffix, closureReason=excluded.closureReason,
         resolutionNote=excluded.resolutionNote, evidenceRef=excluded.evidenceRef,
         owner=excluded.owner, ownerRule=excluded.ownerRule, decidedBy=excluded.decidedBy,
         decidedAt=excluded.decidedAt, matchCategories=excluded.matchCategories, updatedAt=excluded.updatedAt`
    ).run(
      id,
      input.theme,
      input.subjectType,
      input.subjectKey,
      input.subjectSuffix ?? null,
      input.closureReason,
      input.resolutionNote ?? null,
      input.evidenceRef ?? null,
      input.owner ?? null,
      input.ownerRule ?? null,
      input.decidedBy ?? null,
      input.decidedAt ?? now,
      input.matchCategories?.length ? JSON.stringify(input.matchCategories) : null,
      now,
      now
    );
    return id;
  } finally {
    db.close();
  }
}

/** 读取登记表(可按 theme 过滤)。失败返回 [] (非致命)。 */
export async function loadFindingClosures(theme?: string): Promise<FindingClosureRow[]> {
  try {
    const db = await openDb();
    try {
      const rows = theme
        ? db.prepare(`SELECT * FROM ${TABLE} WHERE theme=? ORDER BY updatedAt DESC`).all(theme)
        : db.prepare(`SELECT * FROM ${TABLE} ORDER BY updatedAt DESC`).all();
      return (rows as FindingClosureRow[]) || [];
    } finally {
      db.close();
    }
  } catch (e: any) {
    console.warn(`[finding-closure] 读取登记表失败(非致命): ${(e?.message || "").slice(0, 120)}`);
    return [];
  }
}

/** 解析登记行上的 category opt-in(兼容 JSON 数组文本 / 数组 / null / 非法值)。 */
export function parseMatchCategories(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  const s = String(raw ?? "").trim();
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * 该 finding 是否属于「冲突/数据修正」类 —— 只有这类才允许按登记结单。
 * @param closure 可选: 若登记行显式 opt-in 了该 finding 的 category(如 RECURRING), 也算冲突/数据修正类。
 */
export function isConflictLikeFinding(
  finding: any,
  closure?: Pick<FindingClosureRow, "matchCategories"> | null
): boolean {
  const cat = String(finding?.category || "");
  const at = String(finding?.actionType || finding?.type || "");
  // 2026-09-15 独立复核纠正(反例): buildStructuredFindings 在 LLM 未给 actionType 时**默认 MARK_REVIEW**,
  //   而 MARK_REVIEW 是通用兜底值 —— 若只看 actionType 就把 MARK_REVIEW 当冲突类, 会把
  //   COVERAGE_GAP/MISSED_TOPIC/IMPROVEMENT 等**非冲突** finding(只要正文提到被取代 Memory)误置 RESOLVED。
  //   故基础口径收紧: 只认 category=CONFLICT, 或显式数据修正动作 FIX_DATA/MERGE_CONFLICT。
  if (cat === "CONFLICT") return true;
  if (at === "FIX_DATA" || at === "MERGE_CONFLICT") return true;
  // 2026-09-15 机制修复(f-003 Pipeline mt57s0): RECURRING 是「上次发现的问题再次出现」的专用 category,
  //   但**不能一刀切**放行(实测: 全库 302 条 RECURRING, 其中 1 条 CREATE_PRACTICE 仅顺带提到已修代码符号,
  //   一刀切会被 code_symbol 结单误关)。改为**裁决方在登记行显式 opt-in**: 只有明确声明覆盖 RECURRING
  //   的那条结单, 才能关掉 RECURRING finding; 匹配仍受稳定 subjectKey + theme + requireEvidence 三重约束。
  if (cat && parseMatchCategories(closure?.matchCategories).includes(cat)) return true;
  return false;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 命中判定: finding 是否指向登记表里的被裁决对象。
 * 三级匹配(全部限定在冲突/数据修正类): relatedMemoryIds -> 正文含全 id(词边界) -> 正文 Memory[<suffix>](边界内)。
 * 用稳定 subjectKey 而不是 dedupHash, 因为 LLM 措辞每次都会漂移(见根因)。
 */
export function findingMatchesClosure(finding: any, closure: FindingClosureRow, theme?: string): boolean {
  if (!finding || !closure) return false;
  // 登记行必须有 theme(裁决总是发生在某主题内); 传了 theme 就必须相等 —— 不做"任一为空即放行"的短路。
  if (!closure.theme) return false;
  if (theme != null && String(closure.theme) !== String(theme)) return false;
  if (!isConflictLikeFinding(finding, closure)) return false;
  const ids: string[] = Array.isArray(finding.relatedMemoryIds) ? finding.relatedMemoryIds.map(String) : [];
  if (ids.includes(closure.subjectKey)) return true;
  const hay = [finding.what, finding.why, finding.requirement, finding.evidenceSnippet, finding.background]
    .map((x) => String(x ?? ""))
    .join("\n");
  if (!hay) return false;
  // 全 id: 要求两侧不是 id 字符(把 - 与 _ 也算 id 字符, 避免 "XXX<id>YYY"/"a-<id>-b" 这类拼接误命中)。
  if (closure.subjectKey && new RegExp(`(^|[^0-9A-Za-z_-])${escapeRe(closure.subjectKey)}([^0-9A-Za-z_-]|$)`).test(hay)) return true;
  // 后缀: 必须出现在 Memory[...] 内, 且两侧不是 id 字符(避免 Memory[mt57s0x] / Memory[zz-mt57s0-zz] 误命中)。
  const sfx = String(closure.subjectSuffix || "").trim() || (closure.subjectKey ? closure.subjectKey.slice(-6) : "");
  if (sfx && new RegExp(`Memory\\[[^\\]]*(?<![0-9A-Za-z_-])${escapeRe(sfx)}(?![0-9A-Za-z_-])[^\\]]*\\]`).test(hay)) return true;
  return false;
}

/**
 * 就地重放登记结单。返回本次置为 RESOLVED 的条数。
 * 语义: 已 RESOLVED 的跳过; 证据不合格(requireEvidence 硬拦)不置 RESOLVED, 与执行器同一底线。
 */
export function applyFindingClosures(findings: any[], closures: FindingClosureRow[], theme?: string): number {
  if (!Array.isArray(findings) || !closures?.length) return 0;
  let closed = 0;
  for (const f of findings) {
    if (!f || String(f.status || "") === "RESOLVED") continue;
    const c = closures.find((cl) => findingMatchesClosure(f, cl, theme));
    if (!c) continue;
    // 在副本上校验证据, 不合格就完全不结单(不污染原对象、不硬置 RESOLVED, 与执行器同一底线)。
    // 登记表里的 evidenceRef 是裁决方的权威证据, 优先于 finding 上可能已失效的旧证据。
    const candidate: any = { ...f };
    if (c.evidenceRef) candidate.evidenceRef = c.evidenceRef;
    if (c.resolutionNote) {
      candidate.resolutionNote = candidate.resolutionNote
        ? String(candidate.resolutionNote) + " | " + c.resolutionNote
        : c.resolutionNote;
    }
    if (!requireEvidence(candidate)) continue;
    f.evidenceRef = candidate.evidenceRef;
    f.resolutionNote = candidate.resolutionNote;
    f.evidenceKind = candidate.evidenceKind;
    f.status = "RESOLVED";
    f.closureReason = c.closureReason;
    f.lastResolvedAt = new Date().toISOString();
    if (c.owner) f.owner = c.owner;
    if (c.ownerRule) f.ownerRule = c.ownerRule;
    if (c.decidedBy) f.decidedBy = c.decidedBy;
    closed++;
  }
  return closed;
}
