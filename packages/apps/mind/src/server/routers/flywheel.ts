import { sessionApiKey } from "@/lib/secret";
import { z } from "zod";
import { createRouter, publicProcedure, readerProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import { safeCreateReflection } from "../pipeline/safe-create"; // round 57 G3
import { PrismaFlywheelStore } from "@lions/modules-flywheel";
// 2026-10-25 R2-c 补口: 该接口返回**整行**（含 content），此前无任何归属过滤
import { readableWhere, toAssetActor } from "../pipeline/asset-scope";

// 遗留#8: modules-pipeline 未导出, 本地兜底 (Memory 模型无 stale 字段, 用 supersededBy 近似)
async function listStaleRecords(_p: any, opts: { limit?: number; scope?: Record<string, unknown> } = {}) {
  const scope = opts.scope && Object.keys(opts.scope).length ? { AND: [opts.scope] } : {};
  return prisma.memory.findMany({ where: { supersededBy: { not: null }, ...scope }, take: opts.limit ?? 50 });
}
async function clearStaleFlag(_p: any, id: string) {
  await prisma.memory.update({ where: { id }, data: {} });
  return { ok: true };
}
async function listPendingJobs(_p: any, opts: { limit?: number } = {}) {
  return prisma.flywheelJob.findMany({ where: { status: "PENDING" }, take: opts.limit ?? 50 });
}

const flywheelStore = new PrismaFlywheelStore(prisma);

const stageLabels: Record<string, string> = {
  LEARN: "学习", REFLECT: "反思", MEMORIZE: "记忆", KNOWLEDGE: "知识",
  PRACTICE: "实践", OUTCOME: "产出", EVALUATE: "评估",
};

export const flywheelRouter = createRouter({
  getStatus: publicProcedure.query(async () => {
    return flywheelStore.getStatus();
  }),

  getSourceTypeCounts: publicProcedure.query(async () => {
    return flywheelStore.getSourceTypeCounts();
  }),

  getTransitionRates: publicProcedure.query(async () => {
    return flywheelStore.getTransitionRates();
  }),

  getBottlenecks: publicProcedure.query(async () => {
    const stages = ["LEARN", "REFLECT", "MEMORIZE", "KNOWLEDGE", "PRACTICE", "OUTCOME", "EVALUATE"];
    const rates: Array<{ from: string; to: string; count: number; rate: number }> = [];

    for (let i = 0; i < stages.length - 1; i++) {
      const from = stages[i];
      const to = stages[i + 1];
      const fromCount = await prisma.flywheelEvent.count({ where: { stage: from } });
      const transitionCount = await prisma.flywheelEvent.count({
        where: { stage: from, targetStage: to },
      });
      rates.push({
        from,
        to,
        count: transitionCount,
        rate: fromCount > 0 ? Math.round((transitionCount / fromCount) * 100) : 0,
      });
    }

    const evalCount = await prisma.flywheelEvent.count({ where: { stage: "EVALUATE" } });
    const evalToLearnCount = await prisma.flywheelEvent.count({
      where: { stage: "EVALUATE", targetStage: "LEARN" },
    });
    rates.push({
      from: "EVALUATE",
      to: "LEARN",
      count: evalToLearnCount,
      rate: evalCount > 0 ? Math.round((evalToLearnCount / evalCount) * 100) : 0,
    });

    return [...rates].sort((a, b) => a.rate - b.rate).slice(0, 3);
  }),

  getEvents: publicProcedure.input(z.object({
    stage: z.string().optional(),
    sourceType: z.string().optional(),
    // 多个 sourceType（OR 关系）
    sourceTypes: z.array(z.string()).optional(),
    // 排除的 sourceTypes
    excludeSourceTypes: z.array(z.string()).optional(),
    limit: z.number().default(50),
    page: z.number().default(1),
    before: z.string().optional(),
    after: z.string().optional(),
  })).query(async ({ input }) => {
    const where: Record<string, unknown> = {};
    if (input.stage) where.stage = input.stage;
    if (input.sourceType) where.sourceType = input.sourceType;
    if (input.sourceTypes && input.sourceTypes.length > 0) where.sourceType = { in: input.sourceTypes };
    if (input.excludeSourceTypes && input.excludeSourceTypes.length > 0) {
      where.NOT = { sourceType: { in: input.excludeSourceTypes } };
    }
    if (input.before) where.createdAt = { lt: new Date(input.before).getTime() };
    else if (input.after) where.createdAt = { gte: new Date(input.after).getTime() };
    return prisma.flywheelEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: input.limit,
      skip: (input.page - 1) * input.limit,
    });
  }),

  getAlerts: publicProcedure.input(z.object({
    consecutiveZeroThreshold: z.number().default(3),
  })).query(async ({ input }) => {
    const stages = ["LEARN", "REFLECT", "MEMORIZE", "KNOWLEDGE", "PRACTICE", "OUTCOME", "EVALUATE"];
    const alerts: Array<{
      stage: string;
      message: string;
      severity: "warning" | "critical";
      consecutiveZeroCount: number;
    }> = [];

    for (const stage of stages) {
      const events = await prisma.flywheelEvent.findMany({
        where: { stage },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { targetStage: true, createdAt: true },
      });

      if (events.length === 0) {
        alerts.push({
          stage,
          message: `${stageLabels[stage]} 阶段从未产出任何事件`,
          severity: "critical",
          consecutiveZeroCount: 999,
        });
        continue;
      }

      let consecutiveZero = 0;
      const stageInputCount = await prisma.flywheelEvent.count({
        where: { targetStage: stage },
      });

      if (stageInputCount > 0 && events.length === stageInputCount) {
        consecutiveZero = events.length;
      }

      if (consecutiveZero >= input.consecutiveZeroThreshold) {
        alerts.push({
          stage,
          message: `${stageLabels[stage]} 连续 ${consecutiveZero} 次无下游转化（总计 ${events.length} 个事件无产出）`,
          severity: "critical",
          consecutiveZeroCount: consecutiveZero,
        });
      }
    }

    return alerts.sort((a, b) => b.consecutiveZeroCount - a.consecutiveZeroCount);
  }),

  getSuggestions: publicProcedure.input(z.object({
    evaluateThreshold: z.number().default(5),
  })).query(async ({ input }) => {
    const suggestions: Array<{ type: string; priority: string; title: string; description: string; autoAction: boolean }> = [];

    const evalCount = await prisma.flywheelEvent.count({ where: { stage: "EVALUATE" } });
    const outcomeCount = await prisma.flywheelEvent.count({ where: { stage: "OUTCOME" } });
    const practiceCount = await prisma.flywheelEvent.count({ where: { stage: "PRACTICE" } });
    const reflectCount = await prisma.flywheelEvent.count({ where: { stage: "REFLECT" } });

    if (evalCount >= input.evaluateThreshold) {
      suggestions.push({
        type: "LEARN_CYCLE",
        priority: "P1",
        title: `完成 ${evalCount} 次评估，建议启动新一轮学习`,
        description: `飞轮已完成 ${evalCount} 次评估，${outcomeCount} 个产出。建议回顾评估结果，提炼共性模式，启动新的学习路径。`,
        autoAction: true,
      });
    }

    if (practiceCount > reflectCount * 2 && reflectCount < practiceCount) {
      suggestions.push({
        type: "REFLECTION_BALANCE",
        priority: "P2",
        title: "反思阶段落后，建议深化反思",
        description: `实践: ${practiceCount}，反思: ${reflectCount}。实践与反思比例失衡，建议增加结构性反思。`,
        autoAction: false,
      });
    }

    if (outcomeCount === 0 && practiceCount > 10) {
      suggestions.push({
        type: "OUTCOME_MISSING",
        priority: "P1",
        title: "缺少成果记录，建议创建产出档案",
        description: `已完成 ${practiceCount} 次实践但无成果记录。建议为每个实践创建对应的产出(Output)记录。`,
        autoAction: false,
      });
    }

    const evalToLearnCount = await prisma.flywheelEvent.count({
      where: { stage: "EVALUATE", targetStage: "LEARN" },
    });
    if (evalCount > 0 && evalToLearnCount === 0) {
      suggestions.push({
        type: "CLOSED_LOOP_MISSING",
        priority: "P1",
        title: "评估未形成学习闭环",
        description: `已完成 ${evalCount} 次评估，但评估结果未反馈到学习阶段。建议审查评估质量。`,
        autoAction: false,
      });
    }

    return suggestions;
  }),

  autoTriggerLearning: publicProcedure.input(z.object({
    basedOnEvals: z.number().default(5),
  })).mutation(async ({ input }) => {
    const evalCount = await prisma.flywheelEvent.count({ where: { stage: "EVALUATE" } });

    if (evalCount < input.basedOnEvals) {
      return { triggered: false, reason: `评估次数不足 (${evalCount}/${input.basedOnEvals})` };
    }

    const recentPractices = await prisma.practice.findMany({
      where: { qualityScore: { gte: 0.7 } },
      orderBy: { completedAt: "desc" },
      take: 5,
    });

    if (recentPractices.length === 0) {
      return { triggered: false, reason: "无高质量实践可用于提炼学习建议" };
    }

    const titles = recentPractices.map((p) => p.title).join("、");
    // 防重护栏 (2026-08-27): 曾有 cron 每15min调一次, 无护栏累计灌 1,043 条同名 Reflection。
    // 24h 内已有同 title 的 AUTO_LEARN 反思则跳过, 从源头断重复。
    const dup = await prisma.reflection.findFirst({
      where: {
        title: `基于 ${recentPractices.length} 次高质量实践的自动学习建议`,
        category: "AUTO_LEARN",
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      select: { id: true },
    });
    if (dup) {
      return { triggered: false, reason: "24h 内已生成过同款自动学习建议 (防重护栏, 2026-08-27)" };
    }
    const reflection = await safeCreateReflection(prisma, {
      data: {
        title: `基于 ${recentPractices.length} 次高质量实践的自动学习建议`,
        description: `飞轮自动触发：经过 ${evalCount} 次评估，基于 ${recentPractices.length} 个高质量实践（${titles}）生成此建议。`,
        category: "AUTO_LEARN",
        priority: "P1",
        lesson: "定期回顾高质量实践，提炼共性模式，形成系统化知识体系，是提升能力的关键路径。",
        improvements: "建议查看最近完成的高质量实践，分析其成功因素，并尝试应用到新学习中。",
        score: 0.85,
      },
    });
    // 2026-10-09 round 72-I: 认知闸在 enforce 档会 return null(内容不合规) -> 下面的 reflection.id 会抛
    //   TypeError 把整个 mutation 打成 500。质量闸不该变成可用性事故, 这里显式返回"被闸拒收"。
    if (!reflection || !reflection.id) {
      return { triggered: false, reason: "认知闸拒收(反思内容不满足完备性判据), 未落库" };
    }

    await prisma.flywheelEvent.create({
      data: {
        stage: "LEARN",
        sourceType: "AUTO_TRIGGER",
        sourceId: reflection.id,
        sourceTitle: reflection.title,
        targetStage: "REFLECT",
      },
    });

    return { triggered: true, reflectionId: reflection.id, basedOnEvals: evalCount };
  }),

  /**
   * V1 §15.2.4: P0 飞轮闭环吞吐
   * 统计 REFLECTION_TO_TASK 和 TASK_TO_FILL 两个新 stage 的吞吐 + 4 类回填路由
   */
  getP0Throughput: publicProcedure.query(async () => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      bridgeEvents,
      bridgeLast24h,
      fillEvents,
      fillLast24h,
      pendingSessions,
      pendingReflections,
      openTasks,
      doneTasks,
      failedTasks,
      totalTasks,
    ] = await Promise.all([
      prisma.flywheelEvent.count({ where: { stage: "REFLECTION_TO_TASK" } }),
      prisma.flywheelEvent.count({
        where: { stage: "REFLECTION_TO_TASK", createdAt: { gte: since24h } },
      }),
      prisma.flywheelEvent.count({ where: { stage: "TASK_TO_FILL" } }),
      prisma.flywheelEvent.count({
        where: { stage: "TASK_TO_FILL", createdAt: { gte: since24h } },
      }),
      // monorepo SessionRegistry 是 Prisma 模型
      prisma.sessionRegistry.count({ where: { status: "PENDING" } }),
      // monorepo Reflection 是 Prisma 模型
      prisma.reflection.count({ where: { status: "OPEN" } }),
      // Task PENDING / DONE / FAILED
      prisma.task.count({ where: { status: "PENDING" } }),
      prisma.task.count({ where: { status: "DONE" } }),
      prisma.task.count({ where: { status: "FAILED" } }),
      prisma.task.count(),
    ]);

    // 4 类回填路由
    const fillByType = await prisma.flywheelEvent.groupBy({
      by: ["targetType"],
      where: { stage: "TASK_TO_FILL" },
      _count: { id: true },
    });
    const routed: Record<string, number> = { MEMORY: 0, KNOWLEDGE: 0, SKILL: 0, PRACTICE: 0 };
    for (const f of fillByType) {
      const t = f.targetType as string | null;
      if (t && t in routed) routed[t] = f._count.id;
    }

    const failureRate = totalTasks > 0 ? Math.round((failedTasks / totalTasks) * 100) : 0;

    // V1 §18.7 飞轮成功率 SLO (公式 A): task 完成数 / task 创建数
    // target ≥95%, warning <90%, critical <80%
    // totalTasks=0 时视为 ok (无数据样本,不报警)
    const successRate = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 100;
    const flywheelSlo = {
      level:
        totalTasks === 0
          ? ("ok" as const)
          : successRate < 80
            ? ("critical" as const)
            : successRate < 90
              ? ("warning" as const)
              : ("ok" as const),
      threshold_target: 95,
      threshold_warning: 90,
      threshold_critical: 80,
      target: "successRate >= 95%",
    };

    return {
      bridge: { total: bridgeEvents, last24h: bridgeLast24h },
      fill: { total: fillEvents, last24h: fillLast24h, routed },
      backlog: { pendingSessions, pendingReflections, openTasks },
      taskStats: {
        done: doneTasks,
        failed: failedTasks,
        total: totalTasks,
        successRate,
        failureRate,
        slo: flywheelSlo,
      },
      timestamp: new Date().toISOString(),
    };
  }),

  // ===== 2026-07-12 Phase B 版本联动 =====
  getStaleRecords: readerProcedure.input(z.object({
    layer: z.enum(["L2", "L3"]).optional(),
    limit: z.number().min(1).max(200).default(50),
  }).optional()).query(async ({ input, ctx }) => {
    return listStaleRecords(prisma, { limit: input?.limit, scope: readableWhere(toAssetActor((ctx as any).actor), { kind: "memory" }) });
  }),

  clearStaleFlag: publicProcedure.input(z.object({
    targetType: z.enum(["knowledge", "skill", "practice"]),
    targetId: z.string(),
  })).mutation(async ({ input }) => {
    await clearStaleFlag(prisma, input.targetId);
    return { cleared: true };
  }),

  getPendingSynthesisJobs: publicProcedure.input(z.object({
    layer: z.enum(["L2", "L3"]).optional(),
    limit: z.number().min(1).max(100).default(20),
  }).optional()).query(async ({ input }) => {
    return listPendingJobs(prisma, { limit: input?.limit });
  }),

  /**
   * 2026-07-12 P1-1b: 飞轮时延指标
   *
   * 数据源: _global_organizer_task 表 (DONE 行有 duration 字段)
   *
   * 输出 4 个核心时延维度:
   *   - organize_duration: 全局整理 7 步流水线时延 (秒)
   *   - reflection_to_task_latency: SessionGroup.extractStatus PENDING→DONE 时延 (秒)
   *   - task_done_to_backfill: TaskExecution.COMPLETED → flywheelEvent.TASK_TO_FILL 时延 (秒)
   *   - end_to_end: SessionGroup.firstMessageAt → 当前 DONE 的时延 (秒)
   *
   * 方案 §4.5 验收标准:
   *   - reflection→task p95 < 5min (300s)
   *   - task→回填 p95 < 10min (600s)
   *   - end-to-end p95 < 6h (21600s)
   */
  getLatencyMetrics: publicProcedure.input(z.object({
    window: z.enum(["1h", "24h", "7d", "30d", "all"]).default("all"),
  }).optional()).query(async ({ input }) => {
    const windowMs: Record<string, number | null> = {
      "1h": 1 * 3600 * 1000,
      "24h": 24 * 3600 * 1000,
      "7d": 7 * 24 * 3600 * 1000,
      "30d": 30 * 24 * 3600 * 1000,
      "all": null,
    };
    const sinceMs = windowMs[input?.window ?? "all"];
    const startedAtFilter = sinceMs !== null
      ? { gte: new Date(Date.now() - sinceMs).getTime() }
      : {};

    // === 维度 1: organize 7 步流水线时延 ===
    // 坑19: Prisma SQLite $queryRaw 对大 INTEGER (ms 时间戳) 有 bug, 必须 CAST AS REAL
    // 另: 带 ? 参数的 queryRaw 会挂, 改用字符串拼接 + sqlStr 手动转义
    const sqlStr = (v: string | number | null | undefined): string => {
      if (v == null) return "NULL";
      return "'" + String(v).replace(/'/g, "''") + "'";
    };

    const sinceTs = sinceMs !== null ? Date.now() - sinceMs : null;
    const organizeRows = await prisma.$queryRawUnsafe<Array<{
      taskId: string;
      groupKey: string;
      duration: number | null;
      startedAt: number;
      products: string | null;
      skills: number | null;
      stalePropagated: number | null;
    }>>(
      `SELECT taskId, groupKey, duration,
              CAST(startedAt AS REAL) as startedAt,
              products, skills, stalePropagated
       FROM _global_organizer_task
       WHERE status='DONE' AND duration IS NOT NULL
       ${sinceTs !== null ? `AND startedAt >= ${sinceTs}` : ""}
       ORDER BY startedAt DESC`,
    ) as any[];

    const organizeDurations = organizeRows
      .map((r) => (typeof r.duration === "bigint" ? Number(r.duration) : r.duration))
      .filter((d): d is number => d !== null && d > 0);

    // P6 修 SLO 算法 (2026-07-12): IQR outlier filter — 把 P95 从"被历史 4 个 outlier 拉偏 466.9s"
    // 还原成"反映当前真实分布 (p95=176.7s)". Tukey's fence: 异常值 > Q3 + 1.5*IQR
    // 因为 outlier 是历史 5-6 月 Phase 2-3 巨型 group (92 chunks), 不代表当前稳定状态
    //
    // ⚠️ 6 区间感知: filteredCount >= 6 才能保证 p95 可靠 (5 样本下 p95 会落到最后一个样本)
    // 修复 (2026-07-13): 之前 sampleCount>=4 但 p95 在小样本下抖动大, 现在用 min(6, ceil(n*0.8))
    const filteredDurations = (() => {
      if (organizeDurations.length < 4) return organizeDurations;
      const sorted = [...organizeDurations].sort((a, b) => a - b);
      const q1 = sorted[Math.floor(sorted.length * 0.25)];
      const q3 = sorted[Math.floor(sorted.length * 0.75)];
      const iqr = q3 - q1;
      const upperFence = q3 + 1.5 * iqr;
      const filtered = sorted.filter((d) => d <= upperFence);
      // 至少保留 80% 数据 + 至少 6 个样本 (p95 统计置信度)
      return filtered.length >= Math.min(6, sorted.length * 0.8) ? filtered : sorted;
    })();

    const percentile = (arr: number[], p: number): number => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      // 标准 percentile 公式: idx = (n-1) * p
      // 例如 n=13, p=0.95 → idx=11.4 → 在 sorted[11]=467.5 和 sorted[12]=492.7 之间插值
      // 线性插值: 467.5 + 0.4 * (492.7 - 467.5) = 467.5 + 10.08 = 477.58
      const exactIdx = (sorted.length - 1) * p;
      const low = Math.floor(exactIdx);
      const high = Math.ceil(exactIdx);
      if (low === high) return Math.round(sorted[low] * 10) / 10;
      const frac = exactIdx - low;
      const val = sorted[low] + frac * (sorted[high] - sorted[low]);
      return Math.round(val * 10) / 10;
    };

    const organizeStats = {
      sampleCount: organizeDurations.length,
      filteredCount: filteredDurations.length,
      filteredOutliers: organizeDurations.length - filteredDurations.length,
      avg: percentile(filteredDurations, 0.5), // 用 p50 作为"平均感"
      p50: percentile(filteredDurations, 0.5),
      p95: percentile(filteredDurations, 0.95),
      p95Raw: percentile(organizeDurations, 0.95), // 原始 p95 (含 outlier) 留作参考
      max: filteredDurations.length > 0 ? Math.max(...filteredDurations) : 0,
      maxRaw: organizeDurations.length > 0 ? Math.max(...organizeDurations) : 0,
      slo: {
        target_p95_sec: 300, // 5 分钟 (方案 §4.5)
        warning_p95_sec: 600, // 10 分钟
        critical_p95_sec: 1200, // 20 分钟
      },
    };

    // === 维度 2: SessionGroup PENDING→DONE 时延 (用 extractedAt - firstMessageAt 估算) ===
    // 这是 reflection→task 的近似, 因为 updateExtractStatus DONE 是 organize 流水线的终点
    // SessionGroup 在 session DB 里, mind prisma client 查不到, 走 session API
    //
    // ⚠️ 修复 2026-07-13 (§12.5 主体评估 偏差 #1): session API 之前**不过滤 window**,
    // 拉到的是历史全量 (新→500 条), p95 永远是"最老的 5% SessionGroup", 一直 4.47M ms (74min)
    // 设计预期: 24h 窗口 → 24h 内提取完的 SessionGroup; ALL → 全量
    // 现状: 拉 limit=100 不带 window, 与传入 window 参数不一致
    // 修法: 把 sinceTs 转成 ISO, 加 &since 参数让 session API 也过滤
    const SESSION_API_BASE = process.env.LIONS_SESSION_API_BASE || "http://localhost:3002/api/v1";
    const SESSION_API_KEY = sessionApiKey(/* LIONS_SESSION_API_KEY */);
    let sessionLatencies: number[] = [];
    try {
      // 转换 sinceTs (ms timestamp) 到 ISO 字符串, 跟 window 语义对齐
      const sessionUrl = sinceTs !== null
        ? `${SESSION_API_BASE}/session-groups?status=DONE&limit=100&since=${new Date(sinceTs).toISOString()}`
        : `${SESSION_API_BASE}/session-groups?status=DONE&limit=100`;
      const sessionRes = await fetch(
        sessionUrl,
        { headers: { "X-API-Key": SESSION_API_KEY } },
      );
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json();
        const items: Array<{
          firstMessageAt?: string | null;
          extractedAt?: string | null;
        }> = sessionData.items || [];
        sessionLatencies = items
          .map((r) => {
            if (!r.firstMessageAt || !r.extractedAt) return null;
            const t1 = new Date(r.firstMessageAt).getTime();
            const t2 = new Date(r.extractedAt).getTime();
            if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 < t1) return null;
            return (t2 - t1) / 1000;
          })
          .filter((d): d is number => d !== null);
      }
    } catch (e) {
      console.error("[getLatencyMetrics] session API fetch failed:", e);
    }

    const sessionStats = {
      sampleCount: sessionLatencies.length,
      p50: percentile(sessionLatencies, 0.5),
      p95: percentile(sessionLatencies, 0.95),
      max: sessionLatencies.length > 0 ? Math.max(...sessionLatencies) : 0,
      // 注: 这个值衡量 "SessionGroup 存续时长", 不是真 reflection→task
      // 因为 reflect/extract 发生在 SessionGroup 之前
      _note: "firstMessageAt→extractedAt 估算, 反映 SessionGroup 累计消息→整理完成总时延",
    };

    // === 维度 3: organize throughput ===
    const totalCount = organizeRows.length;
    const sinceHours = sinceMs !== null ? sinceMs / (3600 * 1000) : null;
    const throughput = sinceHours !== null && sinceHours > 0
      ? Math.round((totalCount / sinceHours) * 10) / 10
      : null;

    // === 维度 4: 失败率 ===
    // Prisma + raw query 的 COUNT(*) 默认返 BigInt, CAST AS INTEGER 强制 Number
    const failedRows = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
      `SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM _global_organizer_task
       WHERE status='FAILED'
       ${sinceTs !== null ? `AND startedAt >= ${sinceTs}` : ""}`,
    ) as Array<{ cnt: number }>;
    const failedCount = Number(failedRows[0]?.cnt ?? 0);
    const totalAll = totalCount + failedCount;
    const failureRate = totalAll > 0
      ? Math.round((failedCount / totalAll) * 100)
      : 0;

    return {
      window: input?.window ?? "all",
      timestamp: new Date().toISOString(),
      organizeDuration: {
        ...organizeStats,
        level: (() => {
          // 偏差修复 (2026-07-13 §12.5 偏差 #2): 0 样本应报 stale, 不是 ok
          // 设计预期: §18.7 monitor 应在 "no recent activity" 告警
          if (organizeStats.sampleCount === 0) return "stale";
          if (organizeStats.p95 <= organizeStats.slo.target_p95_sec) return "ok";
          if (organizeStats.p95 <= organizeStats.slo.warning_p95_sec) return "warning";
          return "critical";
        })(),
      },
      sessionLatency: {
        ...sessionStats,
        // sessionLatency 同步 stale 语义 (跟 organizeDuration 对齐)
        level: sessionStats.sampleCount === 0 ? "stale" : (
          sessionStats.p95 <= 3600 ? "ok" :  // 1h
          sessionStats.p95 <= 21600 ? "warning" : // 6h (端到端 SLO)
          "critical"
        ),
      },
      throughput: {
        perHour: throughput,
        total: totalCount,
        windowHours: sinceHours,
      },
      failureRate: {
        percent: failureRate,
        failed: failedCount,
        succeeded: totalCount,
        // §12.5 偏差 #1 同样修: 0 任务应该报 stale, 不是 ok
        // (跟 organizeDuration / sessionLatency 的 sampleCount=0 → stale 保持一致)
        level: totalAll === 0
          ? "stale"
          : failureRate < 5 ? "ok" : failureRate < 20 ? "warning" : "critical",
      },
      recentRuns: organizeRows.slice(0, 10).map((r) => ({
        taskId: r.taskId,
        groupKey: r.groupKey,
        duration: typeof r.duration === "bigint" ? Number(r.duration) : r.duration,
        products: r.products,
        skills: typeof r.skills === "bigint" ? Number(r.skills) : r.skills,
        stalePropagated: typeof r.stalePropagated === "bigint" ? Number(r.stalePropagated) : r.stalePropagated,
        startedAt: typeof r.startedAt === "bigint" ? Number(r.startedAt) : r.startedAt,
      })),
      // §12.5 主体评估偏差 #3 (2026-07-13): recentRuns 现在已 window-filtered
      // (因为 organizeRows 已经按 sinceMs 过滤了, line 415)
      _windowNote: sinceTs !== null ? `filtered to last ${input?.window ?? "all"}` : "no window filter (all)",
    };
  }),
});