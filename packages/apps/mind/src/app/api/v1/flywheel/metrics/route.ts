/**
 * V1.5+V1.6+V1.7+V1.8 业务指标度量 API
 * 
 * 设计文档 §1.2 4 个核心指标:
 * 1. 重复提问率 - 近似: 同 theme 的 Memory 重复 contentHash 比例
 * 2. 回答准确率 - 近似: FlywheelReflection coverageScore 均值
 * 3. 上下文缺失提醒 - 近似: FlywheelReflection missedTopics 总数/周
 * 4. 偏好自动应用率 - 近似: ImprovingTask DONE 数/周
 * 
 * 数据源: 已有的 FlywheelReflection + ImprovingTask + Memory 表 + MetricEvent 真实埋点
 * V1.8: 优先用 MetricEvent 真实数据, 无则 fallback 近似
 * 
 * ★ epoch ms 修复 (2026-07-21): DB updatedAt/createdAt 存 epoch ms 整数,
 *   Prisma where: { gt: Date } 生成 ISO 字符串比较 -> 恒 false -> 时间过滤失效
 *   修正: 时间过滤全部改用 raw SQL + epoch ms 整数比较
 * ★ 字段名修复 (2026-07-21): repeatQuestionRate -> duplicateQuestionRate (对齐前端)
 * ★ 类型修复: 返回 number (0-1) 而非 string (带 %)
 */
import { prisma } from "@/lib/prisma";

// 2026-10-15 round-78: 本路由读**实时**库指标 + 按 Date.now() 算 7 天窗口 + 回 generatedAt。
//   冻结后不但数字不动, 连 generatedAt 都停在编译时刻(实测 2026-10-15T05:53:17Z = 13:53 那次 build),
//   而 scripts/mind-wal-orphan-check.cjs / auto-restart-mind-on-corruption.sh 把它当**库损坏金丝雀**
//   (health/db 200 但 metrics 500) -> 静态缓存让金丝雀永远 200, 掩盖库损坏。故必须动态。
export const dynamic = "force-dynamic";

// epoch ms 工具
const WEEK_MS = 7 * 24 * 3600 * 1000;

// V1.8: 查 MetricEvent 真实埋点 (表不存在则返回 null)
async function getRealMetrics(weekAgoMs: number): Promise<{
  repeatRate: number | null;
  accuracyRate: number | null;
  contextMissing: number | null;
  prefApplied: number | null;
} | null> {
  try {
    // ★ MetricEvent.createdAt 用 datetime('now') 存 ISO 字符串 (非 epoch ms)
    //   用 datetime('now', '-7 days') 比较, 不用 epoch ms
    const totalQ = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*) as c FROM MetricEvent WHERE event='question_asked' AND createdAt > datetime('now', '-7 days')`
    );
    const dupQ = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*) as c FROM (SELECT contentHash FROM MetricEvent WHERE event='question_asked' AND contentHash IS NOT NULL AND createdAt > datetime('now', '-7 days') GROUP BY contentHash HAVING COUNT(*) > 1)`
    );
    const totalF = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*) as c FROM MetricEvent WHERE event='answer_feedback' AND createdAt > datetime('now', '-7 days')`
    );
    const posF = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*) as c FROM MetricEvent WHERE event='answer_feedback' AND positive=1 AND createdAt > datetime('now', '-7 days')`
    );
    const ctxMissing = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*) as c FROM MetricEvent WHERE event='context_missing' AND createdAt > datetime('now', '-7 days')`
    );
    const prefAuto = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*) as c FROM MetricEvent WHERE event='preference_applied' AND source='auto' AND createdAt > datetime('now', '-7 days')`
    );

    const t = (r: any) => Number(r?.[0]?.c || 0);
    const totalQv = t(totalQ), dupQv = t(dupQ), totalFv = t(totalF), posFv = t(posF);

    // 如果没有任何 MetricEvent, 返回 null (fallback 到近似)
    if (totalQv === 0 && totalFv === 0) return null;

    return {
      repeatRate: totalQv > 0 ? (dupQv / totalQv) : 0,       // 0-1
      accuracyRate: totalFv > 0 ? (posFv / totalFv) : 0,      // 0-1
      contextMissing: t(ctxMissing),
      prefApplied: t(prefAuto),
    };
  } catch {
    // MetricEvent 表不存在
    return null;
  }
}

export async function GET() {
  try {
    const nowMs = Date.now();
    const weekAgoMs = nowMs - WEEK_MS;

    // 1. 重复提问率: 同 contentHash 的 Memory 占比 (无时间过滤, 全量)
    // asset-scope-exempt: 平台工程 KPI（聚合计数，不含内容）；收口需与 console admin 头同批（方案 D5）
    const totalMemories = await prisma.memory.count({
      where: { supersededBy: null }
    });
    const duplicateMemories = await prisma.memory.groupBy({
      by: ["contentHash"],
      where: {
        supersededBy: null,
        contentHash: { not: null },
      },
      _count: true,
      having: { contentHash: { _count: { gt: 1 } } },
    });
    const dupCount = duplicateMemories.reduce((sum, g) => sum + (g._count - 1), 0);
    const repeatRate = totalMemories > 0 ? (dupCount / totalMemories) : 0;  // 0-1

    // 2. 回答准确率: coverageScore 均值 (最近 7 天)
    // ★ epoch ms: updatedAt 存 epoch ms, 用 raw SQL
    const covResult = await prisma.$queryRawUnsafe<{ avgCov: number | null }[]>(
      `SELECT AVG(coverageScore) as avgCov FROM FlywheelReflection WHERE status='OK' AND updatedAt > ?`, weekAgoMs
    );
    const avgCoverage = Number(covResult?.[0]?.avgCov || 0);  // 0-1

    // 3. 上下文缺失提醒: 最近 7 天 missedTopics 总数
    // ★ epoch ms: raw SQL + JSON 解析
    const missedRows = await prisma.$queryRawUnsafe<{ missedTopics: string | null }[]>(
      `SELECT missedTopics FROM FlywheelReflection WHERE status='OK' AND updatedAt > ?`, weekAgoMs
    );
    const missedCount = missedRows.reduce((sum, r) => {
      try { return sum + (JSON.parse(r.missedTopics || "[]") as any[]).length; }
      catch { return sum; }
    }, 0);

    // 4. 偏好自动应用率: 最近 7 天 ImprovingTask DONE 数
    // ★ epoch ms: raw SQL
    const taskDoneResult = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*) as c FROM Task WHERE improvementType IS NOT NULL AND status='DONE' AND updatedAt > ?`, weekAgoMs
    );
    const improvingTasksDone = Number(taskDoneResult?.[0]?.c || 0);

    // 附加工程指标
    const totalReflections = await prisma.flywheelReflection.count();
    const okReflections = await prisma.flywheelReflection.count({ where: { status: "OK" } });
    const pendingTasks = await prisma.task.count({
      where: { improvementType: { not: null }, status: "PENDING" }
    });
    const structuredMemories = await prisma.memory.count({
      where: { sourceType: "FLYWHEEL_STRUCTURED" }
    });

    // V1.8: 优先用真实埋点数据
    const realMetrics = await getRealMetrics(weekAgoMs);

    return Response.json({
      // 4 个核心业务指标 (V1.8: 真实埋点优先, fallback 近似)
      // ★ 字段名对齐前端: duplicateQuestionRate (非 repeatQuestionRate)
      // ★ 类型: number (0-1 for rates, count for others)
      metrics: {
        duplicateQuestionRate: realMetrics ? realMetrics.repeatRate! : repeatRate,
        answerAccuracyRate: realMetrics ? realMetrics.accuracyRate! : avgCoverage,
        contextMissingAlerts: realMetrics ? realMetrics.contextMissing! : missedCount,
        preferenceAutoApplyRate: realMetrics ? realMetrics.prefApplied! : improvingTasksDone,
        source: realMetrics ? "real" : "approximate",
      },
      // 附加工程指标
      engineering: {
        totalReflections,
        okReflections,
        okRate: totalReflections > 0 ? (okReflections / totalReflections) : 0,
        pendingImprovingTasks: pendingTasks,
        structuredMemories,
        // asset-scope-exempt: 同上（主题数聚合，不含内容）
        activeThemes: await prisma.memory.groupBy({ by: ["theme"], where: { theme: { not: null }, supersededBy: null }, _count: true }).then(r => r.length),
      },
      // 趋势数据 (最近 7 天每日) -- ★ epoch ms raw SQL
      trend: await getDailyTrend(weekAgoMs, nowMs),
      generatedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ★ epoch ms: getDailyTrend 改用 raw SQL
async function getDailyTrend(weekAgoMs: number, nowMs: number) {
  // 反思趋势 (按日)
  const reflRows = await prisma.$queryRawUnsafe<{ updatedAt: number; status: string; coverageScore: number }[]>(
    `SELECT updatedAt, status, coverageScore FROM FlywheelReflection WHERE updatedAt > ? ORDER BY updatedAt ASC`, weekAgoMs
  );
  // 任务趋势 (按日)
  const taskRows = await prisma.$queryRawUnsafe<{ updatedAt: number; status: string }[]>(
    `SELECT updatedAt, status FROM Task WHERE improvementType IS NOT NULL AND updatedAt > ? ORDER BY updatedAt ASC`, weekAgoMs
  );

  // 按日聚合
  const days: Record<string, { reflections: number; ok: number; tasks: number; done: number }> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(nowMs - i * 24 * 3600 * 1000);
    const key = d.toISOString().slice(0, 10);
    days[key] = { reflections: 0, ok: 0, tasks: 0, done: 0 };
  }
  for (const r of reflRows) {
    // updatedAt 是 epoch ms 整数
    const key = new Date(Number(r.updatedAt)).toISOString().slice(0, 10);
    if (days[key]) {
      days[key].reflections++;
      if (r.status === "OK") days[key].ok++;
    }
  }
  for (const t of taskRows) {
    const key = new Date(Number(t.updatedAt)).toISOString().slice(0, 10);
    if (days[key]) {
      days[key].tasks++;
      if (t.status === "DONE") days[key].done++;
    }
  }
  return Object.entries(days).map(([date, v]) => ({ date, ...v }));
}
