/**
 * 时区工具 - 北京时间 (Asia/Shanghai, UTC+8)
 * 所有日期显示使用北京时间，存储使用 UTC
 */

const TIMEZONE = "Asia/Shanghai";

/**
 * 获取当前北京时间 Date 对象
 */
export function now(): Date {
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
 * 格式化日期为 YYYY-MM-DD (北京时间)
 */
export function formatDate(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: TIMEZONE }).split(" ")[0];
}

/**
 * 格式化日期为 YYYY-MM-DD HH:mm:ss (北京时间)
 */
export function formatDateTime(date: Date): string {
  return date.toLocaleString("zh-CN", { timeZone: TIMEZONE, hour12: false });
}