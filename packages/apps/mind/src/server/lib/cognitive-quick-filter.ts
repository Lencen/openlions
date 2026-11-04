// 2026-09-14 UI-7 (待办 todo_7ef17821bac447368a40): 认知大表的"常用筛选"统一口径。
//
// 背景: 记忆 7.6 万 / 知识 7 万 / 实践 5 万行, 列表原先只有排序没有常用筛选入口。
// 本模块把「高质量 / 近 7 天 / 被引用过 / 待复核」四个快捷筛选的**判定口径集中在一处**,
// 由 memory/knowledge/practice/reflection/skills 五个 list 端点共用, 避免各页各写一套漂移。
//
// 口径说明 (与 docs/platform-logic/ui7-cognitive-quick-filters-landing-2026-09-14.md 对齐):
//   高质量 highQuality     qualityScore >= 0.7 (与仪表盘"高 ≥0.7 / 中 ≥0.4 / 低 <0.4"同口径)
//   近 7 天 recent7d       createdAt >= now - 7d (按创建时间; 与全局筛选"近 7 天"一致)
//   被引用过 referenced    该表的"被检索命中"计数 > 0:
//                          Memory.accessCount / Knowledge.usageCount / Skill.totalUsageCount /
//                          Practice.reinforceCount / Reflection.reinforceCount
//                          (注: 2026-09-14 新增的 usedCount="实际采用"未登记进 Prisma schema, 本次不纳入)
//   待复核 pendingReview   Knowledge: verification IN ('PENDING_REVIEW','NEEDS_HUMAN_REVIEW') —— 平台原生复核态
//                          Skill: legacy=true 或 stale=true (无步骤存量 / 步骤失效, 待重写复核)
//                          Practice: stale=true (来源变更, 步骤待重核)
//                          Memory: 无 verification 字段 -> 质量分 < 0.4 的低质存量待人工复核
//                          Reflection: 有 actionType 但 actionConfidence < 0.6 (低置信动作待复核)
//
// 所有快捷筛选都只作用于**当前有效记录** (supersededBy IS NULL), 归档链上的旧记录不进筛选结果。

export const QUICK_FILTER_KEYS = ["highQuality", "recent7d", "referenced", "pendingReview"] as const;
export type QuickFilterKey = (typeof QUICK_FILTER_KEYS)[number];

/** 高质量阈值 (与 console /api/stats 质量分档一致) */
export const HIGH_QUALITY_MIN = 0.7;
/** 低质量阈值 (待复核兜底口径) */
export const LOW_QUALITY_MAX = 0.4;
/** "近 7 天"窗口 */
export const RECENT_DAYS = 7;

export function recent7dSince(now: number = Date.now()): Date {
  return new Date(now - RECENT_DAYS * 24 * 60 * 60 * 1000);
}

export function isQuickFilter(v: unknown): v is QuickFilterKey {
  return typeof v === "string" && (QUICK_FILTER_KEYS as readonly string[]).includes(v);
}

/** Memory: 高质量 / 近7天 / 被引用过(accessCount) / 待复核(低质) */
export function memoryQuickWhere(quick: QuickFilterKey, now: number = Date.now()): Record<string, unknown> {
  switch (quick) {
    case "highQuality":
      return { qualityScore: { gte: HIGH_QUALITY_MIN } };
    case "recent7d":
      return { createdAt: { gte: recent7dSince(now) } };
    case "referenced":
      return { accessCount: { gt: 0 } };
    case "pendingReview":
      return { qualityScore: { lt: LOW_QUALITY_MAX } };
  }
}

/** Knowledge: 高质量 / 近7天 / 被引用过(usageCount) / 待复核(verification 原生态) */
export function knowledgeQuickWhere(quick: QuickFilterKey, now: number = Date.now()): Record<string, unknown> {
  switch (quick) {
    case "highQuality":
      return { qualityScore: { gte: HIGH_QUALITY_MIN } };
    case "recent7d":
      return { createdAt: { gte: recent7dSince(now) } };
    case "referenced":
      return { usageCount: { gt: 0 } };
    case "pendingReview":
      return { verification: { in: ["PENDING_REVIEW", "NEEDS_HUMAN_REVIEW"] } };
  }
}

/** Practice: 高质量 / 近7天 / 被引用过(reinforceCount) / 待复核(stale=来源变更) */
export function practiceQuickWhere(quick: QuickFilterKey, now: number = Date.now()): Record<string, unknown> {
  switch (quick) {
    case "highQuality":
      return { qualityScore: { gte: HIGH_QUALITY_MIN } };
    case "recent7d":
      return { createdAt: { gte: recent7dSince(now) } };
    case "referenced":
      return { reinforceCount: { gt: 0 } };
    case "pendingReview":
      return { stale: true };
  }
}

/** Skill: 高质量 / 近7天 / 被引用过(totalUsageCount) / 待复核(legacy 无步骤 或 stale 失效) */
export function skillQuickWhere(quick: QuickFilterKey, now: number = Date.now()): Record<string, unknown> {
  switch (quick) {
    case "highQuality":
      return { qualityScore: { gte: HIGH_QUALITY_MIN } };
    case "recent7d":
      return { createdAt: { gte: recent7dSince(now) } };
    case "referenced":
      return { totalUsageCount: { gt: 0 } };
    case "pendingReview":
      return { OR: [{ legacy: true }, { stale: true }] };
  }
}

/**
 * Reflection 的 list 走 raw SQL (见 reflection.ts 混合时间格式兼容), 这里给出 SQL 片段。
 * createdAt 在 SQLite 里是 unix ms (INTEGER), 可直接比较。
 */
export function reflectionQuickSql(quick: QuickFilterKey, now: number = Date.now()): { sql: string; params: unknown[] } {
  switch (quick) {
    case "highQuality":
      // Reflection 无 qualityScore 字段, 调用方不应提供该筛选项; 兜底返回安全条件
      return { sql: "1=1", params: [] };
    case "recent7d":
      return { sql: "createdAt >= ?", params: [now - RECENT_DAYS * 24 * 60 * 60 * 1000] };
    case "referenced":
      return { sql: "reinforceCount > 0", params: [] };
    case "pendingReview":
      return { sql: "(actionType IS NOT NULL AND (actionConfidence IS NULL OR actionConfidence < 0.6))", params: [] };
  }
}
