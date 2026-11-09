/**
 * reflect-theme-select.ts —— 反思主题的"本轮取谁"纯函数（FW-05，2026-11-06）
 *
 * 为什么单独抽出来：
 *   原来的顺序完全内联在 reflect-cron.ts 的循环里，没法在不连库的情况下证明"新主题会不会被饿死"。
 *   抽成纯函数后，scripts/probes/fixture-reflect-fifo.cjs 可以注入夹具，直接断言：
 *     · 旧口径下 target 排到 601 名（> limit=10）-> 永远取不到；
 *     · 新口径（quota>0）下 target 进 fifo 段前 K 名 -> 一定被取到；
 *     · quota=0 时输出与旧口径逐字相同（可回退证明）。
 *
 * 口径（与 reflect-cron.ts 保持一致，改那边必须同步改这边）：
 *   fresh  = 已通过"近 N 天活跃 / 冷却 / 产物有变化 / FAILED 1h 后重试"过滤的主题，且按旧次序排好
 *            （①从未反思优先 ②窗口内 Memory 条数降序 ③产物 updatedAt 降序）。
 *   fifo   = fresh 里的"从未反思"主题，按 themeFirstSeenAt 升序（首次出现越早越先），
 *            并列时按 productCount 降序、theme 字典序稳定。
 *   picked = 先取 fifo 前 quota 个，再按 fresh 原序补满 limit。
 *   quota=0 -> fifo 段为空，picked = fresh.slice(0, limit)，与旧代码逐字一致。
 */
export interface SelectInput {
  fresh: string[];
  neverReflected: Set<string>;
  firstSeenAt: Map<string, number>;
  productCount: Map<string, number>;
  limit: number;
  quota: number;
}

export interface SelectResult {
  picked: string[];
  fifoPicked: string[];
  legacyPicked: string[];
}

export function clampQuota(quota: number, limit: number): number {
  if (!Number.isFinite(quota)) return 0;
  const q = Math.trunc(quota);
  if (q <= 0) return 0;
  return Math.min(q, Math.max(0, limit - 1));
}

export function selectThemesForRound(input: SelectInput): SelectResult {
  const limit = Math.max(0, Math.trunc(input.limit));
  const quota = clampQuota(input.quota, limit);
  const legacyPicked = input.fresh.slice(0, limit);
  if (quota === 0) return { picked: legacyPicked.slice(), fifoPicked: [], legacyPicked };

  const fifo = input.fresh
    .filter((t) => input.neverReflected.has(t))
    .sort((a, b) => {
      const fa = input.firstSeenAt.get(a) ?? Number.MAX_SAFE_INTEGER;
      const fb = input.firstSeenAt.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (fa !== fb) return fa - fb;
      const ca = input.productCount.get(a) ?? 0;
      const cb = input.productCount.get(b) ?? 0;
      if (ca !== cb) return cb - ca;
      return a < b ? -1 : a > b ? 1 : 0;
    });

  const picked: string[] = [];
  const fifoPicked: string[] = [];
  for (const t of fifo) {
    if (picked.length >= quota) break;
    picked.push(t);
    fifoPicked.push(t);
  }
  const taken = new Set(picked);
  for (const t of input.fresh) {
    if (picked.length >= limit) break;
    if (taken.has(t)) continue;
    picked.push(t);
  }
  return { picked, fifoPicked, legacyPicked };
}
