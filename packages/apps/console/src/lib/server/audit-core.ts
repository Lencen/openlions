/**
 * audit-core.ts — 审计的纯逻辑（无 IO、无框架依赖），供 writeAudit 与自测复用。
 *
 * 2026-11-09（0.4.39-08 批1）：
 *   脱敏与 diff 必须在这里统一做，**不接受调用方自定义**——
 *   "调用方记得脱敏"这类约定必然漂移（今天已经踩过多次）。
 */

/** 命中即脱敏的键名（大小写不敏感） */
export const SECRET_KEY_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL/i;

export const MASKED = "****";

/** 值级掩码：与 model-config 的 maskValue 同口径（<=8 全掩，否则首4…末4） */
export function maskValue(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return MASKED;
  return v.slice(0, 4) + "…" + v.slice(-4);
}

/**
 * 对对象里「命中 SECRET_KEY_RE 的键」做值掩码，其余原样保留。
 * 只做一层（审计对象都是扁平的 env / 配置 map）；嵌套对象递归。
 */
export function maskSecrets(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((x) => maskSecrets(x));
  if (typeof obj !== "object") return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = typeof v === "string" ? maskValue(v) : MASKED;
    } else if (v && typeof v === "object") {
      out[k] = maskSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 只保留「变更了的键」：值不同或仅一侧存在。
 * 返回 from/to 两个只含变更键的对象；没有变更时两者都为空对象。
 */
export function diffOnly(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  const b = before || {};
  const a = after || {};
  // 不用 new Set([...]) 展开：tsconfig target 低于 es2015 时报 TS2802（--downlevelIteration）
  const keys = Array.from(new Set(Object.keys(b).concat(Object.keys(a))));
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  for (const k of keys) {
    const bv = b[k];
    const av = a[k];
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    if (bv !== undefined) from[k] = bv;
    if (av !== undefined) to[k] = av;
  }
  return { from, to, keys: Object.keys(to).length ? Object.keys(to) : Object.keys(from) };
}

/** 变更键里是否含密钥键（用于 secret_masked 标记） */
export function hasSecretKey(keys: string[]): boolean {
  return (keys || []).some((k) => SECRET_KEY_RE.test(k));
}
