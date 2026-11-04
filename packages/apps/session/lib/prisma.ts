import { PrismaClient as SqliteClient } from "../node_modules/.prisma/session-client";
import { PrismaClient as PgClient } from "../node_modules/.prisma/session-client-pg";
import { adaptSql, adaptTaggedSql, isDateColumn } from "./sql-dialect";

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

// 2026-10-21 Phase 2: 按驱动选择 client（默认 SQLite；SESSION_DB_DRIVER=pg 走 PG）。
const IS_PG_DRIVER = (process.env.SESSION_DB_DRIVER || "").toLowerCase() === "pg";
const PrismaClient = (IS_PG_DRIVER ? PgClient : SqliteClient) as typeof SqliteClient;
type PClient = InstanceType<typeof SqliteClient>;

function adaptDateParam(v: any) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v)) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return v;
}
function adaptTaggedStrings(strings: any) {
  try {
    const mapped = Array.from(strings as any).map((s: any) => adaptTaggedSql(String(s)));
    if ((strings as any).raw) (mapped as any).raw = Array.from((strings as any).raw).map((s: any) => adaptTaggedSql(String(s)));
    return mapped;
  } catch { return strings; }
}

const globalForPrisma = globalThis as unknown as { prisma: PClient | undefined };

const base = globalForPrisma.prisma ?? new PrismaClient(
  IS_PG_DRIVER ? ({ datasourceUrl: process.env.SESSION_DATABASE_URL } as any) : undefined,
);

// 2026-10-21 Phase 2: ORM 参数日期转换（$allOperations）+ raw SQL 方言适配（Proxy）。
const withDates = base.$extends({
  query: {
    $allOperations({ args, query }: any) { convertDates(args); return query(args); },
  },
}) as unknown as PClient;
const proxied = new Proxy(withDates as any, {
  get(target, prop, receiver) {
    if (prop === "$queryRawUnsafe") return (sql: string, ...p: any[]) => target.$queryRawUnsafe(adaptSql(String(sql)), ...p);
    if (prop === "$executeRawUnsafe") return (sql: string, ...p: any[]) => target.$executeRawUnsafe(adaptSql(String(sql)), ...p);
    if (prop === "$queryRaw") return (strings: any, ...v: any[]) => target.$queryRaw(adaptTaggedStrings(strings), ...v.map(adaptDateParam));
    if (prop === "$executeRaw") return (strings: any, ...v: any[]) => target.$executeRaw(adaptTaggedStrings(strings), ...v.map(adaptDateParam));
    return Reflect.get(target, prop, receiver);
  },
}) as PClient;

export const prisma: PClient = proxied;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = base;
