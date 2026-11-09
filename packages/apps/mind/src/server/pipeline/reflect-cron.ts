/**
 * V1.5 反思 cron 调度 — 整点扫主题, 找"距上次反思 > 1h 且产物有变化"
 * 设计: docs/lions-flywheel-engine-v2-design.md §2.2.4
 *
 * 触发频率建议: 每小时第 5 分钟 (cron: "5 * * * *")
 * 排除:
 *   - status="FAILED" (本次失败, 等下个整点再试)
 *   - 距上次反思 < 1h (避免反复触发)
 *   - 产物无变化 (不需要再反思)
 */

import { prisma } from "@/lib/prisma";
// 2026-09-01: LLM API 健康探针 (连续失败暂停反思 1h)
import { isReflectionPaused } from "./llm-health";
// FW-05（2026-11-06）：新主题独立 FIFO 配额的选择器（纯函数，可被 scripts/probes/fixture-reflect-fifo.ts 打）
import { selectThemesForRound, clampQuota } from "./reflect-theme-select";

const REFLECT_THROTTLE_HOURS = 1; // D14 拍板: 整点 cron, 距上次反思 > 1h

interface CronResult {
  scanned: number;
  triggered: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * 找需要反思的主题:
 *   1. 同 theme 产物 (Memory/Knowledge/Practice/Reflection) 最近更新时间 > 上次反思时间
 *   2. 或者从来没反思过
 *   3. 排除 status=FAILED (避免反复触发同一个 fail)
 */
export async function findThemesNeedingReflection(opts: { limit?: number; maxAgeDays?: number } = {}): Promise<string[]> {
  // 2026-09-10 修复(反思节点实效性):
  //   ① 只反思"近 maxAgeDays 天仍有产物更新"的主题 —— 否则历史一次性主题(实测 16,615 个待反思)会永久占据每轮名额;
  //   ② 每轮只取 limit 个(默认 3): 单主题现在约 5-6 个 45k token chunk, 一轮塞 20 个必然撞 cron 超时 -> 全 abort 误报 FAILED。
  const maxAgeDays = opts.maxAgeDays ?? Number(process.env.REFLECT_MAX_THEME_AGE_DAYS ?? "7");
  const limit = opts.limit ?? 3;
  // 1. 从 4 类产物表 union 所有 theme + 最新时间
  // 优化: 只取 GROUP BY theme, MAX(updatedAt)
  // FW-05（2026-11-06）：groupBy 同时取 _min.createdAt —— 这是"主题首次出现时间"，FIFO 配额要用。
  //   零额外查询：同一 GROUP BY 多取一个聚合列。
  const [memThemes, knoThemes, praThemes, refThemes] = await Promise.all([
    prisma.memory.groupBy({
      by: ["theme"],
      where: { theme: { not: null } },
      _max: { updatedAt: true },
      _min: { createdAt: true },
    }),
    prisma.knowledge.groupBy({
      by: ["theme"],
      where: { theme: { not: null } },
      _max: { updatedAt: true },
      _min: { createdAt: true },
    }),
    prisma.practice.groupBy({
      by: ["theme"],
      where: { theme: { not: null } },
      _max: { updatedAt: true },
      _min: { createdAt: true },
    }),
    prisma.reflection.groupBy({
      by: ["theme"],
      where: { theme: { not: null } },
      _max: { updatedAt: true },
      _min: { createdAt: true },
    }),
  ]);

  // 2. 合并: theme -> 最新产物时间
  const themeMaxProductAt = new Map<string, Date>();
  // FW-05：主题首次出现时间（四表 _min.createdAt 的最小值），FIFO 配额的排序键
  const themeFirstSeenAt = new Map<string, number>();
  const collect = (arr: any[]) => {
    for (const row of arr) {
      const t = row.theme;
      const ts = row._max?.updatedAt;
      if (!t || !ts) continue;
      const cur = themeMaxProductAt.get(t);
      if (!cur || ts > cur) themeMaxProductAt.set(t, ts);
      const first: Date | undefined = row._min?.createdAt;
      if (first) {
        const f = first.getTime();
        const cf = themeFirstSeenAt.get(t);
        if (cf === undefined || f < cf) themeFirstSeenAt.set(t, f);
      }
    }
  };
  collect(memThemes);
  collect(knoThemes);
  collect(praThemes);
  collect(refThemes);

  // 3. 拿所有 FlywheelReflection (最新一次反思时间)
  const lastReflections = await prisma.flywheelReflection.findMany({
    select: { theme: true, updatedAt: true, status: true },
  });
  const lastReflectionBy = new Map<string, { updatedAt: Date; status: string }>();
  for (const r of lastReflections) {
    lastReflectionBy.set(r.theme, { updatedAt: r.updatedAt, status: r.status });
  }

  // 3.5) 2026-09-18 有料优先: 一次聚合拿到窗口内各主题**产物量**(Memory 为主, 一次查询, 便宜)
  //   为什么: 实测选择器按"产物更新时间"排序 -> 选到的主题 91ms 秒 SKIP(coverage 0), 而 1693 个
  //   从未反思的活跃主题排不上队; 结构化产线 09-17 断粮也是同类病(候选与'有料'脱节)。按料量排序才对得上。
  let productCount = new Map<string, number>();
  try {
    const since = Date.now() - maxAgeDays * 86400000;
    const rows: any[] = await prisma.$queryRawUnsafe(
      "SELECT theme, COUNT(*) AS c FROM Memory WHERE theme IS NOT NULL AND createdAt >= ? GROUP BY theme ORDER BY c DESC LIMIT 800",
      since,
    );
    productCount = new Map(rows.map((r: any) => [String(r.theme), Number(r.c)]));
  } catch (e: any) {
    console.warn("[reflect-cron] 产物量统计失败, 退回按更新时间排序: " + String(e?.message || "").slice(0, 120));
  }

  // 4. 决策: 哪些 theme 需要反思
  // 排序口径(2026-09-18 修, 取代原"仅按产物更新时间降序"):
  //   ① 从未反思过 优先 —— 1693 个活跃主题从未轮到, 这是入口饿死的主因;
  //   ② 其次按窗口内**产物量**降序 —— 有料可反思的优先(避免选到没料主题秒 SKIP);
  //   ③ 最后才看新鲜度。
  const sortedThemes = Array.from(themeMaxProductAt.entries())
    .sort((a, b) => {
      const na = lastReflectionBy.has(a[0]) ? 1 : 0;
      const nb = lastReflectionBy.has(b[0]) ? 1 : 0;
      if (na !== nb) return na - nb;                                  // ① 从未反思优先
      const ca = productCount.get(a[0]) || 0, cb = productCount.get(b[0]) || 0;
      if (ca !== cb) return cb - ca;                                  // ② 有料优先
      return (b[1]?.getTime() || 0) - (a[1]?.getTime() || 0);          // ③ 再按产物新鲜度
    });

  const themesToReflect: string[] = [];
  const oneHourAgo = new Date(Date.now() - REFLECT_THROTTLE_HOURS * 3600 * 1000);
  // 同主题反思冷却(默认 24h): 防"热点主题反复占名额"导致长尾主题永远排不上队(见下方公平性修注释)
  const themeCooldownHours = Number(process.env.REFLECT_THEME_COOLDOWN_HOURS ?? "24");
  const themeCooldownAgo = new Date(Date.now() - themeCooldownHours * 3600 * 1000);

  for (const entry of sortedThemes) {
    const theme = entry[0];
    const productAt = entry[1];
    const last = lastReflectionBy.get(theme);
    if (!last) {
      // 第一次反思
      themesToReflect.push(theme);
      continue;
    }
    // 跳过 FAILED 且 1h 内的 (避免同一整点反复失败)
    // ★ P1 fix: 超过 1h 的 FAILED 允许重试 (LLM API 可能已恢复), 原代码永久跳过与注释矛盾
    if (last.status === "FAILED" && last.updatedAt > oneHourAgo) continue;
    // 2026-09-18 名额公平性修(实测: themesNeedReflect≈17885, 近 7 天活跃 2154, 而 cron 每轮只反思
    //   limit=3 -> 活跃主题要 ~120 天才轮到一次; 且原判据"距上次反思 > 1h"让最近有产物更新的主题
    //   反复挤占名额 —— 结论验证(485 条记忆)至今 0 次反思、链路诊断上次反思是 09-11)。
    //   现改为同主题在 REFLECT_THEME_COOLDOWN_HOURS(默认 24h) 内不重复反思, 把名额让给从未反思/久未反思者。
    // 2026-10-13 (round 73-E 修): 24h 同主题冷却**只对成功的反思生效**。
    //   原实现把同一条冷却无条件套在 FAILED 上, 于是第 135 行那句"FAILED 超过 1h 允许重试"
    //   成了**死代码** —— 失败尝试同样会更新 updatedAt, 放行后立刻被本条挡掉。
    //   而 llm-health.ts 头注释明确承诺"暂停到期后: FAILED 主题会被 findThemesNeedingReflection 重新捞起(补跑)",
    //   即**代码与自己的契约矛盾**。实测(2026-10-13): 当前处于 1h~24h 被冻结的失败主题 = 4 个。
    //   注: 429 失败**不消耗 token**, 所以让失败主题更早重试不会多花钱; 真正烧额度的一批仍被
    //   llm-health 的"连续 5 次失败 -> 暂停 1h"挡在外面。
    if (last.status !== "FAILED" && last.updatedAt > themeCooldownAgo) continue;
    // 产物时间 > 上次反思时间 -> 产物有变化
    if (productAt > last.updatedAt) {
      themesToReflect.push(theme);
    }
  }

  // ③ 近 N 天活跃过滤 (默认 7 天)
  const freshCutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  const fresh = themesToReflect.filter((t) => {
    const at = themeMaxProductAt.get(t);
    return at ? at.getTime() >= freshCutoff : false;
  });
  // 2026-09-18: 把"为什么没轮到"也打出来(从未反思 / 久未反思 各多少), 便于判断是饿死还是没料
  const neverReflected = fresh.filter((t) => !lastReflectionBy.get(t)).length;
  // FW-05（2026-11-06）：给"从未反思"主题独立配额 + FIFO（首次出现越早越先）。
  //   为什么：旧口径在 never 组内按"窗口内 Memory 条数"降序，Reflection-only/低料的新主题恒垫底
  //   （实测：今天 15 个 SESSION_EXTRACT 新 theme 里 mem=2 的排 412 名，570 个积压 x 10/轮 = 21h 起）。
  //   口径边界：FIFO 是最老先上，不是最新先上；它把无界饥饿变成有界等待 W=ceil(N/quota)*tick。
  //   REFLECT_NEW_THEME_QUOTA=0 -> 逐字回退旧行为（fixture ③ 断言）。
  const newThemeQuota = Number(process.env.REFLECT_NEW_THEME_QUOTA ?? "5");
  const neverSet = new Set(fresh.filter((t) => !lastReflectionBy.get(t)));
  const sel = selectThemesForRound({
    fresh,
    neverReflected: neverSet,
    firstSeenAt: themeFirstSeenAt,
    productCount,
    limit,
    quota: newThemeQuota,
  });
  console.log(`[reflect-cron] themesNeedReflect=${themesToReflect.length} (近${maxAgeDays}天活跃=${fresh.length}, 其中从未反思=${neverReflected}), total=${themeMaxProductAt.size}, limit=${limit}, 同主题冷却=${themeCooldownHours}h, quota=${clampQuota(newThemeQuota, limit)} -> 本轮取(主题/窗口内产物量/是否曾反思): ` +
    sel.picked.map((t) => t + "/" + (productCount.get(t) || 0) + "/" + (lastReflectionBy.has(t) ? "曾" : "从未")).join(" | ") +
    ` | fifo=${sel.fifoPicked.map((t) => t + "@" + new Date(themeFirstSeenAt.get(t) || 0).toISOString().slice(0, 10)).join(",")}`);
  return sel.picked;
}

// ============================================================================
// 遗留#5 (2026-09-01): autoTriggerReflection - 提取后即时反思 (快速反馈环)
//   整点 cron 是兜底; 本函数在有新产物落地后对单主题即时触发。三重冷却:
//   1. 全局 30 分钟最多 1 次; 2. 同主题 1h 内已反思则跳过; 3. 主题 24h 产物<5 条跳过
// ============================================================================
import { reflectWorker } from "./reflect";

let lastAutoTriggerAt = 0;
const AUTO_TRIGGER_GLOBAL_COOLDOWN_MS = 30 * 60 * 1000;
const AUTO_TRIGGER_THEME_COOLDOWN_MS = 60 * 60 * 1000;
const AUTO_TRIGGER_MIN_PRODUCTS = 5;

export async function autoTriggerReflection(theme: string): Promise<boolean> {
  try {
    // 2026-09-01: 健康探针 — LLM API 暂停期间不即时触发 (避免故障窗口烧额度)
    if (isReflectionPaused()) return false;
    const now = Date.now();
    if (now - lastAutoTriggerAt < AUTO_TRIGGER_GLOBAL_COOLDOWN_MS) return false;
    if (!theme) return false;
    const last = await prisma.flywheelReflection.findUnique({
      where: { theme },
      select: { updatedAt: true },
    });
    if (last && now - last.updatedAt.getTime() < AUTO_TRIGGER_THEME_COOLDOWN_MS) return false;
    const cutoff = new Date(now - 86400_000);
    const [memCnt, knoCnt] = await Promise.all([
      prisma.memory.count({ where: { theme, createdAt: { gt: cutoff } } }),
      prisma.knowledge.count({ where: { theme, createdAt: { gt: cutoff } } }),
    ]);
    if (memCnt + knoCnt < AUTO_TRIGGER_MIN_PRODUCTS) return false;
    lastAutoTriggerAt = now;
    reflectWorker(theme).catch((e) =>
      console.error(`[autoTriggerReflection] theme="${theme}" failed: ${e instanceof Error ? e.message.slice(0, 120) : e}`),
    );
    console.log(`[autoTriggerReflection] theme="${theme}" triggered (mem=${memCnt} kno=${knoCnt})`);
    return true;
  } catch (e) {
    console.warn(`[autoTriggerReflection] theme="${theme}" check failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    return false;
  }
}
