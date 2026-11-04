/**
 * structured-order.ts — 产物行"谁更早"的**纯函数**定序 (2026-09-14, FW-QUALITY)
 *
 * 为什么单独抽出来: 并发去重兜底的核心判据是"哪一行是先写的"。SQLite 里同一毫秒写入的两行,
 * 只比较 createdAt **无法定序**(lt 不成立 -> 两行互相看不见 -> 双双存活, 这是实测过的回归)。
 * 必须以 id 字典序破平。把这条判据抽成无副作用纯函数, 才能用**运行时用例**(而非只靠正则扫源码)
 * 覆盖"同毫秒"这个关键分支。
 *
 * winner 判据为何**只有** (createdAt, id)(2026-10-12, 遗留项收口):
 *   同组重复行由同一次 create 派生, contentHash 相同 => content 逐字一致。实测 dev.db 全历史 66 组
 *   (Memory 16 / Knowledge 40 / Practice 10): contentLen 差异 0 组、qualityScore 差异 0 组;
 *   usageCount/accessCount 差异 15 组, 但读计数是**可变**的, 以其定序会让 winner 随读次数漂移、
 *   不可复算, 并会与写路径的判定冲突。因此 contentLen/qualityScore 作判据是恒等空操作, usageCount
 *   作判据是回归 —— 三者均不采纳。contentLen 在存量清理脚本里改为**完整性守卫**(长度不一致则拒绝
 *   supersede), 见 scripts/dedup-structured-products.cjs 与
 *   docs/platform-logic/dedup-winner-criteria-verdict-2026-10-12.md。
 *
 * 2026-10-13(遗留项 cmv44qwpk0061lezvca): 上面那条 contentLen 完整性守卫此前**只落在存量清理脚本**,
 *   写路径 `structured-dedup.ts` 仍只按 (theme, contentHash) 命中就 supersede, 不做长度比对。现把
 *   同一判据抽成本文件的纯函数 `hasConsistentContentLength`, 写路径复用之(单一权威), 见
 *   docs/platform-logic/dedup-winner-criteria-verdict-2026-10-12.md 的 2026-10-13 增补。
 */
export interface StructuredRowRef {
  id: string;
  createdAt: Date;
}

/** a 是否严格早于 b: 先比 createdAt, 同毫秒再比 id 字典序(先写者 id 更小, cuid 单调)。 */
export function isEarlierStructuredRow(a: StructuredRowRef, b: StructuredRowRef): boolean {
  const ta = a.createdAt.getTime();
  const tb = b.createdAt.getTime();
  if (ta !== tb) return ta < tb;
  return String(a.id) < String(b.id);
}

/** 从候选行里选出最早的一行; 空数组返回 null。 */
export function pickEarliestStructuredRow<T extends StructuredRowRef>(rows: T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (best == null || isEarlierStructuredRow(r, best)) best = r;
  }
  return best;
}

/**
 * 长度守卫判据(纯函数, 2026-10-13, 遗留项 cmv44qwpk0061lezvca)。
 *
 * 语义: 同 (theme, contentHash) 的两行, **只有正文长度一致**才允许把其中一行标为"重复被取代"。
 *   contentHash 应当忠实代表正文; 长度不一致 => hash 未忠实代表内容(截断/错误输入/hash 碰撞),
 *   此时 supersede 会把**不同内容**当重复隐藏(审计假阴性) —— 宁留重复, 不掩盖内容差异。
 *   与存量清理脚本 scripts/dedup-structured-products.cjs 的完整性守卫**同判据**(单一权威)。
 *
 * 边界(诚实披露): 长度未知(null/undefined)时返回 true(不额外收紧), 保持既有行为 —— 避免把
 *   "取不到正文"误判成"内容不一致"而大面积拒绝去重。长度守卫不是内容全等校验: 同长度不同内容的
 *   hash 碰撞仍会漏(sha256 全 64 hex 下概率可忽略, 与存量脚本同界)。
 */
export function hasConsistentContentLength(
  aLen: number | null | undefined,
  bLen: number | null | undefined
): boolean {
  if (aLen == null || bLen == null) return true;
  return aLen === bLen;
}
