/**
 * sql-dialect.ts — SQL 方言适配（Phase 2：SQLite -> PostgreSQL）
 *
 * 两个转换（仅 MIND_DB_DRIVER=pg 时生效，SQLite 默认不变）：
 *  1) 占位符：SQLite 风格 "?" -> PostgreSQL "$1..$n"（引号/注释感知）；
 *  2) 标识符：SQLite 大小写不敏感，PG 敏感 —— 把未加引号的已知表/列名规范成带引号的原始大小写
 *     （清单来自 scripts/gen-mind-identifiers.cjs 生成的 mind-db-identifiers.json）。
 */
const IDS = require("./mind-db-identifiers.json") as { tables: string[]; columns: string[]; dateColumns?: string[]; rawTables?: string[] };

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
        // 2026-10-22 修：例外表原来含 from/join/update/table，导致 SQL 里
        //   `EXTRACT(EPOCH FROM COALESCE(a,b,c))` 的 COALESCE 被当成表名加引号
        //   → PG 报 function "COALESCE"(timestamp, timestamp, timestamp) does not exist。
        //   真正需要例外的是 INSERT INTO <表名> ( 这种"表名后跟括号"的写法，只保留 insert/into/replace。
        const isFunc = sql[k] === "(" && !/^(insert|into|replace)$/i.test(prevTok);
        const lower = tok.toLowerCase();
        // 2026-10-22：SQL 内置函数名永不加引号。仅靠"后跟 ( 且前一个词不是 from/join"判断不够——
        //   `EXTRACT(EPOCH FROM COALESCE(...))` 里 COALESCE 前一个词正是 FROM，会被误判成表名，
        //   加引号后 PG 报 function "COALESCE"(timestamp,...) does not exist。这里用白名单兜底。
        if (!isFunc && !SQL_FUNCS.has(lower) && !KEYWORDS.has(lower) && CANON.has(lower)) {
          out += '"' + CANON.get(lower) + '"';
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

/** SQL 内置函数名（小写）：这些词即使被 CANON 收录也绝不加引号 */
const SQL_FUNCS = new Set([
  "coalesce", "nullif", "greatest", "least", "count", "sum", "avg", "min", "max",
  "floor", "ceil", "ceiling", "round", "abs", "extract", "cast", "now", "current_date", "current_timestamp",
  "date_trunc", "to_char", "to_timestamp", "to_date", "interval", "length", "lower", "upper",
  "substr", "substring", "position", "strpos", "replace", "concat", "trim", "jsonb_typeof",
  "jsonb_extract_path_text", "jsonb_array_length", "json_extract_path_text", "date_part", "age",
]);

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
  // 2026-10-21: COALESCE(a,b,c) > $1 这类日期比较（Task/TaskExecution 用），同样要转 to_timestamp
  out = out.replace(
    /COALESCE\(\s*("?[A-Za-z_][A-Za-z0-9_]*"?)\s*,\s*("?[A-Za-z_][A-Za-z0-9_]*"?)\s*,\s*("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\)\s*(<=|>=|<>|!=|=|<|>)\s*\$(\d+)/gi,
    (m, a, b, c, op, n) => "COALESCE(" + a + "," + b + "," + c + ") " + op + " to_timestamp($" + n + "::double precision / 1000.0)"
  );
  // 2 参数 COALESCE(a,b) > $1（如 COALESCE(updatedAt, createdAt)）
  out = out.replace(
    /COALESCE\(\s*("?[A-Za-z_][A-Za-z0-9_]*"?)\s*,\s*("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\)\s*(<=|>=|<>|!=|=|<|>)\s*\$(\d+)/gi,
    (m, a, b, op, n) => "COALESCE(" + a + "," + b + ") " + op + " to_timestamp($" + n + "::double precision / 1000.0)"
  );
  for (const col of Array.from(DATE_COLS)) {
    const re = new RegExp('"' + col + '"\\s*(<=|>=|<>|!=|=|<|>)\\s*\\$(\\d+)', "g");
    out = out.replace(re, (_m, op, n) => '"' + col + '" ' + op + ' to_timestamp($' + n + '::double precision / 1000.0)');
  }
  return out;
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
 * 2026-10-22 修「20 条查询报错」里最常见的两类 PG 不兼容（实测 console 总览页）：
 *
 * 1) datetime(<expr>, 'unixepoch')
 *    SQLite 用毫秒时间戳 → PG 没有这个函数，会抛 "function datetime(...) does not exist"。
 *    转成 to_char(to_timestamp(<秒>), 'YYYY-MM-DD HH24:MI:SS')；<expr> 常写成 x/1000，
 *    这里把整数除法改成 /1000.0，避免 to_timestamp 收到整数秒被截断。
 *
 * 2) ROUND(<double precision>, N)
 *    PG 只有 round(double precision) 单参版本，双参只接受 numeric，会抛
 *    "function round(double precision, integer) does not exist"。统一加 ::numeric 转换。
 */
/**
 * 2026-10-22：FROM/JOIN 后面的 CamelCase 表名必须加引号。
 *   PG 会把未加引号的标识符折成小写，FROM SessionGroup 变成找 sessiongroup
 *   → relation "sessiongroup" does not exist（实测总览页最后 1 条报错）。
 *   只处理首字母大写的表名，全小写的表名保持原样。
 */
function quoteCamelTables(sql: string): string {
  // 必须排除"后跟左括号"：EXTRACT(EPOCH FROM COALESCE(...)) 里的 COALESCE 也跟在 FROM 后面，
  //   但它不是表名；加引号会变成 function "COALESCE"(...) does not exist。
  return sql.replace(/\b(FROM|JOIN)\s+([A-Z][A-Za-z0-9_]*)\b(?!["A-Za-z0-9_])(?!\s*\()/g,
    (_m: string, kw: string, table: string) => kw + ' "' + table + '"');
}

function rewritePgIncompat(sql: string): string {
  let out = sql;
  out = quoteCamelTables(out);
  out = out.replace(/datetime\(\s*([^,()]+?)\s*,\s*'unixepoch'\s*\)/gi, (_m: string, expr: string) => {
    const raw = String(expr).trim();
    // 注意：此处标识符已被 quoteIdentifiers 加过引号（如 "updatedAt"/1000），正则要允许引号
    const divided = /^("?[A-Za-z_][A-Za-z0-9_]*"?)\s*\/\s*1000$/.exec(raw);
    // 2026-10-22 二次修正：PG 里日期列本身就是 timestamp，再除 1000 会得到
    //   "operator does not exist: timestamp without time zone / numeric"（实测剩余 2 条就是这个）。
    //   所以：如果是已知日期列 → 直接 to_char；否则按毫秒时间戳处理。
    if (divided && isDateColumn(divided[1].replace(/"/g, ""))) {
      // 保留原样（可能带引号），否则 PG 会把未加引号的 camelCase 折成小写导致找不到列
      return "to_char(" + divided[1] + ", 'YYYY-MM-DD HH24:MI:SS')";
    }
    const secs = raw.replace(/\s*\/\s*1000\s*$/, "/1000.0");
    return "to_char(to_timestamp(" + secs + "), 'YYYY-MM-DD HH24:MI:SS')";
  });
  out = out.replace(/ROUND\(\s*((?:[^()]|\([^()]*\))+?)\s*,\s*(\d+)\s*\)/gi,
    (_m: string, expr: string, digits: string) => "ROUND((" + expr + ")::numeric, " + digits + ")");
  return out;
}

export function adaptSql(sql: string): string {
  if (!isPgDriver()) return sql;
  return rewritePgIncompat(rewriteInstr(rewriteSqliteDateTime(rewriteJsonExtract(rewriteStrftime(rewriteInsertOrIgnore(rewriteDateComparisons(quoteIdentifiers(toPgPlaceholders(sql)))))))));
}

/** Prisma raw（tagged template）：Prisma 自己处理占位符，这里只修标识符 */
export function adaptTaggedSql(sql: string): string {
  return isPgDriver() ? rewritePgIncompat(rewriteInstr(rewriteSqliteDateTime(quoteIdentifiers(sql)))) : sql;
}
