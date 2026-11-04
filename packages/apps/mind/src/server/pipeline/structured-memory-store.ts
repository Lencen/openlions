/**
 * V1.7 structured-memory-store — FLYWHEEL_STRUCTURED 记忆查询/统计 helper
 * 设计: docs/lions-flywheel-v17-implementation-design.md §3
 *
 * 纯查询层, 不写. 让 API route 调用, 避免在 route.ts 直接操作 Prisma.
 */
import { prisma } from "../../lib/prisma";

export async function queryStructuredMemories(
  theme: string,
  opts: { limit?: number; offset?: number; scope?: Record<string, unknown> } = {}
): Promise<{ items: any[]; total: number }> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const offset = opts.offset ?? 0;
  // 2026-10-23 R2-c: 归属过滤（由调用方按请求身份算好传入，本层不认身份）
  const scope = opts.scope && Object.keys(opts.scope).length ? { AND: [opts.scope] } : {};
  const [items, total] = await Promise.all([
    prisma.memory.findMany({
      where: { theme, sourceType: "FLYWHEEL_STRUCTURED", ...scope },
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true, content: true, title: true, theme: true,
        contentHash: true, supersededBy: true, supersededAt: true,
        reinforceCount: true, tags: true, importance: true,
        createdAt: true, updatedAt: true,
      },
    }),
    prisma.memory.count({
      where: { theme, sourceType: "FLYWHEEL_STRUCTURED", ...scope },
    }),
  ]);
  return { items, total };
}

export async function countStructuredByTheme(): Promise<Array<{ theme: string; count: number }>> {
  const groups = await prisma.memory.groupBy({
    by: ["theme"],
    where: { sourceType: "FLYWHEEL_STRUCTURED" },
    _count: { id: true },
  });
  return groups.map(g => ({ theme: g.theme ?? "(unknown)", count: g._count.id }));
}

export async function findUnstructuredThemes(limit = 20): Promise<string[]> {
  // 找有 FlywheelReflection 但没结构化的 theme
  const reflections = await prisma.flywheelReflection.findMany({
    where: { status: "OK" },
    select: { theme: true },
  });
  const themesWithReflection = reflections
    .map(r => r.theme)
    .filter(t => t && !/^(TEST-|QA-|test|__)/i.test(t) && !/test/i.test(t));
  if (themesWithReflection.length === 0) return [];

  const structuredGroups = await prisma.memory.groupBy({
    by: ["theme"],
    where: { sourceType: "FLYWHEEL_STRUCTURED", theme: { in: themesWithReflection } },
  });
  const structuredThemes = new Set(structuredGroups.map(g => g.theme).filter(Boolean));

  // 2026-09-17 修复(实测: 结构化产线 09-10 后断粮, FW-QUALITY/GROW/EVIDENCE/EXTRACT 指标全 MISSING):
  //   原实现把"已结构化过的 theme"整体排除, 导致 structured-cron 里 09-11 设计的
  //   "已结构化主题走 7 天增量整理"永远无法触发(死代码), 存量吃完后产线断粮。
  //   现改为: 从未结构化的优先(新鲜全量), 已结构化的排后做 7 天增量(24h job 锁与碎片数=0 跳过保证成本可控)。
  const neverStructured = themesWithReflection.filter(t => !structuredThemes.has(t));
  const everStructuredList = themesWithReflection.filter(t => structuredThemes.has(t));
  const candidates = [...neverStructured, ...everStructuredList];

  // 2026-09-17 修(实测: 结构化产线 09-14 后断粮, FW-* 指标全 MISSING):
  //   候选池里 355 个"从未结构化"主题绝大多数碎片为 0(每次 SKIP), 而碎片充足的业务主题
  //   (近 7 天: 结论验证 440 / 项目架构 315 / 链路诊断 238 / 数据管理 192 …)因 limit=5
  //   排在后面**永远轮不到** -> 产线静默断粮。现按"近 7 天碎片数"降序排序候选, 有料的先做;
  //   碎片为 0 的排最后(7 天无碎片冷却仍兜底, 不会反复空转)。
  let fragCount = new Map<string, number>();
  try {
    // 2026-09-17 修: 原 Prisma groupBy(by theme + theme IN 358 个 + _count._all) 实测**直接抛错**
    //   且被 catch 静默吞掉(fragStats=0) -> 排序退化为原顺序 -> 永远只扫 DAILY·2026-09-0x。
    //   改用 $queryRaw 全表按 theme 聚合, 再在内存里按候选集过滤: 无 IN 参数上限, 也更快。
    const rows = await prisma.$queryRaw<Array<{ theme: string | null; c: bigint | number }>>`
      SELECT theme, COUNT(*) AS c FROM Memory
      WHERE createdAt >= ${Date.now() - 7 * 86400000} AND theme IS NOT NULL
      GROUP BY theme`;
    const candidateSet = new Set(candidates);
    fragCount = new Map(
      rows
        .filter(r => r.theme && candidateSet.has(String(r.theme)))
        .map(r => [String(r.theme), Number(r.c)]),
    );
  } catch (err: any) {
    console.warn(`[structured-memory-store:V1.7] fragment stats failed: name=${err?.name} code=${err?.code} msg=${err?.message} str=${String(err).slice(0, 300)}`);
  }
  // 2026-09-21 根因修复(8 维审视): 原 comparator 只按碎片数降序排序**拼接后**的候选数组,
  //   "从未结构化优先"的注释意图被 sort 破坏 —— 数据管理(844 碎片)/其他(374)/任务管理(296) 这些
  //   已结构化的大主题恒排最前, 而 90s cron 超时永远跑不完它们 -> 每轮选同一批主题死锁, 从未结构化
  //   的小主题(能跑完的)反而永远轮不到(实测 09-19~09-21 结构化产线断粮的根因之一)。
  //   修: 组内排序 —— 从未结构化整组在前(组内按碎片数降序), 已结构化整组在后。
  const ordered = candidates
    .sort((a, b) => {
      const na = structuredThemes.has(a) ? 1 : 0;
      const nb = structuredThemes.has(b) ? 1 : 0;
      if (na !== nb) return na - nb;                       // 从未结构化优先
      return (fragCount.get(b) || 0) - (fragCount.get(a) || 0);  // 同组内碎片数降序(有料先做)
    });
  console.log(
    `[structured-memory-store:V1.7] candidates=${candidates.length} fragStats=${fragCount.size} ` +
    `top=${ordered.slice(0, limit).map(t => `${t}(${fragCount.get(t) || 0})`).join(" | ")}`
  );
  return ordered.slice(0, limit);
}
