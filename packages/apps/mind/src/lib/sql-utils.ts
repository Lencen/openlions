/**
 * D-20 (2026-09-07): SQLite raw query 字符串参数统一转义
 *
 * 背景: Prisma 5.22 的 $queryRaw/$executeRaw tag-template 参数化已可用
 *   (agent.ts recordAudit 的 $executeRaw tag-template 已实证可写 AuditLog),
 *   但大量历史 raw query 用字符串拼接 + 手动转义 (global-organizer 注释记载的是旧版 bug)。
 *
 * 收口策略: 新代码一律优先 tag-template 参数化; 存量拼接处若传字符串参数,
 *   统一经本 helper 转义 (单引号翻倍), 不再各文件手写 replace 正则。
 */
export function sqlStr(v: unknown): string {
  if (v == null) return "NULL";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return "'" + s.replace(/'/g, "''") + "'";
}

export function sqlNum(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? String(n) : "NULL";
}
