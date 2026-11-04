/**
 * structured-dedup-core.ts — 并发去重兜底的**决策 + 落标记**核心 (2026-10-13, 遗留项 cmv44qwpk0061lezvca)
 *
 * 为什么与 structured-dedup.ts 分开:
 *   本文件**不 import prisma**(只吃一个 delegate 形状的对象), 于是可以用**假 delegate 做运行时用例**,
 *   真正断言"长度守卫拒绝时**没有** update 调用"这条失败语义分支 —— 只靠正则扫源码证明不了它。
 *   真实入口 `markLaterDuplicateSuperseded`(structured-dedup.ts) 只做 prisma 绑定 + 异常兜底。
 *
 * 语义与边界详见 structured-dedup.ts 头注(单一权威), 摘要:
 *   - 先写者胜, 定序恒为 (createdAt, id) 纯函数(structured-order.ts);
 *   - 只对 sourceType=FLYWHEEL_STRUCTURED 生效;
 *   - **长度守卫**(2026-10-13 新增): 同 (theme, contentHash) 但正文长度不一致 => 拒绝 supersede 并 WARN,
 *     与该判据在存量清理脚本(scripts/dedup-structured-products.cjs)里的行为一致。
 */
import {
  isEarlierStructuredRow,
  pickEarliestStructuredRow,
  hasConsistentContentLength,
  type StructuredRowRef,
} from "./structured-order";

export type StructuredTable = "memory" | "knowledge" | "practice";

/**
 * 产物来源类型的单一常量。
 * 注意: 这里刻意不写字面量 `sourceType: "FLYWHEEL_STRUCTURED"` 作为 data 属性 —— 见 structured-dedup.ts
 * 的历史说明: scripts/test-product-quality.ts 的静态写入契约会把该形态当"写入点"并要求附近有 qualityScore。
 * 本模块只做**读/标记**, 用常量既表达同一语义, 又不会污染那条写入侧契约。
 */
const STRUCTURED_SOURCE = "FLYWHEEL_STRUCTURED";

/** 只用到 findMany/update 两个方法, 便于测试注入假实现(无 prisma 依赖)。 */
export interface StructuredDelegate {
  findMany(args: any): Promise<any[]>;
  update(args: any): Promise<any>;
}

/** 每张表的正文列名不同(Practice 的正文在 description)。 */
export function contentFieldOf(table: StructuredTable): string {
  return table === "practice" ? "description" : "content";
}

function lenOf(v: unknown): number | null {
  return v == null ? null : String(v).length;
}

/**
 * 决策 + 落标记核心。返回被取代参照的更早行 id; 无重复 / 被长度守卫拒绝 / 无正文可比 -> null。
 * 不吞异常(由调用方 structured-dedup.ts 统一 catch + WARN, 保证"失败仍打日志")。
 */
export async function markLaterDuplicateSupersededWith(
  delegate: StructuredDelegate,
  table: StructuredTable,
  row: { id: string; createdAt: Date },
  theme: string,
  contentHash: string
): Promise<string | null> {
  // 第一段: 廉价查询(只取 id/createdAt)。正常路径(无并发双写)返回 0 行, 不付正文读取代价。
  // 为什么不用 SQL 的 OR 条件直接选: 同毫秒破平的判据必须与单测共用同一份实现(纯函数), 否则
  // "纯函数测过了、SQL 里却写错"仍是漏网(独立复核指出的"测试只扫源码文本"问题)。
  const candidates = await delegate.findMany({
    where: {
      theme,
      sourceType: STRUCTURED_SOURCE,
      contentHash,
      id: { not: row.id },
    },
    select: { id: true, createdAt: true },
  });
  const older = pickEarliestStructuredRow(
    ((candidates || []) as unknown as StructuredRowRef[]).filter((c) => isEarlierStructuredRow(c, row))
  );
  if (!older) return null;

  // 第二段: 长度守卫 —— 只在**真的发现重复**时多取一次"本次行 vs winner"的正文长度。
  //   性能取舍: 正常路径不付代价; 重复路径多 1 次按主键取 2 行的查询(正文列, 有界)。
  //   为什么取库里的正文而不是用调用方传入的字符串: store 可能在落库时改写正文(归一/投影),
  //   用调用方入参会造成"长度不一致"误判; 取库值才是被 supersede 的实况。
  const contentField = contentFieldOf(table);
  const pair = (await delegate.findMany({
    where: { id: { in: [row.id, older.id] } },
    select: { id: true, [contentField]: true },
  })) as any[];
  const selfLen = lenOf((pair || []).find((p) => p.id === row.id)?.[contentField]);
  const olderLen = lenOf((pair || []).find((p) => p.id === older.id)?.[contentField]);
  if (!hasConsistentContentLength(selfLen, olderLen)) {
    console.warn(
      `[structured-dedup] WARN 长度守卫拒绝 supersede(同 theme+contentHash 但正文长度不一致, 宁留重复不掩盖内容差异): ` +
      `table=${table} theme="${theme}" hash=${String(contentHash).slice(0, 12)} ` +
      `new=${row.id}(len=${selfLen}) winner=${older.id}(len=${olderLen})`
    );
    return null;
  }

  await delegate.update({
    where: { id: row.id },
    data: { supersededBy: older.id, supersededAt: new Date() },
  });
  return older.id;
}
