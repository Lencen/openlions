/**
 * structured-dedup.ts — FLYWHEEL_STRUCTURED 产物"并发去重兜底"的**单一权威入口** (2026-09-14, FW-QUALITY)
 *
 * 为什么存在 (实测缺陷, 非推测):
 *   三张产物表(Memory/Knowledge/Practice)的写入都是 `findFirst(同 theme+contentHash) -> create`,
 *   这两步**不是原子的**。当 cron 与 force=true 的人工触发并发(或两个执行器实例同时跑)时,
 *   两边都先 findFirst 查不到、再各自 create, 于是同一条产物被写两次。实测证据(2026-09-13 12:15:05):
 *   Knowledge 10 组 20 行、Practice 4 组 8 行同 theme+contentHash 重复且 supersededBy IS NULL;
 *   组内两行 id 相邻、createdAt 相差 1-12ms、sourceId/qualityScore 完全相同。
 *
 *   更糟的是平台自己的质量审计 `quality-audit.ts` 的 `no-duplicate-content` 不变量**只查 Memory**,
 *   所以 Knowledge/Practice 的重复对审计永远"全绿" —— 这是"监控假阴性", 会掩盖产物池劣化。
 *
 * 本模块做什么:
 *   create 之后复查 —— 若已存在**更早**的同 theme+contentHash 行, 把本行标记为被其取代(supersededBy)。
 *   语义: 先写者胜; **不删数据**(保留审计轨迹); 不变量只统计 supersededBy IS NULL, 因此可复算。
 *   定序: (createdAt, id) 字典序 —— 同一毫秒写入的两行互相看不见(lt 不成立), 必须以 id 破平,
 *   否则同毫秒的两行会双双存活(实测回归: theme='飞轮空转' 14:15:14/15 各留一对)。
 *
 * 边界(诚实披露): 本函数是**事后自愈**, 不是原子写。它把"重复永不消失"降级为"重复最多存活到 create 返回后
 *   的几毫秒"; 它不是唯一约束。要根治需给 (theme, contentHash) 建 DB 唯一索引 —— 那需要 data migration,
 *   不在本次范围, 已登记。
 *
 * 长度守卫(2026-10-13, 遗留项 cmv44qwpk0061lezvca):
 *   上面这条自愈此前只按 (theme, contentHash) 命中就 supersede, **不做长度比对**; 存量清理脚本却已有
 *   完整性守卫(scripts/dedup-structured-products.cjs)。同一语义两处不一致 -> 现在把判据抽到纯函数
 *   structured-order.ts `hasConsistentContentLength`, 并在核心 structured-dedup-core.ts 里复用:
 *   同 contentHash 但正文长度不一致 = hash 未忠实代表内容(截断/错误输入/碰撞) -> **拒绝 supersede**,
 *   打 WARN, 宁留重复也不把不同内容当重复隐藏。性能: 长度比对只在真的发现重复时才多取一次正文
 *   (正常路径 findMany 返回 0 行, 不付代价)。
 *
 * 决策核心搬到 structured-dedup-core.ts(不 import prisma)是为了能用**假 delegate 做运行时用例**,
 *   真正断言"守卫拒绝时没有 update"这条分支; 本文件只保留 prisma 绑定 + 异常兜底。
 */
import { prisma } from "@/lib/prisma";
import { isNearDuplicateContent } from "./dup-content-guard";
import {
  markLaterDuplicateSupersededWith,
  type StructuredTable,
} from "./structured-dedup-core";

export type { StructuredTable } from "./structured-dedup-core";

/**
 * 把一个刚 create 的 FLYWHEEL_STRUCTURED 产物行, 在存在更早的同 theme+contentHash 行时标记为被取代。
 * @returns 被取代参照的更早行 id; 无重复则 null(含被长度守卫拒绝: 见 structured-dedup-core.ts)。
 * 不抛异常(去重兜底失败不应影响主写入路径), 但**失败会打 WARN** —— 旧版 `catch { return null }`
 * 静默吞错, 若 update 失败则重复静默留存、无人知晓(2026-09-14 独立复核指出)。
 */
export async function markLaterDuplicateSuperseded(
  table: StructuredTable,
  row: { id: string; createdAt: Date },
  theme: string,
  contentHash: string
): Promise<string | null> {
  try {
    const delegate: any = (prisma as any)[table];
    return await markLaterDuplicateSupersededWith(delegate, table, row, theme, contentHash);
  } catch (e: any) {
    console.warn(`[structured-dedup] WARN 去重兜底失败(重复可能留存, 待下次守门发现): table=${table} id=${row.id} err=${e?.message || e}`);
    return null;
  }
}

/**
 * 2026-09-18 机制修复(人类决策「重复内容需要清理」/ 落地待办 todo_land_jvijaydsfs4s):
 *   **近重复**兜底 —— 上一个函数只认完全相同的 (theme, contentHash), 但飞轮每轮反思会让 LLM 重新措辞
 *   同一知识点 -> contentHash 不同 -> 兜底不命中。实测 Knowledge 活跃行里 128 组标题逐字相同、正文互为复述
 *   (冗余 177 行), Memory 543 / Practice 645。
 *
 *   本函数在 create **之前**查: 已存在**同标题**且正文 near-dup(见 dup-content-guard)的活行 -> 返回其 id,
 *   调用方改为 reinforce 而不是再插一行。相比"create 后再作废新行", 免去新行被 supersede 后仍被下游引用的悬挂。
 *
 *   诚实边界: 只按**标题逐字相同**取候选(刻意不用模糊标题, 避免把不同主题合错), 标题措辞漂移的重复
 *   (如 "VERIFY_AGENT_OUTPUT判定口径" vs "VERIFY_AGENT_OUTPUT 判定口径") 不在覆盖; 存量清理由
 *   scripts/land-todo_land_jvijaydsfs4s-dedup.ts 兜底。查库失败只 WARN 返回 null(退化为原行为)。
 */
export async function findNearDuplicateActiveId(
  table: StructuredTable,
  title: string | null | undefined,
  content: string
): Promise<string | null> {
  try {
    const t = String(title ?? "").trim();
    if (t.length < 4) return null;   // 标题太短不足以判同一主题 -> 不做
    const delegate: any = (prisma as any)[table];
    const contentField = table === "practice" ? "description" : "content";
    const candidates: any[] = await delegate.findMany({
      where: { title: t, supersededBy: null },
      select: { id: true, [contentField]: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    for (const c of candidates) {
      if (isNearDuplicateContent(content, String(c[contentField] ?? "")).dup) return String(c.id);
    }
    return null;
  } catch (e: any) {
    console.warn(`[structured-dedup] WARN 近重复查重失败(退化为照常新建): table=${table} title=${String(title).slice(0, 40)} err=${e?.message || e}`);
    return null;
  }
}
