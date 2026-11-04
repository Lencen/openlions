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
        const isFunc = sql[k] === "(" && !/^(insert|into|update|from|join|replace|table)$/i.test(prevTok);
        const lower = tok.toLowerCase();
        if (!isFunc && !KEYWORDS.has(lower) && CANON.has(lower)) {
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

export function adaptSql(sql: string): string {
  if (!isPgDriver()) return sql;
  return rewriteInstr(rewriteSqliteDateTime(rewriteJsonExtract(rewriteStrftime(rewriteInsertOrIgnore(rewriteDateComparisons(quoteIdentifiers(toPgPlaceholders(sql))))))));
}

/** Prisma raw（tagged template）：Prisma 自己处理占位符，这里只修标识符 */
export function adaptTaggedSql(sql: string): string {
  return isPgDriver() ? rewriteInstr(rewriteSqliteDateTime(quoteIdentifiers(sql))) : sql;
}
