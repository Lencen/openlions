// 2026-09-10 商业化改版: console 服务端只读数据访问层
// 2026-10-25 更正（老板提醒）：mind / session / macs **全部是 PostgreSQL**，不是 SQLite。
//   本文件自 2026-10-21 Phase 2 起就只用 pg.Pool（lions_mind / lions_session / lions_macs_ro），
//   下面提到的 SQLite 只存在于历史注释与 sql-dialect 的兼容分支里。
// 约束:
//  1) 全部只读 (readonly: true), 不写任何库;
//  2) 容错优先: 库不存在 / 表不存在 / 字段缺失一律返回空值, 绝不抛 500;
//  3) 每个响应都带 asOf 时间戳, 便于前端展示"数据时间"。
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { adaptSql } from "@/lib/sql-dialect";

// 2026-10-21 Phase 2: mind/session 已切 PG，console 的只读层改为 PG 连接池（只读、容错优先）。
function pgPassword(): string {
  // 开源可移植：优先环境变量，其次可配置路径，再次仓库内默认（仅本机开发）
  const file = process.env.LIONS_PG_PASSWORD_FILE || "~/lions/run/pg-password";
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return process.env.PGPASSWORD || ""; }
}
function urlFor(envName: string, db: string): string {
  const explicit = process.env[envName];
  if (explicit) return explicit;
  const pw = pgPassword();
  return pw ? `postgresql://lions:${pw}@127.0.0.1:5432/${db}?connection_limit=4` : "";
}

export const MIND_DB = urlFor("MIND_DATABASE_URL", "lions_mind");
export const SESSION_DB = urlFor("SESSION_DATABASE_URL", "lions_session");
// 2026-10-21 MACS 消息库（Wave 1.5 已由 MACS 后端线迁到 PG）。按交接要求：
//   console 只用**只读角色** lions_macs_ro（凭据在 ~/.config/macs/lions_macs_ro.env，600），
//   不持可写凭据；写操作走 MACS 的 admin BFF（下一阶段）。
function macsRoUrl(): string {
  const file = process.env.MACS_RO_ENV_FILE || (process.env.HOME || "~") + "/.config/macs/lions_macs_ro.env";
  try {
    const raw = fs.readFileSync(file, "utf8");
    const env: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    if (!env.PGUSER || !env.PGPASSWORD) return "";
    const host = env.PGHOST || "127.0.0.1";
    const port = env.PGPORT || "5432";
    const db = env.PGDATABASE || "lions_macs";
    return "postgresql://" + env.PGUSER + ":" + encodeURIComponent(env.PGPASSWORD) + "@" + host + ":" + port + "/" + db + "?connection_limit=4";
  } catch { return ""; }
}

export const MACS_DB = process.env.MACS_DATABASE_URL || macsRoUrl();

let mindPool: Pool | null = null;
let sessionPool: Pool | null = null;
let macsPool: Pool | null = null;

export function openMind(): Pool | null {
  if (!MIND_DB) return null;
  if (!mindPool) mindPool = new Pool({ connectionString: MIND_DB, max: 4 });
  return mindPool;
}

export function openSession(): Pool | null {
  if (!SESSION_DB) return null;
  if (!sessionPool) sessionPool = new Pool({ connectionString: SESSION_DB, max: 4 });
  return sessionPool;
}

/**
 * 2026-10-21 MACS 消息库只读池。
 *   · 库/角色由 MACS 后端线在 Wave 1.5 创建（lions_macs + lions_macs_ro 只读角色）；
 *   · 现在库还不存在 → 连接必然失败；调用方**不要**把它当"0 条消息"，而要显示"示例数据/库未就绪"。
 *   · 只读约束：本池只用于 SELECT；写操作一律走 MACS 的 HTTP 接口。
 */
export function openMacs(): Pool | null {
  if (!MACS_DB) return null;
  if (!macsPool) macsPool = new Pool({ connectionString: MACS_DB, max: 2 });
  return macsPool;
}

/** 探测 MACS 库是否可用（Wave 1.5 完成前应为 false；页面据此决定"示例数据"还是"真实数据"） */
export async function macsReady(): Promise<{ ready: boolean; reason?: string; tables?: number }> {
  const db = openMacs();
  if (!db) return { ready: false, reason: "MACS_DATABASE_URL 未配置" };
  try {
    const t = await db.query('SELECT COUNT(*)::int c FROM information_schema.tables WHERE table_schema = \'public\'');
    const n = Number(t.rows?.[0]?.c ?? 0);
    if (!n) return { ready: false, reason: "库存在但没有任何表（迁移未执行）" };
    return { ready: true, tables: n };
  } catch (e: any) {
    return { ready: false, reason: String(e?.message || e).slice(0, 120) };
  }
}

// 2026-10-21 前端对账修复：PG 下时间列是 timestamp，SQLite 的 CAST(ts / ms AS INTEGER) 会直接报
//   "operator does not exist: timestamp without time zone / integer"，而 q() 原先吞掉异常返回 []，
//   结果所有趋势线/会话数都变成 0（看着像"真的没数据"）。这里提供方言化的分桶表达式，
//   并把查询失败记进 queryFailures（可观测），不再无声归零。
export const IS_PG = /^postgres/.test(MIND_DB);

/** 把时间列按 bucketMs 分桶：PG 用 EXTRACT(EPOCH)（毫秒），SQLite 用 CAST 整数除法 */
export function bucketExpr(tsCol: string, bucketMs: number): string {
  return IS_PG
    ? "((FLOOR(EXTRACT(EPOCH FROM " + tsCol + ") * 1000 / " + bucketMs + ") * " + bucketMs + ")::bigint)"
    : "CAST(" + tsCol + " / " + bucketMs + " AS INTEGER) * " + bucketMs;
}

/** 近期查询失败样本（供 /api/db-health 与排查使用；最多留 20 条） */
export const queryFailures: { at: number; sql: string; error: string }[] = [];

/** 把毫秒时间戳格式化成 PG timestamp 列同款本地时间串（2026-10-21 对账修复，见下方说明） */
function toLocalTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
    p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/**
 * 2026-10-21 前端对账修复（第 3 个 PG 陷阱）：路由把"毫秒时间戳数字"直接当参数传去比 timestamp 列，
 *   PG 报 "date/time field value out of range" / "operator does not exist"，被 q() 吞掉后整片指标变 0。
 *   实测三种写法都能对上真值（273）：Date 参数 / 本地时间串 / to_timestamp($1/1000.0)。
 *   这里选"本地时间串"——它与 PG 列（timestamp without time zone，存本地时间）的约定一致，不做时区换算。
 *   只对 >= 1e12 的数字生效（毫秒时间戳的量级），评分/计数等小数字不受影响。
 */
function coerceParams(params: any[]): any[] {
  if (!IS_PG) return params;
  // 2026-10-21 修正：adaptSql 会把 timestamp 比较改写成 to_timestamp($n::double/1000.0)，
  // 它要求数字毫秒，不能转成字符串（否则 to_timestamp('2026-10-21 15:08:05'::double) 报错）。
  return params.map((v) => (typeof v === "number" && v >= 1e12 ? v : v));
}

/**
 * 2026-10-21 前端对账修复（第 4 个 PG 陷阱）：会话库的表是**大小写敏感**的 CamelCase
 *   （"Session" / "Message"），而 mind 库的表在 PG 里是小写。mind 的表名由
 *   mind-db-identifiers.json 驱动加引号，会话库的表不在该清单里 → `FROM Session` 被 PG 折成
 *   `session` → "relation session does not exist" → 会话/消息类指标全 0。
 *   这里只对会话库这两张表做引号补齐（幂等：已带引号的不再处理）。
 */
function quoteSessionTables(sql: string): string {
  return sql
    .replace(/\b(FROM|JOIN)\s+(Session|Message)\b(?!\s*")/gi, (_m, kw, t) => kw + ' "' + t + '"')
    // 2026-10-21: 会话库的列同样是 CamelCase，未加引号会被折成 extractstatus
    .replace(/\bextractStatus\b(?!\s*")/g, '"extractStatus"');
}

/**
 * 2026-10-21 前端对账修复（第 5 个 PG 陷阱）：**布尔列**。
 *   SQLite 时代 stale/legacy 等是 0/1 整数，PG 里是真正的 boolean；
 *   `COALESCE(stale,0)=0` 在 PG 直接报 "COALESCE types boolean and integer cannot be matched"，
 *   被 q() 吞掉后知识治理页/资产页整块显示 0/空。
 *   这里只对已知布尔列做定向改写（幂等：已是 true/false 的不再动）。
 */
const PG_BOOL_COLS = [
  "stale", "legacy", "humanConfirmed", "migrated", "resolved", "enabled", "idempotent",
  "isPrimary", "manualReview", "isDayLevel", "qualityPassed", "autoReflect",
];

function rewritePgBooleans(sql: string): string {
  let out = sql;
  for (const col of PG_BOOL_COLS) {
    const c = col;
    // COALESCE(col, 0) = 0/1 —— 先把整体比较改写掉，再处理裸 COALESCE
    out = out.replace(new RegExp("COALESCE\\(\\s*" + c + "\\s*,\\s*(?:0|false)\\s*\\)\\s*=\\s*0\\b", "gi"), "COALESCE(" + c + ",false)=false");
    out = out.replace(new RegExp("COALESCE\\(\\s*" + c + "\\s*,\\s*(?:0|false)\\s*\\)\\s*=\\s*1\\b", "gi"), "COALESCE(" + c + ",false)=true");
    // COALESCE(col,0) / COALESCE(col, 0) -> false
    out = out.replace(new RegExp("COALESCE\\(\\s*" + c + "\\s*,\\s*0\\s*\\)", "gi"), "COALESCE(" + c + ",false)");
    // col=0 / col = 0 -> false ; col=1 / col = 1 -> true（只匹配独立的列名 token）
    out = out.replace(new RegExp("(^|[^A-Za-z0-9_\"])" + c + "\\s*=\\s*0\\b", "gi"), (_m, pre) => pre + c + "=false");
    out = out.replace(new RegExp("(^|[^A-Za-z0-9_\"])" + c + "\\s*=\\s*1\\b", "gi"), (_m, pre) => pre + c + "=true");
  }
  return out;
}

/** 任意查询, 失败返回 []（但会记录失败，避免"坏查询=全 0"被当成真数据） */
export async function q(db: any, sql: string, ...params: any[]): Promise<any[]> {
  if (!db) return [];
  try {
    const pre = IS_PG ? rewritePgBooleans(quoteSessionTables(sql)) : quoteSessionTables(sql);
    const r = await db.query(adaptSql(pre), coerceParams(params));
    return r.rows as any[];
  } catch (e: any) {
    if (queryFailures.length >= 20) queryFailures.shift();
    queryFailures.push({ at: Date.now(), sql: String(sql).slice(0, 200), error: String(e?.message || e) });
    return [];
  }
}

/** 单行查询, 失败返回 null */
export async function one(db: any, sql: string, ...params: any[]): Promise<any | null> {
  const rows = await q(db, sql, ...params);
  return rows[0] ?? null;
}

/** 只取单个数字, 失败返回 0 */
export async function scalar(db: any, sql: string, ...params: any[]): Promise<number> {
  const row = await one(db, sql, ...params);
  if (!row) return 0;
  const v = Object.values(row)[0];
  return typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0;
}

/** 读取表的所有列名（PG: information_schema） */
export async function tableColumns(db: any, name: string): Promise<string[]> {
  if (!db) return [];
  try {
    const r = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [name]);
    return r.rows.map((c: any) => String(c.column_name));
  } catch { return []; }
}

export async function tableExists(db: any, name: string): Promise<boolean> {
  if (!db) return false;
  try {
    const r = await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1", [name]);
    return r.rows.length > 0;
  } catch { return false; }
}

// ---------------- 时间范围 ----------------

export type RangeKey = "1h" | "24h" | "7d" | "30d" | "all";

export interface RangeInfo {
  key: RangeKey;
  label: string;
  /** 统计起点 (ms); 'all' 为 0 */
  since: number;
  /** 趋势图起点 (ms); 'all' 时回退到近 30 天, 避免画出几千个点 */
  trendSince: number;
  bucketMs: number;
  buckets: number;
  bucketKind: "5min" | "hour" | "day";
}

const RANGE_PRESET: Record<RangeKey, { label: string; spanMs: number | null; bucketMs: number; buckets: number; kind: "5min" | "hour" | "day" }> = {
  "1h": { label: "近 1 小时", spanMs: 3600e3, bucketMs: 300e3, buckets: 12, kind: "5min" },
  "24h": { label: "近 24 小时", spanMs: 86400e3, bucketMs: 3600e3, buckets: 24, kind: "hour" },
  "7d": { label: "近 7 天", spanMs: 7 * 86400e3, bucketMs: 86400e3, buckets: 7, kind: "day" },
  "30d": { label: "近 30 天", spanMs: 30 * 86400e3, bucketMs: 86400e3, buckets: 30, kind: "day" },
  all: { label: "全部历史", spanMs: null, bucketMs: 86400e3, buckets: 30, kind: "day" },
};

export function resolveRange(range?: string | null, now: number = Date.now()): RangeInfo {
  const key = (["1h", "24h", "7d", "30d", "all"] as RangeKey[]).includes(range as RangeKey)
    ? (range as RangeKey)
    : "24h";
  const p = RANGE_PRESET[key];
  const since = p.spanMs === null ? 0 : now - p.spanMs;
  const trendSince = now - p.bucketMs * p.buckets;
  return {
    key,
    label: p.label,
    since,
    trendSince,
    bucketMs: p.bucketMs,
    buckets: p.buckets,
    bucketKind: p.kind,
  };
}

export interface Bucket {
  ts: number;
  label: string;
  /** 该桶的计数 (由调用方填充) */
  v: number;
}

/** 生成等宽时间桶 (最后一桶 = 当前时间所在桶) */
export function makeBuckets(r: RangeInfo, now: number = Date.now()): Bucket[] {
  const out: Bucket[] = [];
  for (let i = r.buckets - 1; i >= 0; i--) {
    const ts = now - i * r.bucketMs;
    const d = new Date(ts);
    let label: string;
    if (r.bucketKind === "5min") {
      label = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } else if (r.bucketKind === "hour") {
      label = `${String(d.getHours()).padStart(2, "0")}:00`;
    } else {
      label = `${d.getMonth() + 1}/${d.getDate()}`;
    }
    out.push({ ts, label, v: 0 });
  }
  return out;
}

/** 把时间戳投进桶 (返回桶下标, 不在范围内返回 -1) */
export function bucketIndex(r: RangeInfo, buckets: Bucket[], ts: number, now: number = Date.now()): number {
  const first = now - (r.buckets - 1) * r.bucketMs;
  if (!Number.isFinite(ts) || ts < first) return -1;
  const idx = Math.floor((ts - first) / r.bucketMs);
  return idx >= 0 && idx < buckets.length ? idx : -1;
}

// ---------------- 口径解析 ----------------

export type TokenKind = "measured" | "estimated" | "chars" | "none";

export interface TokenParse {
  tokens: number | null;
  estimated: boolean;
  chars: number | null;
  kind: TokenKind;
}

/** 解析 CALL_LLM 事件的 sourceTitle: `tok=43687` / `tok≈43687` / `chars≈1421` / '' */
export function parseTokenTitle(title: string | null | undefined): TokenParse {
  const t = String(title || "").trim();
  const measured = /^tok=(\d+)/.exec(t);
  if (measured) return { tokens: Number(measured[1]), estimated: false, chars: null, kind: "measured" };
  const est = /^tok[≈~]=?(\d+)/.exec(t);
  if (est) return { tokens: Number(est[1]), estimated: true, chars: null, kind: "estimated" };
  const chars = /chars[≈~]?=?(\d+)/.exec(t);
  if (chars) return { tokens: null, estimated: false, chars: Number(chars[1]), kind: "chars" };
  return { tokens: null, estimated: false, chars: null, kind: "none" };
}

/**
 * 2026-09-10 新口径: CALL_LLM 事件的 sourceTitle 追加了 model= 与 entry= (兼容旧格式)
 *   tok=N model=MiniMax-M3 entry=reflect [calls=1]
 *   tok≈N / chars≈N 前缀规则不变 (前缀仍可能为空)
 * 返回: token 解析 + model + entry + calls
 */
export interface CallTitleParse extends TokenParse {
  model: string | null;
  entry: string | null;
  calls: number | null;
}

export function parseCallTitle(title: string | null | undefined): CallTitleParse {
  const t = String(title || "");
  const base = parseTokenTitle(t);
  const model = /model=([^\s]+)/.exec(t);
  const entry = /entry=([^\s]+)/.exec(t);
  const calls = /calls=(\d+)/.exec(t);
  return {
    ...base,
    model: model ? model[1] : null,
    entry: entry ? entry[1] : null,
    calls: calls ? Number(calls[1]) : null,
  };
}

/**
 * CALL_LLM 事件的归因主体 (2026-09-10 治本):
 *   sourceType = "agent:<agentId>"    → agent 自报用量 (submit 时带 usage), sourceId = taskId
 *   sourceType = "platform:<entry>"   → 平台侧调用 (入口 = reflect / main-extract / ...), sourceId = durationMs
 *   其它 (历史数据)                    → entry = sourceType 原值 (legacy 写法, 仍按平台侧归因)
 */
export interface CallAttribution {
  kind: "agent" | "platform";
  agentId: string | null;
  entry: string | null;
  legacy: boolean;
}

export function attributeCall(sourceType: string | null | undefined, parsedEntry?: string | null): CallAttribution {
  const st = String(sourceType || "");
  if (st.startsWith("agent:")) {
    return { kind: "agent", agentId: st.slice(6) || "(未知智能体)", entry: parsedEntry || "agent-submit", legacy: false };
  }
  if (st.startsWith("platform:")) {
    return { kind: "platform", agentId: null, entry: parsedEntry || st.slice(9), legacy: false };
  }
  return { kind: "platform", agentId: null, entry: parsedEntry || st || "unknown", legacy: true };
}

/** 解析 AGENT_OUTPUT_INGESTED 的 sourceTitle: `agent=agent-x knowledge=xxx q=0.75` */
export function parseAgentOutput(title: string | null | undefined): {
  agentId: string | null;
  targetKind: string | null;
  targetId: string | null;
  quality: number | null;
  candidate: string | null;
} {
  const t = String(title || "");
  const agent = /agent=([\w.\-]+)/.exec(t);
  const knowledge = /knowledge=([\w\-]+)/.exec(t);
  const memory = /memory=([\w\-]+)/.exec(t);
  const skill = /skill=([\w\-]+)/.exec(t);
  const practice = /practice=([\w\-]+)/.exec(t);
  const qv = /q=([\d.]+)/.exec(t);
  const cand = /candidate=([\w\-]+)/.exec(t);
  const target = knowledge
    ? { kind: "Knowledge", id: knowledge[1] }
    : memory
      ? { kind: "Memory", id: memory[1] }
      : skill
        ? { kind: "Skill", id: skill[1] }
        : practice
          ? { kind: "Practice", id: practice[1] }
          : { kind: null, id: null };
  return {
    agentId: agent ? agent[1] : null,
    targetKind: target.kind,
    targetId: target.id,
    quality: qv ? Number(qv[1]) : null,
    candidate: cand ? cand[1] : null,
  };
}

/** 解析 CONTEXT_INJECTED 事件 sourceTitle (JSON) */
export function parseInjection(title: string | null | undefined): {
  agentId: string | null;
  count: number;
  kinds: string[];
  ids: string[];
} {
  try {
    const j = JSON.parse(String(title || "{}"));
    return {
      agentId: j?.agentId ?? null,
      count: Number(j?.count ?? 0),
      kinds: Array.isArray(j?.kinds) ? j.kinds : [],
      ids: Array.isArray(j?.ids) ? j.ids : [],
    };
  } catch {
    return { agentId: null, count: 0, kinds: [], ids: [] };
  }
}

/** mind 侧 .env.local 取值 (只读, 用于"模型"维度归因说明) */
const envCache = new Map<string, string | null>();
export function readMindEnv(key: string): string | null {
  if (envCache.has(key)) return envCache.get(key) ?? null;
  let value: string | null = null;
  try {
    const file = path.join(path.dirname(MIND_DB), "..", ".env.local");
    const raw = fs.readFileSync(file, "utf-8");
    for (const line of raw.split("\n")) {
      const m = new RegExp("^\\s*" + key + "\\s*=\\s*(.+)\\s*$").exec(line);
      if (m) {
        value = m[1].trim().replace(/^["']|["']$/g, "");
        break;
      }
    }
  } catch {
    value = null;
  }
  envCache.set(key, value);
  return value;
}

/**
 * 模型维度归因:
 * 观测事件 (FlywheelEvent) 本身没有 model 字段, 这里按 mind 侧各入口的模型路由规则推定,
 * 前端会明确标注"推定 (按入口路由)"。
 */
export function modelForEntry(entryRaw: string): string {
  const dev = process.env.ANTHROPIC_MODEL || readMindEnv("ANTHROPIC_MODEL");
  const reflect = process.env.REFLECT_MODEL || readMindEnv("REFLECT_MODEL");
  // 2026-09-10: mind 侧新事件把主体写进 sourceType (platform:<entry> / agent:<id>), 这里先归一化再路由
  const entry = String(entryRaw || "")
    .replace(/^(platform|agent):/i, "")
    .replace(/^agent-/, "");
  if (entry === "reflect" || entry === "reflect-daily") return reflect || dev || "MiniMax-M3";
  if (entry === "global-organizer") return dev || "MiniMax-M2.7";
  if (["main-extract", "main-extract-batch", "structured", "improving-tasks"].includes(entry))
    return dev || "MiniMax-M3";
  return dev || "未记录";
}

// ---------------- 杂项 ----------------

export function num(v: any, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function round(v: any, digits = 2): number {
  const n = num(v, 0);
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

export function asOf(): string {
  return new Date().toISOString();
}

/** 产物四表统一元数据 */
export const ARTIFACT_TABLES = ["Memory", "Knowledge", "Practice", "Skill"] as const;
export type ArtifactTable = (typeof ARTIFACT_TABLES)[number];

export const ARTIFACT_LABEL: Record<string, string> = {
  Memory: "记忆 Memory",
  Knowledge: "知识 Knowledge",
  Practice: "实践 Practice",
  Skill: "技能 Skill",
};

export const ARTIFACT_COLOR: Record<string, string> = {
  Memory: "var(--table-memory)",
  Knowledge: "var(--table-knowledge)",
  Practice: "var(--status-warn)",
  Skill: "var(--primary)",
};

/** 各表可选列 (不同表列不同, 统一成前端可渲染的字段) */
export function artifactColumns(table: string): { id: string; title: string; extra: string[] } {
  switch (table) {
    case "Memory":
      return { id: "id", title: "COALESCE(title, substr(content,1,80))", extra: ["theme", "agentSource", "sourceType", "sourceId", "qualityScore", "createdAt", "accessCount", "lastAccessed"] };
    case "Knowledge":
      return { id: "id", title: "title", extra: ["theme", "agentSource", "sourceType", "sourceId", "qualityScore", "createdAt", "usageCount", "lastUsedAt", "verification", "humanConfirmed", "stale"] };
    case "Practice":
      return { id: "id", title: "title", extra: ["theme", "agentSource", "sourceType", "sourceId", "qualityScore", "createdAt", "completedAt"] };
    case "Skill":
      return { id: "id", title: "name", extra: ["theme", "category", "source", "qualityScore", "createdAt", "totalUsageCount", "verification", "level"] };
    default:
      return { id: "id", title: "id", extra: [] };
  }
}

/**
 * Agent 归因:
 * 产物表 (Memory/Knowledge/Practice) 没有 agent 外键 —— 只有 sourceType/agentSource,
 * 其中流水线入口形如 PIPELINE_AGENT-operator, Agent 主动提交形如 agent:agent-operator。
 * 因此按 agent 过滤产物只能是"尽力而为", 这里给出可匹配的模式集合, 页面会明确标注。
 */
export function agentPatterns(agentId: string): string[] {
  const id = String(agentId || "").trim();
  if (!id) return [];
  const suffix = id.replace(/^agent[-_:]/i, "").toUpperCase();
  return Array.from(
    new Set([
      id,
      `agent:${id}`,
      `PIPELINE_${id.toUpperCase()}`,
      `PIPELINE_AGENT-${suffix}`,
      `AGENT_${suffix}`,
    ])
  );
}

/** 产物表按 agent 归因的 SQL 片段 (sourceType / agentSource 任一命中) */
export function agentMatchSql(
  agentId: string,
  cols: (string | null)[] = ["sourceType", "agentSource"]
): { sql: string; params: any[] } {
  const pats = agentPatterns(agentId);
  const usable = cols.filter(Boolean) as string[];
  if (!pats.length || !usable.length) return { sql: "1=0", params: [] };
  const placeholders = pats.map(() => "?").join(", ");
  const sql = usable.map((c) => `${c} IN (${placeholders})`).join(" OR ");
  const params: any[] = [];
  for (let i = 0; i < usable.length; i++) params.push(...pats);
  return { sql: `(${sql})`, params };
}

export function safeClose(...dbs: any[]) {
  for (const db of dbs) {
    try { db?.close?.(); } catch { /* ignore */ }
  }
}
