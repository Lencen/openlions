/**
 * stale-aware-dedup.ts — 撤回(stale)感知的去重/存在性判定统一口径 (2026-10-25)
 *
 * 为什么存在(根因, 实测):
 *   2026-09-15 的撤回流程(knowledge-retraction.ts)给 Knowledge/Practice/Skill 写 `stale=true` +
 *   `staleReason`, supersededBy 仍为 NULL(撤回不是取代, 是"被推翻")。同批修复在**部分**去重点上
 *   加了 `stale: false` 过滤, 但绝大多数 dedup 查找点**没有**加 —— 于是:
 *     · 一条被撤回的结论, 只要 contentHash 还在库里, 后续任何"同内容是否已存在"的判定都会命中它,
 *       于是新产物**不再落库**(被撤回的结论把活路堵死), 或者 finding 被误判为"早已沉淀"而误关闭。
 *     · 反向也成立: execute-improving-task 的 CREATE_KNOWLEDGE 分支若不排除 stale, 撤回后的
 *       结论仍能挡住"该主题尚未沉淀该结论"的 finding。
 *
 * 实测影响面(平台库只读复算, 2026-10-25):
 *   Knowledge: contentHash 组 87,130 个, 其中 5,863 组**只**存在 stale 行(无活行)。
 *   Practice : contentHash 组 30,552 个, 其中 2,581 组只存在 stale 行。
 *   Skill    : contentHash 组 11,420 个, 其中    19 组只存在 stale 行。
 *   → 这 8,463 组内容哈希, 任何不过滤 stale 的 findFirst 都会**误判为"已存在"**。
 *
 * 为什么放在 SDK 层(不靠每处调用方自觉):
 *   平台既有设计原则就是"业务规则放 SDK 层"(见 Problem dedup SDK 层设计)。把"活行口径"抽成一个
 *   纯函数 + 一个 where 组装器, 所有去重点统一调用, 以后新增去重点默认就是 stale-aware 的。
 *
 * 诚实边界(重要):
 *   1) **Memory 表没有 stale 列**(见 prisma/schema.prisma: Memory 只有 supersededBy)。
 *      对 Memory 只能按 supersededBy 判活; 撤回流程只作用于 Knowledge/Practice/Skill/Reflection。
 *   2) Reflection 也没有 stale 列 -> 同样只按 supersededBy 判活。
 *   3) `stale: false` 过滤语义 = "未撤回"; `supersededBy: null` = "未被取代"。两者都要满足才算活行。
 *      只加其中一个都不够: 撤回行 supersededBy 为 NULL(只靠 supersededBy 过滤挡不住撤回),
 *      被取代行 stale 可能为 false(只靠 stale 过滤挡不住取代)。
 *   4) 本模块**不改**写入语义, 只改**读侧的存在性/去重判定**。写入侧已由 execute-improving-task
 *      的"不写 stale:false 复活撤回行"处理(见该文件 L1335 注释)。
 */

/** 有 stale 列的产物表(可按"未撤回"过滤)。 */
export type StaleAwareTable = "knowledge" | "practice" | "skill";

/** 只��� supersededBy 判活、没有 stale 列的产物表。 */
export type SupersedeOnlyTable = "memory" | "reflection";

/** 所有支持 contentHash 去重的产物表。 */
export type DedupTable = StaleAwareTable | SupersedeOnlyTable;

/** 各表是否有 stale 列(单一事实源, 避免各处硬编码写错)。 */
export const TABLES_WITH_STALE: ReadonlySet<string> = new Set<StaleAwareTable>(["knowledge", "practice", "skill"]);

/**
 * 该表是否支持"未撤回"过滤。
 *
 * ⚠️ **大小写不敏感**: 调用方有的传 Prisma 模型名(小写 "knowledge"), 有的传 SQL 表名
 *   (首字母大写 "Knowledge")。若按大小写严格比较, 传 "Knowledge" 会**静默返回 false** ->
 *   stale 过滤被悄悄跳过 -> 修复形同没做(本 harness C1 用例实测踩到过这个坑)。
 *   故统一转小写再比较。
 */
export function hasStaleColumn(table: string): boolean {
  return TABLES_WITH_STALE.has(String(table || "").toLowerCase());
}

/**
 * 组装"活行"(未撤回 + 未被取代)的 where 条件。
 *
 * @param table  产物表名
 * @param extra  调用方附加条件(theme / contentHash / id 等)
 *
 * 返回的对象可直接 spread 进 prisma.<table>.findFirst/findMany/count 的 where。
 * 对没有 stale 列的表(Memory/Reflection)只加 supersededBy: null, **不会**产生非法字段查询。
 */
export function liveRowWhere<T extends Record<string, any>>(
  table: string,
  extra: T = {} as T,
): T & { supersededBy: null } & Partial<{ stale: false }> {
  const base: Record<string, any> = { ...extra, supersededBy: null };
  if (hasStaleColumn(table)) base.stale = false;
  return base as any;
}

/**
 * 组装"活行"的原生 SQL 片段(供 $queryRawUnsafe 用)。
 *
 * @param table  产物表名(会被拼进 SQL, 只允许内部白名单内的表名 —— 见 assertSafeTableName)
 * @param cols   已有条件的数组, 每个元素形如 { sql: "theme=?", params: [x] }
 *
 * 返回 { sql, params } —— sql 以 AND (...) 包裹, 可直接拼到 WHERE 后面。
 */
export function liveRowSql(
  table: string,
  cols: Array<{ sql: string; params?: any[] }> = [],
): { sql: string; params: any[] } {
  assertSafeTableName(table);
  const parts = cols.map((c) => `(${c.sql})`);
  const params = cols.flatMap((c) => c.params ?? []);
  // 通用恒真/恒假条件, 与其他条件 AND 组合
  parts.push("supersededBy IS NULL");
  if (hasStaleColumn(table)) parts.push("COALESCE(stale,0)=0");
  return { sql: parts.join(" AND "), params };
}

/** 表名白名单 —— 防止把外部字符串拼进 SQL。 */
const SAFE_TABLE_NAMES = new Set([
  "Knowledge", "Memory", "Practice", "Skill", "Reflection",
  "knowledge", "memory", "practice", "skill", "reflection",
]);

/** 校验表名安全(只允许白名单内的产物表)。 */
export function assertSafeTableName(table: string): void {
  if (!SAFE_TABLE_NAMES.has(table)) {
    throw new Error(`stale-aware-dedup: 不允许的表名 "${table}"`);
  }
}

/**
 * 人类可读的活行口径说明, 供 evidenceRef / notes 里写清楚"这次判定排除了什么"。
 */
export function liveRowClauseText(table: string): string {
  return hasStaleColumn(table)
    ? "supersededBy IS NULL AND COALESCE(stale,0)=0"
    : "supersededBy IS NULL";
}
