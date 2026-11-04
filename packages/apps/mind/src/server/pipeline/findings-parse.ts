/**
 * findings-parse.ts — structuredFindings 归一化解析 (2026-09-10 遗留修复)
 *
 * 背景: 历史反思行存在两种存量形态 —
 *   1) 数组: [ {id,category,what,...}, ... ]              (现行 reflect.ts 写此形态)
 *   2) 信封: { picked: [...], meta: {...} }                (旧 selectTopFindings 直接序列化, 2 行存量)
 * 消费方若直接 for..of / .find() 会抛 "fs is not iterable" (曾致 reflections/daily 日结 cron 500)。
 * 本模块统一归一化为数组, 并对未知形态返回 [], 保证消费方永不因单行脏数据崩溃。
 */
export interface AnyFinding { [k: string]: any }

export function parseStructuredFindings(raw: string | null | undefined): AnyFinding[] {
  if (!raw) return [];
  let v: any;
  try { v = JSON.parse(raw); } catch { return []; }
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object");
  if (v && typeof v === "object") {
    if (Array.isArray(v.picked)) return v.picked.filter((x: any) => x && typeof x === "object");
    if (Array.isArray(v.findings)) return v.findings.filter((x: any) => x && typeof x === "object");
    if (Array.isArray(v.items)) return v.items.filter((x: any) => x && typeof x === "object");
    return [];
  }
  return [];
}

/** 是否信封形态(供数据迁移识别) */
export function isEnvelopeShape(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const t = raw.trim();
  return t.startsWith("{") && (t.includes('"picked"') || t.includes('"findings"'));
}
