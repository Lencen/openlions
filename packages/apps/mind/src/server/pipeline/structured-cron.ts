/**
 * V1.7 structured-cron — 批量跑未结构化的 theme
 * 设计: docs/lions-flywheel-v17-implementation-design.md §4.3
 *
 * 触发频率建议: 每小时第 25 分钟 (cron: "25 * * * *", 在改进 cron 之后)
 *
 * 反思 cron ("5 * * * *") → 写 FlywheelReflection
 * 改进 cron ("15 * * * *") → 执行 PENDING ImprovingTask
 * 结构化 cron ("25 * * * *") → 反向整理碎片 (V1.7 新增)
 */
import { structureFragments } from "./structure-fragments";
import { findUnstructuredThemes } from "./structured-memory-store";
import { prisma } from "@/lib/prisma";
// 2026-10-25 撤回流程补漏: 存在性判定统一走"活行口径"(未被取代)
import { liveRowWhere } from "./stale-aware-dedup";

/**
 * 主题归并: 处理完一个 theme 后, 更新 MemoryTopic 统计 + bestMemoryId
 * 同主题低质量 Memory (qualityScore < 0.3 且有更高质量的) 标 supersededBy
 */
async function updateTopicStats(theme: string): Promise<{ merged: number; updated: boolean }> {
  // 查该主题所有活跃 Memory
  const activeMems = await prisma.memory.findMany({
    where: { theme, supersededBy: null },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
    select: { id: true, importance: true, qualityScore: true, content: true, summary: true },
  });

  if (activeMems.length === 0) return { merged: 0, updated: false };

  // 最高质量的是 best
  const best = activeMems[0];
  let merged = 0;

  // 同主题 qualityScore < 0.3 且有更高质量的 -> 标 superseded
  if (activeMems.length > 1) {
    for (const m of activeMems.slice(1)) {
      if ((m.qualityScore ?? 0) < 0.3 && (best.qualityScore ?? 0) > (m.qualityScore ?? 0)) {
        await prisma.memory.update({
          where: { id: m.id },
          data: { supersededBy: best.id },
        }).catch(() => {});
        merged++;
      }
    }
  }

  // 更新 MemoryTopic
  const totalCount = await prisma.memory.count({ where: { theme } });
  const activeCount = totalCount - merged;
  const topic = await prisma.memoryTopic.findFirst({ where: { name: theme } });
  if (topic) {
    await prisma.memoryTopic.update({
      where: { id: topic.id },
      data: {
        memoryCount: totalCount,
        activeCount,
        bestMemoryId: best.id,
        updatedAt: new Date(),
      },
    }).catch(() => {});
  } else {
    // 创建新 topic
    await prisma.memoryTopic.create({
      data: {
        id: `topic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: theme,
        memoryCount: totalCount,
        activeCount,
        bestMemoryId: best.id,
      },
    }).catch(() => {});
  }

  return { merged, updated: true };
}

export interface StructuredCronResult {
  scanned: number;
  executed: number;
  skipped: number;
  failed: number;
  byTheme: Record<string, string>;  // theme → status
  durationMs: number;
}

export async function runStructuredCron(opts: {
  limit?: number;
  actor?: string;
  themes?: string[];  // 强制指定 theme 列表 (测试隔离用)
  signal?: AbortSignal;  // P0-3: 超时由 route 层 withCronTimeout 注入
} = {}): Promise<StructuredCronResult> {
  const t0 = Date.now();
  const limit = opts.limit ?? 5;
  const actor = opts.actor ?? "flywheel:v1.7-cron";
  const signal = opts.signal;

  const themes = opts.themes ?? (await findUnstructuredThemes(limit));
  console.log(`[structured-cron:V1.7] scanned themes=${themes.length} (limit=${limit}${opts.themes ? ' forced' : ''})`);

  let executed = 0, skipped = 0, failed = 0;
  const byTheme: Record<string, string> = {};

  for (const theme of themes) {
    // P0-3: route 层 timeout 触发后立即跳出循环, 不再启动新 LLM 调用
    if (signal?.aborted) {
      console.warn(`[structured-cron:V1.7] signal aborted at theme="${theme}", break`);
      byTheme[theme] = "ABORTED";
      failed++;
      continue;
    }
    try {
      // 2026-09-11 第 26 轮修(实测缺陷): 原来固定 lookbackDays=7, 于是**从未结构化过**的 theme 若产物都早于 7 天,
      //   就被判"碎片数=0"永远跳过 —— 首次结构化被窗口挡住。
      //   实测: 27 个待结构化 theme 共有 2,371 条产物(项目结构 512 / 链路诊断 500 / 项目架构 448 …),
      //   但全部创建于 7 天以前 -> 全部 SKIPPED -> 结构化产线再无输出, FW-QUALITY 因此长期无数据。
      //   修: 已结构化过的 theme 仍用 7 天(增量整理); **从未结构化过的用首次 lookback**(默认 90 天, 可配)。
      // 2026-10-25 撤回流程补漏: "该主题曾被结构化"的存在性判定只认活行(未被取代)。
      const everStructured = await prisma.memory.findFirst({
        where: liveRowWhere("memory", { theme, sourceType: "FLYWHEEL_STRUCTURED" }),
        select: { id: true },
      });
      const lookbackDays = everStructured ? 7 : Number(process.env.STRUCTURE_FIRST_LOOKBACK_DAYS ?? 90);
      const result = await structureFragments({ theme, actor, lookbackDays });
      byTheme[theme] = result.status;
      if (result.status === "OK") {
        executed++;
        // 主题归并: 更新 MemoryTopic + supersede 低质量
        const mergeResult = await updateTopicStats(theme);
        console.log(`[structured-cron:V1.7] topic merge for "${theme}": ${mergeResult.merged} superseded`);
      }
      else if (result.status === "SKIPPED") skipped++;
      else failed++;
    } catch (err: any) {
      console.error(`[structured-cron:V1.7] theme="${theme}" err: ${err.message}`);
      byTheme[theme] = "FAILED";
      failed++;
    }
  }

  const durationMs = Date.now() - t0;
  const result: StructuredCronResult = {
    scanned: themes.length,
    executed, skipped, failed,
    byTheme, durationMs,
  };
  console.log(
    `[structured-cron:V1.7] END scanned=${result.scanned} executed=${executed} ` +
    `skipped=${skipped} failed=${failed} duration=${durationMs}ms`
  );
  return result;
}
