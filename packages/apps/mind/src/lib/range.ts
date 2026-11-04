/**
 * range.ts — 全局时间范围(顶栏筛选)在 mind 侧的解析 (2026-10-13 round 76-BZ)
 *
 * 背景: console 顶栏的 range(1h/24h/7d/30d/all)之前只对 console 自己直查库的 5 个路由生效;
 *   mind 的数据端点**完全不认**(实测连 limit 都被忽略), 于是控制台多数页面的筛选是死的。
 *   现在 mind 归平台项目管理, 这里给出与 console `resolveRange` **同名同义**的实现, 供各端点复用。
 *
 * 约定(重要): 端点应**opt-in** —— 只有显式传了 `range` 才应用时间窗, 不传则保持原行为,
 *   以免影响其它调用方(agent / portal / 脚本)。
 */
export type RangeKey = "1h" | "24h" | "7d" | "30d" | "all";

const PRESET: Record<RangeKey, { spanMs: number | null; label: string }> = {
  "1h": { spanMs: 3600 * 1000, label: "近 1 小时" },
  "24h": { spanMs: 24 * 3600 * 1000, label: "近 24 小时" },
  "7d": { spanMs: 7 * 86400 * 1000, label: "近 7 天" },
  "30d": { spanMs: 30 * 86400 * 1000, label: "近 30 天" },
  "all": { spanMs: null, label: "全部" },
};

export interface RangeInfo { key: RangeKey; label: string; since: number }

export function isRangeKey(v: unknown): v is RangeKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PRESET, v);
}

/** 把 ?range= 解析成 { key, label, since }。非法/缺省 -> 24h(与 console 一致)。all -> since=0(不过滤)。 */
export function resolveRange(range?: string | null, now: number = Date.now()): RangeInfo {
  const key: RangeKey = isRangeKey(range) ? range : "24h";
  const p = PRESET[key];
  return { key, label: p.label, since: p.spanMs === null ? 0 : now - p.spanMs };
}

/** 从请求 URL 读 range 并解析; 未显式传 range 时返回 null(供端点做 opt-in 判断)。 */
export function rangeFromRequest(req: Request): RangeInfo | null {
  try {
    const raw = new URL(req.url).searchParams.get("range");
    return raw ? resolveRange(raw) : null;
  } catch {
    return null;
  }
}

/** 把 range key 转成 Prisma 可直接用的 since Date; all / 缺省 / 非法 -> null(不过滤)。
 *  口径**: 与认知大表快捷筛选 quick.recent7d 一致 —— 按 **createdAt**
 *  (见 src/server/lib/cognitive-quick-filter.ts: "按创建时间; 与全局筛选'近 7 天'一致")。
 */
export function rangeSince(key?: string | null, now: number = Date.now()): Date | null {
  if (!isRangeKey(key)) return null;
  const p = PRESET[key];
  return p.spanMs === null ? null : new Date(now - p.spanMs);
}