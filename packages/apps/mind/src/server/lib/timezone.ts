/**
 * 时区工具 - 北京时间 (Asia/Shanghai, UTC+8)
 * 所有日期存储使用 UTC，显示使用北京时间
 */

const TIMEZONE = "Asia/Shanghai";

/**
 * 获取当前北京时间 Date 对象
 */
export function now(): Date {
  // 返回本地时区的"现在"，但在比较/存储时用 UTC
  return new Date();
}

/**
 * 获取北京时间 ISO 字符串 (格式: 2026-05-26)
 */
export function todayBeijingStr(): string {
  return new Date().toLocaleString("zh-CN", { timeZone: TIMEZONE }).split(" ")[0];
}

/**
 * 将 Date 转换为北京时间字符串
 */
export function toBeijingStr(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: TIMEZONE });
}

/**
 * 获取北京时间当天起始 UTC 时间
 * 例如北京时间 2026-05-26 00:00:00 -> UTC 2026-05-25T16:00:00.000Z
 */
export function startOfDayBeijing(): Date {
  const [year, month, day] = todayBeijingStr().split("-").map(Number);
  const beijing = new Date(year, month - 1, day, 0, 0, 0, 0);
  return beijing;
}

/**
 * 获取北京时间当天结束 UTC 时间
 * 例如北京时间 2026-05-26 23:59:59.999 -> UTC 2026-05-27T15:59:59.999Z
 */
export function endOfDayBeijing(): Date {
  const [year, month, day] = todayBeijingStr().split("-").map(Number);
  const beijing = new Date(year, month - 1, day, 23, 59, 59, 999);
  return beijing;
}

/**
 * 获取昨天北京时间日期字符串
 */
export function yesterdayBeijingStr(): string {
  // Get current Beijing date by parsing the locale string
  const now = new Date();
  const beijingNow = new Date(now.toLocaleString("zh-CN", { timeZone: TIMEZONE }));
  const [year, month, day] = [beijingNow.getFullYear(), beijingNow.getMonth(), beijingNow.getDate()];
  const yesterday = new Date(year, month, day - 1);
  return `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
}

/**
 * 格式化日期为 YYYY-MM-DD (北京时间)
 */
export function formatDate(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: TIMEZONE }).split(" ")[0];
}

/**
 * 解析北京时间 YYYY-MM-DD 字符串为 UTC Date
 */
export function parseBeijingDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  // 北京时间当天 00:00 = UTC 前一天 16:00
  return new Date(Date.UTC(year, month - 1, day - 1, 16, 0, 0, 0));
}