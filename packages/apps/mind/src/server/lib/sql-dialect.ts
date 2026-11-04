/**
 * sql-dialect.ts — SQL 方言适配（Phase 2：SQLite -> PostgreSQL）
 *
 * 两个转换（仅 MIND_DB_DRIVER=pg 时生效，SQLite 默认不变）：
 *  1) 占位符：SQLite 风格 "?" -> PostgreSQL "$1..$n"（引号/注释感知）；
 *  2) 标识符：SQLite 大小写不敏感，PG 敏感 —— 把未加引号的已知表/列名规范成带引号的原始大小写
 *     （清单来自 scripts/gen-mind-identifiers.cjs 生成的 mind-db-identifiers.json）。
 */
const IDS = require("../../lib/mind-db-identifiers.json") as { tables: string[]; columns: string[]; dateColumns?: string[]; rawTables?: string[]; boolColumns?: string[] };

export function isPgDriver(): boolean {
  return (process.env.MIND_DB_DRIVER || "").toLowerCase() === "pg";
}

export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (state === "normal") {
      if (ch === "'") { state = "single"; out += ch; }
      else if (ch === '"') { state = "double"; out += ch; }
      else if (ch === "-" && nx === "-") { state = "line"; out += ch; }
      else if (ch === "/" && nx === "*") { state = "block"; out += ch; }
      else if (ch === "?") { out += "$" + (++n); }
      else out += ch;
    } else if (state === "single") {
      out += ch;
      if (ch === "'" && nx === "'") { out += nx; i++; }
      else if (ch === "'") state = "normal";
    } else if (state === "double") {
      out += ch;
      if (ch === '"') state = "normal";
    } else if (state === "line") {
      out += ch;
      if (ch === "\n") state = "normal";
    } else {
      out += ch;
      if (ch === "*" && nx === "/") { out += nx; i++; state = "normal"; }
    }
  }
  return out;
}

const CANON = new Map<string, string>();
for (const n of IDS.tables) CANON.set(n.toLowerCase(), n);
for (const n of IDS.columns) if (!CANON.has(n.toLowerCase())) CANON.set(n.toLowerCase(), n);

// 2026-10-23 修（Todo.evidence 事故）：CANON 是"表名优先"的全局映射，列名与另一张表同名时会被误大写
//   （evidence → "Evidence" ⇒ 42703）。这里按**位置**分表：跟在 FROM/INTO/UPDATE/JOIN/REPLACE/TABLE
//   后面的是表名，其余位置优先按列名解析。列名映射保留真实大小写（Todo 的 ownerType/updatedAt 是
//   CamelCase，evidence/note 是小写）。
const TABLE_CANON = new Map<string, string>();
for (const n of IDS.tables) TABLE_CANON.set(n.toLowerCase(), n);
const COL_CANON = new Map<string, string>();
for (const n of IDS.columns) if (!COL_CANON.has(n.toLowerCase())) COL_CANON.set(n.toLowerCase(), n);
const TABLE_POS_RE = /(?:^|[^A-Za-z0-9_])(from|into|update|join|replace|table)\s*$/i;

// SQL 关键字/函数：即使与列名同名也不加引号（避免把 COUNT(...) 变成 "count"(...)）
const KEYWORDS = new Set([
  "select", "from", "where", "and", "or", "not", "null", "insert", "into", "values", "update", "set",
  "delete", "create", "table", "if", "exists", "order", "by", "group", "limit", "offset", "join",
  "left", "right", "inner", "outer", "on", "as", "count", "sum", "avg", "min", "max", "coalesce",
  "cast", "case", "when", "then", "else", "end", "in", "is", "like", "between", "asc", "desc",
  "distinct", "having", "union", "all", "with", "recursive", "returning", "conflict", "nothing",
  "primary", "key", "foreign", "references", "unique", "index", "default", "integer", "text",
  "real", "blob", "numeric", "boolean", "timestamp", "bigint", "varchar", "true", "false", "now",
  "current_timestamp", "strftime", "datetime", "date", "time", "instr", "substr", "replace",
  "lower", "upper", "length", "trim", "abs", "round", "random", "json_extract", "pragma", "exists",
]);

export function quoteIdentifiers(sql: string): string {
  let out = "";
  let i = 0;
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";
  const isIdent = (c: string) => /[A-Za-z_]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);
  while (i < sql.length) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (state === "normal") {
      if (ch === "'") { state = "single"; out += ch; i++; continue; }
      if (ch === '"') { state = "double"; out += ch; i++; continue; }
      if (ch === "-" && nx === "-") { state = "line"; out += ch + nx; i += 2; continue; }
      if (ch === "/" && nx === "*") { state = "block"; out += ch + nx; i += 2; continue; }
      if (isIdent(ch)) {
        let j = i + 1;
        while (j < sql.length && isIdentPart(sql[j])) j++;
        const tok = sql.slice(i, j);
        let k = j;
        while (k < sql.length && /\s/.test(sql[k])) k++;
        // 2026-10-21: "INSERT INTO X (" 里的 X 是表名不是函数，不能因后随 ( 就跳过引号化
        const prevTok = (out.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/) || [])[1] || "";
        // 2026-11-03（B1b）：`CREATE TABLE IF NOT EXISTS SessionExtractionState (` 里表名后随 "("，
        // 而前一 token 是 EXISTS —— 不在白名单里就会被当成"函数调用"跳过引号化，
        // 于是裸名进 PG 被折成小写 sessionextractionstate，把已退休的孪生表建回来（diag._ddl_audit id=18 实证）。
        const isFunc = sql[k] === "(" && !/^(insert|into|update|from|join|replace|table|exists)$/i.test(prevTok);
        const lower = tok.toLowerCase();
        const tablePos = TABLE_POS_RE.test(out);
        const canonName = tablePos ? TABLE_CANON.get(lower) : (COL_CANON.get(lower) ?? TABLE_CANON.get(lower));
        if (!isFunc && !KEYWORDS.has(lower) && canonName) {
          out += '"' + canonName + '"';
        } else {
          out += tok;
        }
        i = j;
        continue;
      }
      out += ch; i++; continue;
    }
    if (state === "single") {
      out += ch;
      if (ch === "'" && nx === "'") { out += nx; i += 2; continue; }
      if (ch === "'") state = "normal";
      i++; continue;
    }
    if (state === "double") {
      out += ch;
      if (ch === '"' && nx === '"') { out += nx; i += 2; continue; }
      if (ch === '"') state = "normal";
      i++; continue;
    }
    if (state === "line") {
      out += ch;
      if (ch === "\n") state = "normal";
      i++; continue;
    }
    out += ch;
    if (ch === "*" && nx === "/") { out += nx; i += 2; state = "normal"; continue; }
    i++;
    continue;
  }
  return out;
}

const DATE_COLS = new Set(IDS.dateColumns || []);
export function isDateColumn(name: string): boolean {
  return DATE_COLS.has(name);
}
const RAW_TABLES = (IDS.rawTables || []).map((t) => t.toLowerCase());

function hasRawTable(sql: string): boolean {
  const lower = sql.toLowerCase();
  return RAW_TABLES.some((t) => new RegExp("(^|[^a-z0-9_])" + t + "([^a-z0-9_]|$)").test(lower));
}

/**
 * Prisma 模型表的 DateTime 列在 PG 是 timestamp，而应用 raw SQL 传的是毫秒整数；
 * 把 "dateCol" op $n 重写为 "dateCol" op to_timestamp($n::double precision / 1000.0)。
 * raw 表（Todo/SessionExtractionState 等）的时间列是 bigint(ms)，不重写。
 */
export function rewriteDateComparisons(sql: string): string {
  if (!DATE_COLS.size) return sql;
  if (hasRawTable(sql)) return sql;
  let out = sql;
  for (const col of DATE_COLS) {
    const re = new RegExp('"' + col + '"\\s*(<=|>=|<>|!=|=|<|>)\\s*\\$(\\d+)', "g");
    // 2026-10-27 P0: `to_timestamp(ms)` 返回 timestamptz；直接与 `timestamp without time zone` 列比较时，
    //   PG 会按会话时区(Asia/Shanghai, +08)解释，导致窗口整体偏 8 小时（5h 窗口直接 0 = 假绿）。
    //   加 `AT TIME ZONE 'UTC'` 把阈值落成 **UTC 墙钟**，与列存的 UTC 墙钟同基准。
    out = out.replace(re, (_m, op, n) => '"' + col + '" ' + op + " (to_timestamp($" + n + "::double precision / 1000.0) AT TIME ZONE 'UTC')");
  }
  return out;
}

/**
 * **写入**侧的 DateTime 重写（2026-10-21，todo_1bc114be323d43219235 根因 A 的后半段）。
 *
 * 为什么必须与 rewriteDateComparisons 分开：上面那个只认 `"col" op $n` 这一种形状（**读**）。
 * 而 INSERT 的列清单与 VALUES 元组是**分开两段**、靠下标对应，UPDATE 则是 `"col" = $n`，
 * 两者都不落在比较重写器的正则里 —— 于是 script 侧（session-extract 的 insPractice 等，
 * 传的是毫秒整数）打到 PG 就是
 *   `42804 column "startedAt" is of type timestamp without time zone but expression is of type bigint`，
 * 整条 spec:session-extract-practice-first 连续红。作用面不同所以另起一支，互不覆盖。
 *
 * raw 表（Todo/SessionExtractionState 等）时间列在 PG 就是 bigint(ms)，整句跳过 —— 与
 * rewriteDateComparisons 同一道闸门，不新增例外。
 */
const BOOL_COLS = new Set(IDS.boolColumns || []);

/**
 * 按**括号配平**切分 INSERT 的 VALUES 元组（引号感知）。
 *
 * 为什么不能用 `split(",")` / 正则 `([^)]*)`：rewriteBoolValues 与 rewriteDateValues 是**串起来**跑的，
 * 内层那支会先把 `$n` 换成 `to_timestamp($n::double precision / 1000.0)` —— 里面带 `)`。
 * 于是外层再用 `[^)]*` 截断就只拿到半个元组，列数/值数对不上 -> **静默放弃整条重写**。
 * 实测就是这个坑：date 转换生效了、bool 没生效，报
 * `column "humanConfirmed" is of type boolean but expression is of type integer`，
 * 看起来像"bool 规则没写"，真因是它被 date 的产物截断了。
 *
 * 返回 null 表示"切不干净"（如字符串字面量里带逗号），调用方据此**保持原样**，绝不猜位置。
 */
function splitTopLevel(s: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let state: "normal" | "single" | "double" = "normal";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const nx = s[i + 1];
    if (state === "normal") {
      if (ch === "'") { state = "single"; cur += ch; continue; }
      if (ch === '"') { state = "double"; cur += ch; continue; }
      if (ch === "(") { depth++; cur += ch; continue; }
      if (ch === ")") { depth--; cur += ch; continue; }
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch; continue;
    }
    if (state === "single") {
      cur += ch;
      if (ch === "'" && nx === "'") { cur += nx; i++; continue; }
      if (ch === "'") state = "normal";
      continue;
    }
    cur += ch;
    if (ch === '"' && nx === '"') { cur += nx; i++; continue; }
    if (ch === '"') state = "normal";
    continue;
  }
  if (state !== "normal") return null; // 引号没闭合 -> 不可靠
  out.push(cur);
  return out;
}

/** 定位 INSERT 的列清单与 VALUES 元组区间（引号/括号感知），找不到返回 null */
function findInsertShape(sql: string): { colList: string; valStart: number; valEnd: number } | null {
  const m = /INSERT\s+INTO\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\(/i.exec(sql);
  if (!m) return null;
  // 列清单：从 '(' 开始做括号配平
  let i = m.index + m[0].length - 1;
  let depth = 0, colStart = i + 1, colEnd = -1;
  for (; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") { depth--; if (depth === 0) { colEnd = i; break; } }
  }
  if (colEnd < 0) return null;
  const rest = sql.slice(colEnd + 1);
  const vm = /^\s*VALUES\s*\(/i.exec(rest);
  if (!vm) return null;
  const valStart = colEnd + 1 + vm[0].length;   // vm[0] 以 '(' 结尾 -> +1 跳过它, 指向元组第一个字符
  // 从元组**第一个字符**开始配平：此处 depth=0，遇到的第一个 ')' 就是元组结尾
  let d2 = 0, valEnd = -1;
  for (let j = valStart; j < sql.length; j++) {
    if (sql[j] === "(") d2++;
    else if (sql[j] === ")") { if (d2 === 0) { valEnd = j; break; } d2--; }
  }
  if (valEnd < 0) return null;
  return { colList: sql.slice(colStart, colEnd), valStart, valEnd };
}

/** 用 shape 把 VALUES 元组换成新内容；列数/值数对不上就整体放弃 */
function mapInsertValues(sql: string, shape: { colList: string; valStart: number; valEnd: number } | null,
                        fn: (col: string, val: string) => string): string {
  if (!shape) return sql;
  const cols = splitTopLevel(shape.colList);
  const vals = splitTopLevel(sql.slice(shape.valStart, shape.valEnd));
  if (!cols || !vals || cols.length !== vals.length) return sql;
  const changed = vals.map((v, i) => fn(cols[i].trim().replace(/^"|"$/g, ""), v));
  return sql.slice(0, shape.valStart) + changed.join(",") + sql.slice(shape.valEnd);
}

/**
 * SQLite 用 0/1 存 boolean，PG 是真 boolean；raw SQL 里往往写成 `0` / `1` 或把 0/1 当参数传。
 * 形状与 DateTime 写入完全同构（INSERT 列清单靠下标对应 / UPDATE SET 紧跟列名），
 * 故共用同一套骨架，只是包成 `($n <> 0)` 而不是 to_timestamp(...)。
 * 实测症状: `42804 column "humanConfirmed" is of type boolean but expression is of type integer`。
 * raw 表的 0/1 列本来就是 integer，同样整句跳过。
 */
export function rewriteBoolValues(sql: string): string {
  if (!BOOL_COLS.size) return sql;
  if (hasRawTable(sql)) return sql;

  let out = sql;
  // UPDATE ... SET "col" = $n
  for (const col of BOOL_COLS) {
    const upd = new RegExp('("' + col + '")(\\s*=\\s*)(\\$\\d+)', "g");
    out = out.replace(upd, (_m, c, sep, ph) => c + sep + "(" + ph + " <> 0)");
  }
  // INSERT INTO T (...) VALUES (...) —— 括号配平切分，内层 date 已注入的 to_timestamp(...) 不再截断
  return mapInsertValues(out, findInsertShape(out), (col, v) => {
    if (!BOOL_COLS.has(col)) return v;
    const t = v.trim();
    if (/^\$\d+$/.test(t)) return v.replace(t, "(" + t + " <> 0)");
    if (t === "0") return v.replace("0", "false");
    if (t === "1") return v.replace("1", "true");
    return v;
  });
}

export function rewriteDateValues(sql: string): string {
  if (!DATE_COLS.size) return sql;
  if (hasRawTable(sql)) return sql;

  // 形状一: UPDATE ... SET "col" = $n（占位符紧跟列名）
  let out = sql;
  for (const col of DATE_COLS) {
    const upd = new RegExp('("' + col + '")(\\s*=\\s*)(\\$\\d+)', "g");
    // 写侧必须与读侧同基准：否则新写入的仍是本地墙钟，读侧按 UTC 解释 → 立刻又偏 8h。
    out = out.replace(upd, (_m, c, sep, ph) => c + sep + "(to_timestamp(" + ph + "::double precision / 1000.0) AT TIME ZONE 'UTC')");
  }

  // 形状二: INSERT INTO T (c1,...,cn) VALUES ($1,...,$n)
  //   下标对齐：第 k 个列 <-> 第 k 个占位符。切分不到就**保持原样**，绝不猜位置。
  return mapInsertValues(out, findInsertShape(out), (col, v) => {
    if (!DATE_COLS.has(col)) return v;
    const ph = v.trim();
    if (!/^\$\d+$/.test(ph)) return v;
    return v.replace(ph, "(to_timestamp(" + ph + "::double precision / 1000.0) AT TIME ZONE 'UTC')");
  });
}

/** Prisma raw（Unsafe 字符串形式）：占位符 + 标识符 + DateTime 比较 */
function rewriteInsertOrIgnore(sql: string): string {
  if (!/INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql)) return sql;
  let out = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
  const m = out.match(/;\s*$/);
  const suffix = " ON CONFLICT DO NOTHING";
  if (m && m.index !== undefined) out = out.slice(0, m.index) + suffix + ";" + out.slice(m.index + m[0].length);
  else out = out + suffix;
  return out;
}

function rewriteStrftime(sql: string): string {
  return sql.replace(/strftime\(\s*'([^']*)'\s*,\s*([^,]+?)\s*,\s*'unixepoch'\s*\)/gi, (_m: string, fmt: string, expr: string) => {
    const pgFmt = String(fmt).replace(/%Y/g, "YYYY").replace(/%m/g, "MM").replace(/%d/g, "DD")
      .replace(/%H/g, "HH24").replace(/%M/g, "MI").replace(/%S/g, "SS");
    const col = String(expr).replace(/\s*\/\s*1000\s*$/, "");
    return "to_char(" + col + ", '" + pgFmt + "')";
  });
}

function rewriteJsonExtract(sql: string): string {
  return sql.replace(/json_extract\(\s*([^,]+?)\s*,\s*'\$\.([A-Za-z0-9_]+)'\s*\)/gi,
    (_m: string, expr: string, key: string) => "(" + expr + "::jsonb->>'" + key + "')");
}

function rewriteSqliteDateTime(sql: string): string {
  let out = sql;
  // datetime('now', '-' || $n || ' days') —— 动态修饰符
  out = out.replace(/datetime\(\s*'now'\s*,\s*'-'\s*\|\|\s*(\$\d+)\s*\|\|\s*' days'\s*\)/gi,
    (_m: string, n: string) => "(now() - (" + n + " || ' days')::interval)");
  // datetime('now') / datetime('now','<mod>')
  out = out.replace(/datetime\(\s*'now'\s*\)/gi, "now()");
  out = out.replace(/datetime\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi,
    (_m: string, mod: string) => "(now() + interval '" + mod + "')");
  // datetime(expr)（无修饰符）
  out = out.replace(/datetime\(\s*([^,()]+?)\s*\)/gi, (_m: string, expr: string) => "(" + expr + "::timestamp)");
  // 列类型 datetime -> timestamp（仅 DDL；PG 没有 datetime 类型）
  if (/\bCREATE\s+TABLE\b/i.test(out)) out = out.replace(/\bdatetime\b(?!\s*\()/gi, "timestamp");
  return out;
}

function rewriteInstr(sql: string): string {
  return sql.replace(/instr\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/gi,
    (_m: string, a: string, b: string) => "strpos(" + a + ", " + b + ")");
}

/**
 * 已适配标记（2026-10-23）：网关与 prisma 客户端都会调 adaptSql，同一条 SQL 会被适配 2~3 次。
 *   多数改写幂等，但"标识符规范化"不幂等 —— 实测 evidence 被第二次改成 "Evidence"（42703）。
 *   已适配的 SQL 带此前缀，后续层看到就跳过（只剥离标记）。
 */
export const ADAPTED_SQL_MARK = "/*dialect-adapted*/ ";
export function isAdaptedSql(sql: string): boolean {
  return /^\s*\/\*dialect-adapted\*\//.test(sql);
}
export function stripAdaptedMark(sql: string): string {
  return sql.replace(/^\s*\/\*dialect-adapted\*\/\s*/, "");
}

export function adaptSql(sql: string, opts?: { identifiers?: boolean }): string {
  if (!isPgDriver()) return sql;
  // 2026-10-23: identifiers=false 用于调用方已自行给表名/列名写好引号的场景。
  //   为什么需要: 规范表是"表名优先"的全局映射 —— 列名与另一张表同名时会被误大写
  //   (实测 Todo.evidence 被写成 "Evidence" ⇒ 42703 column "Evidence" does not exist)。
  const withIds = opts?.identifiers === false ? ((s: string) => s) : quoteIdentifiers;
  return rewriteInstr(rewriteSqliteDateTime(rewriteJsonExtract(rewriteStrftime(rewriteInsertOrIgnore(rewriteBoolValues(rewriteDateValues(rewriteDateComparisons(withIds(toPgPlaceholders(sql))))))))));
}

/** Prisma raw（tagged template）：Prisma 自己处理占位符，这里只修标识符 */
export function adaptTaggedSql(sql: string): string {
  return isPgDriver() ? rewriteInstr(rewriteSqliteDateTime(quoteIdentifiers(sql))) : sql;
}
