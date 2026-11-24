/**
 * todo-time.ts — Todo 时间字段的读侧守卫（2026-11-13 P0 数据准确）
 *
 * 背景：实测 67 条 Todo.updatedAt 被写成 **epoch 纳秒**（如 1794521907547000000），
 *   /api/v1/flywheel/todos 里 new Date(Number(x)).toISOString() 抛 "Invalid time value" -> 整页 500；
 *   console BFF 把错误降级成 {ok:false,count:0,rows:[]}，页面显示「未完成 0」= **0 冒充实数**。
 *
 * 口径：非法时间**明确报错**（带 id/字段/原值），不静默跳过、不兜底成 0/空。
 *   数据已一次性清洗（ns -> ms，67 行，审计 action=todo.data_repair/updatedAt_ns_to_ms）；
 *   本守卫防止再犯。
 */

/** JS Date 可表示的最大毫秒（8.64e15）；超过即非法。 */
export const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** 合理下界：2020-01-01（排除 0/负数/秒级误写）。 */
export const MIN_EPOCH_MS = 1_577_836_800_000;

export function toIsoOrThrow(id: string, field: string, raw: unknown): string | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_EPOCH_MS || n > MAX_EPOCH_MS) {
    throw new Error("invalid_timestamp:" + field + ":" + String(id) + "=" + String(raw).slice(0, 40));
  }
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) {
    throw new Error("invalid_timestamp:" + field + ":" + String(id) + "=" + String(raw).slice(0, 40));
  }
  return d.toISOString();
}
