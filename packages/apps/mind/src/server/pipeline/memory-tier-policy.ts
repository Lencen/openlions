// memory-tier-policy.ts — 记忆分层策略（B2）。纯函数，便于单测。
// 目标：常驻(HOT) / 默认(WARM) / 归档(COLD)，**晋升 + 降级**都给判据；
// 仅凭 updatedAt 的旧实现（tier-decay.py）只能降级，HOT 会"名存实亡"（历史实测 HOT 占 41%）。
export type Tier = "HOT" | "WARM" | "COLD";
export interface TierRow {
  id: string; tier: string;
  accessCount?: number | null; lastAccessed?: number | Date | null;
  updatedAt?: number | Date | null; createdAt?: number | Date | null;
  importance?: number | null;
}
export interface TierOpts { hotMs?: number; coldMs?: number; hotAccess?: number; warmAccess?: number; }

const DAY = 86400000;
const ms = (v: number | Date | null | undefined): number | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const n = Number(v); return Number.isFinite(n) ? n : null;
};

export function decideTier(row: TierRow, now: number, o: TierOpts = {}): Tier {
  const hotMs = o.hotMs ?? 7 * DAY;
  const coldMs = o.coldMs ?? 30 * DAY;
  const hotAccess = o.hotAccess ?? 5;
  const warmAccess = o.warmAccess ?? 1;
  const access = Number(row.accessCount ?? 0);
  const last = ms(row.lastAccessed);
  const upd = ms(row.updatedAt) ?? ms(row.createdAt) ?? 0;
  if (access >= hotAccess && last != null && now - last <= hotMs) return "HOT";
  if (access >= warmAccess && last != null && now - last <= coldMs) return "WARM";
  if (now - upd > coldMs && Number(row.importance ?? 0.5) < 0.5) return "COLD";
  return (String(row.tier || "WARM").toUpperCase() as Tier);
}

export function planTierChanges(rows: TierRow[], now: number, o: TierOpts = {}) {
  const promote: Array<{ id: string; from: string; to: Tier }> = [];
  const demote: Array<{ id: string; from: string; to: Tier }> = [];
  let unchanged = 0;
  for (const r of rows) {
    const to = decideTier(r, now, o);
    const from = String(r.tier || "WARM").toUpperCase();
    if (to === from) { unchanged++; continue; }
    const rank = (t: string) => (t === "HOT" ? 2 : t === "WARM" ? 1 : 0);
    (rank(to) > rank(from) ? promote : demote).push({ id: r.id, from, to });
  }
  return { promote, demote, unchanged };
}
