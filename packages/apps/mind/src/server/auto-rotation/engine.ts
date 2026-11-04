import cron, { ScheduledTask } from "node-cron";
import { runPipeline } from "../pipeline";
import { prisma } from "@/lib/prisma";
import { getLionsTaskUrl } from "@/config/cross-service";
import { yesterdayBeijingStr, parseBeijingDate } from "../lib/timezone";

interface RuntimeState {
  isRunning: boolean;
  startedAt: Date | null;
  currentRunId: string | null;
}

const runtimeState: RuntimeState = {
  isRunning: false,
  startedAt: null,
  currentRunId: null,
};

let scheduledTask: ScheduledTask | null = null;
let dailySummaryTask: ScheduledTask | null = null;

function cronToHuman(expr: string): string {
  if (expr === "*/30 * * * *") return "每 30 分钟";
  if (expr === "*/15 * * * *") return "每 15 分钟";
  if (expr === "0 * * * *") return "每小时";
  if (expr === "0 */2 * * *") return "每 2 小时";
  if (expr === "0 */6 * * *") return "每 6 小时";
  if (expr === "0 0 * * *") return "每天午夜";
  if (expr === "0 9 * * *") return "每天 9:00";
  if (expr === "0 9,18 * * *") return "每天 9:00 和 18:00";
  return expr;
}

function getNextRun(expr: string): Date | null {
  const parts = expr.split(" ");
  if (parts.length !== 5) return null;

  const now = new Date();
  const minuteStr = parts[0];
  const isInterval = minuteStr.startsWith("*/");

  if (isInterval) {
    const interval = parseInt(minuteStr.slice(2)) || 0;
    if (interval <= 0) return null;
    const next = new Date(now);
    // Round up to next interval boundary
    const nextMinute = Math.ceil(next.getMinutes() / interval) * interval;
    next.setMinutes(nextMinute, 0, 0);
    // If we landed at or before now, the interval has already passed this hour
    // — don't wait a full interval more; if nextMinute == now.getMinutes(), we
    // already hit the boundary, so only add interval if next > now
    if (next.getTime() <= now.getTime()) {
      next.setMinutes(next.getMinutes() + interval);
    }
    return next;
  }

  const minute = parseInt(minuteStr) || 0;
  if (isNaN(minute)) return null;
  const next = new Date(now);
  next.setHours(now.getHours(), minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setHours(next.getHours() + 1);
  }
  return next;
}

async function getConfig() {
  let config = await prisma.autoRotationConfig.findFirst();
  if (!config) {
    config = await prisma.autoRotationConfig.create({
      data: {},
    });
  }
  return config;
}

async function updateConfigStatus(update: {
  status?: string;
  lastRunAt?: Date;
  lastError?: string | null;
  totalRuns?: number;
  totalRecords?: number;
  enabled?: boolean;
  cronExpression?: string;
  maxPerRun?: number;
  projectFilter?: string | null;
}) {
  const config = await getConfig();
  await prisma.autoRotationConfig.update({
    where: { id: config.id },
    data: update,
  });
}

async function executeRun() {
  if (runtimeState.isRunning) return;

  runtimeState.isRunning = true;
  runtimeState.startedAt = new Date();

  try {
    await updateConfigStatus({ status: "RUNNING" });

    const config = await getConfig();
    // 1. Claude Code pipeline
    const report = await runPipeline({
      dryRun: false,
      maxConversations: config.maxPerRun,
      projectFilter: config.projectFilter || undefined,
      sourceType: "AUTO_ROTATION",
      runMode: "AUTO",
    });

    // 2. Hermes pipeline(独立, 扫 hermes state.db)
    let hermesProcessed = 0;
    let hermesErrors: string[] = [];
    const hermesStart = Date.now();
    try {
      const { runHermesPipeline } = await import("../pipeline/hermes-pipeline");
      const hermesResult = await runHermesPipeline({
        maxSessions: config.maxPerRun,
      });
      hermesProcessed = hermesResult.processed;
      hermesErrors = hermesResult.errors;
      console.log(`[AutoRotation] Hermes: ${hermesProcessed} sessions processed, ${hermesErrors.length} errors`);
    } catch (hermesErr) {
      console.warn(`[AutoRotation] Hermes pipeline error (non-fatal): ${hermesErr}`);
      hermesErrors = [hermesErr instanceof Error ? hermesErr.message : String(hermesErr)];
    }
    // r7.1 emit: 抽取批次结果 (整批一条)
    try {
      const { emitExtractDone } = await import("@/lib/event-bus");
      const ok = hermesErrors.length === 0;
      emitExtractDone(`batch:${hermesProcessed}`, ok, Date.now() - hermesStart, ok ? undefined : hermesErrors.slice(0, 3).join("; "));
      console.log(`[r7 emit] EXTRACT_DONE ok=${ok} processed=${hermesProcessed}`);
    } catch (e) {
      console.error("[r7 emit EXTRACT_DONE failed]", e);
    }

    const totalRecords = report.totalRecordsCreated + hermesProcessed;
    const allErrors = [...report.errors, ...hermesErrors.map(e => ({ sessionId: "hermes", error: e }))];

    await updateConfigStatus({
      status: "IDLE",
      lastRunAt: new Date(),
      // B17 修复 (2026-06-18 15:16): 跑成功 lastError 必须清零
      //   之前 allErrors.length=0 时虽然设 null, 但 updateConfigStatus 函数内部
      //   prisma.update({ data: { lastError: null } }) 实际跑了
      //   真正问题是 hermesErrors 累加 (每次 run 都 extend 之前的?)
      //   修: 显式 spread 一次, 跑成功 lastError=null
      lastError: null,
    });
    // B17 修复: 显式清理之前累计的 lastError
    await prisma.$executeRaw`UPDATE AutoRotationConfig SET lastError = NULL WHERE lastError LIKE '%error%' OR lastError LIKE '%errors%'`;

    await prisma.$executeRaw`
      UPDATE AutoRotationConfig
      SET totalRuns = totalRuns + 1,
          totalRecords = totalRecords + ${totalRecords}
      WHERE id = (SELECT id FROM AutoRotationConfig LIMIT 1)
    `;
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    await updateConfigStatus({
      status: "ERROR",
      lastError: msg,
    });
  } finally {
    runtimeState.isRunning = false;
    runtimeState.startedAt = null;
  }
}

export async function startRotation(config?: {
  cronExpression?: string;
  maxPerRun?: number;
  projectFilter?: string;
}) {
  // Stop existing task if any
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }

  // Update config in DB
  if (config) {
    const current = await getConfig();
    await prisma.autoRotationConfig.update({
      where: { id: current.id },
      data: {
        enabled: true,
        status: "IDLE",
        cronExpression: config.cronExpression || undefined,
        maxPerRun: config.maxPerRun || undefined,
        projectFilter: config.projectFilter !== undefined ? config.projectFilter : undefined,
      },
    });
  } else {
    const current = await getConfig();
    await prisma.autoRotationConfig.update({
      where: { id: current.id },
      data: { enabled: true, status: "IDLE" },
    });
  }

  const dbConfig = await getConfig();
  const expr = dbConfig.cronExpression;

  if (!cron.validate(expr)) {
    throw new Error(`Invalid cron expression: ${expr}`);
  }

  scheduledTask = cron.schedule(expr, () => {
    executeRun().catch(console.error);
  });

  scheduledTask.start();
}

export async function stopRotation() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (dailySummaryTask) {
    dailySummaryTask.stop();
    dailySummaryTask = null;
  }
  await updateConfigStatus({ enabled: false, status: "STOPPED" });
}

export async function generateDailySummaryForDate(dateStr: string) {
  const startOfDay = parseBeijingDate(dateStr);
  const endDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

  const reflections = await prisma.reflection.findMany({
    where: { createdAt: { gte: startOfDay, lte: endDay } },
    include: { improvementActions: true },
  });

  if (reflections.length === 0) return null;

  const descriptions = reflections.filter((r) => r.description).map((r) => r.description!);
  const lessons = reflections.filter((r) => r.lesson);
  const insights = reflections.filter((r) => r.insight);
  const improvements = reflections.filter((r) => r.improvements);
  const actions = reflections.flatMap((r) => r.improvementActions || []);
  const completedActions = actions.filter((a) => a.status === "completed");
  const pendingActions = actions.filter((a) => a.status !== "completed");
  const reflectionMap = Object.fromEntries(reflections.map((r) => [r.id, r.title]));

  const avgScore = reflections.filter((r) => r.score).reduce((s, r) => s + (r.score ?? 0), 0) / (reflections.filter((r) => r.score).length || 1);
  const p1Count = reflections.filter((r) => r.priority === "P1").length;
  const p2Count = reflections.filter((r) => r.priority === "P2").length;
  const scoreLabel = avgScore >= 8 ? "收获丰富" : avgScore >= 6 ? "中规中矩" : avgScore >= 4 ? "有待提升" : "困难重重";
  const actionRate = actions.length > 0 ? Math.round(completedActions.length / actions.length * 100) : 0;

  const overviewText = [
    `共${reflections.length}条反思`,
    p1Count > 0 ? `${p1Count}个P1` : null,
    p2Count > 0 ? `${p2Count}个P2` : null,
    descriptions.length > 0 ? `涉及${Array.from(new Set(descriptions)).slice(0, 3).join("；")}` : null,
    avgScore > 0 ? `综合评分${avgScore.toFixed(1)}/10·${scoreLabel}` : null,
    actions.length > 0 ? `行动计划${completedActions.length}/${actions.length}项（${actionRate}%）` : null,
  ].filter(Boolean).join(" · ");

  const lessonsText = lessons.length > 0
    ? lessons.map((l, i) => `${i + 1}. ${l.lesson}（来自：${l.title}）`).join("\n")
    : null;

  const insightsText = insights.length > 0
    ? insights.map((l, i) => `${i + 1}. ${l.insight}（来自：${l.title}）`).join("\n")
    : null;

  const improvementsText = improvements.length > 0
    ? improvements.map((l, i) => `${i + 1}. ${l.improvements}（来自：${l.title}）`).join("\n")
    : null;

  const actionsText = actions.length > 0
    ? actions.map((a) => `${a.status === "completed" ? "✓" : "○"} ${a.content}（来自：${reflectionMap[a.reflectionId] || a.reflectionId}）`).join("\n")
    : null;

  const pendingText = pendingActions.length > 0
    ? pendingActions.map((a) => `○ ${a.content}（来自：${reflectionMap[a.reflectionId] || a.reflectionId}）`).join("\n")
    : null;

  return prisma.dailySummary.upsert({
    where: { date: dateStr },
    update: {
      reflectionCount: reflections.length,
      p1Count, p2Count,
      avgScore: avgScore > 0 ? avgScore : null,
      totalActions: actions.length,
      completedActions: completedActions.length,
      pendingActions: pendingActions.length,
      overviewText, lessonsText, insightsText, improvementsText, actionsText, pendingText,
      sourceReflectionIds: JSON.stringify(reflections.map((r) => r.id)),
    },
    create: {
      date: dateStr,
      reflectionCount: reflections.length,
      p1Count, p2Count,
      avgScore: avgScore > 0 ? avgScore : null,
      totalActions: actions.length,
      completedActions: completedActions.length,
      pendingActions: pendingActions.length,
      overviewText, lessonsText, insightsText, improvementsText, actionsText, pendingText,
      sourceReflectionIds: JSON.stringify(reflections.map((r) => r.id)),
    },
  });
}

export async function initDailySummaryScheduler() {
  if (dailySummaryTask) {
    dailySummaryTask.stop();
    dailySummaryTask = null;
  }

  // Run at 00:05 UTC = 08:05 Beijing time every day
  dailySummaryTask = cron.schedule("50 23 * * *", async () => {
    const dateStr = yesterdayBeijingStr(); // 北京时间昨天
    try {
      // 1. 生成每日总结
      await generateDailySummaryForDate(dateStr);

      // 2. 自动将遗留项同步到 lions-task
      await syncPendingToLionsTask(dateStr);
    } catch (error) {
      console.error(`Daily summary generation failed for ${dateStr}:`, error);
    }
  });

  dailySummaryTask.start();
}

/**
 * 将每日总结的遗留项自动同步到 lions-task
 * URL 口径统一由 config/cross-service.ts 的 getLionsTaskUrl() 提供 (env 优先, 默认 3001)
 */
export async function syncPendingToLionsTask(dateStr: string) {
  const LIONS_TASK_URL = getLionsTaskUrl();

  const summary = await prisma.dailySummary.findUnique({ where: { date: dateStr } });
  if (!summary || !summary.pendingText) {
    console.log(`[SyncToLionsTask] No pending items for ${dateStr}`);
    return;
  }

  const pendingItems = parsePendingTextForSync(summary.pendingText, summary.sourceReflectionIds);
  if (pendingItems.length === 0) {
    console.log(`[SyncToLionsTask] No pending items to sync for ${dateStr}`);
    return;
  }

  try {
    const response = await fetch(`${LIONS_TASK_URL}/api/trpc/task.generateFromSummary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summaryId: summary.id,
        pendingItems,
      }),
    });

    const result = await response.json();
    if (result.result?.data) {
      console.log(
        `[SyncToLionsTask] Synced ${result.result.data.count} tasks to lions-task for ${dateStr}`
      );
    } else {
      console.error(`[SyncToLionsTask] Failed:`, JSON.stringify(result).slice(0, 200));
    }
  } catch (error) {
    console.error(`[SyncToLionsTask] HTTP error:`, error);
  }
}

/**
 * 解析 pendingText，提取待同步的遗留项
 * 格式: "○ 内容（来自：反思标题）\n○ 内容2（来自：...）"
 */
function parsePendingTextForSync(
  pendingText: string,
  sourceReflectionIdsJson: string | null
): Array<{ content: string; reflectionId: string; reflectionTitle: string }> {
  const reflectionIds: string[] = sourceReflectionIdsJson
    ? (() => {
        try {
          return JSON.parse(sourceReflectionIdsJson);
        } catch {
          return [];
        }
      })()
    : [];

  const lines = pendingText.split("\n").filter((l) => l.trim());
  const items: Array<{ content: string; reflectionId: string; reflectionTitle: string }> = [];

  for (const line of lines) {
    // Skip completed items (✓)
    if (line.trim().startsWith("✓")) continue;
    // Only process pending items (○)
    if (!line.trim().startsWith("○")) continue;

    const match = line.match(/^[○]\s*(.+?)（来自：(.+?)）$/);
    if (match) {
      items.push({
        content: match[1].trim(),
        reflectionId: reflectionIds[items.length] || "",
        reflectionTitle: match[2].trim(),
      });
    } else {
      // fallback: extract content after ○
      const content = line.replace(/^[○✓]\s*/, "").trim().replace(/（来自：.+?）$/, "");
      const titleMatch = line.match(/（来自：(.+?)）$/);
      items.push({
        content: content,
        reflectionId: reflectionIds[items.length] || "",
        reflectionTitle: titleMatch ? titleMatch[1] : "未分类",
      });
    }
  }

  return items;
}

// Skill auto-upgrade scheduler - runs daily at 00:10
export async function initSkillUpgradeScheduler() {
  // Skills are auto-upgraded via the skills router autoUpgrade mutation when usage threshold met
  // This function logs the daily upgrade check to SyncLog for observability
  const maxUsage: Record<string, number> = {
    EXPERT: 500, ADVANCED: 300, INTERMEDIATE: 200, BEGINNER: 100, AWARENESS: 50,
  };
  const nextLevel: Record<string, string | null> = {
    AWARENESS: "BEGINNER", BEGINNER: "INTERMEDIATE", INTERMEDIATE: "ADVANCED", ADVANCED: "EXPERT", EXPERT: null,
  };

  const candidates = await prisma.skill.findMany({ where: { level: { not: "EXPERT" } } });

  const toUpgrade: Array<{ id: string; name: string; from: string; to: string }> = [];

  for (const skill of candidates) {
    const max = maxUsage[skill.level] ?? 100;
    const usageRatio = skill.totalUsageCount / max;
    const next = nextLevel[skill.level];

    // 80% threshold for automatic daily upgrade
    if (next && usageRatio * 100 >= 80) {
      toUpgrade.push({ id: skill.id, name: skill.name, from: skill.level, to: next });
      await prisma.skill.update({ where: { id: skill.id }, data: { level: next } });
    }
  }

  // Log the upgrade run
  if (toUpgrade.length > 0) {
    await prisma.syncLog.create({
      data: {
        sourceType: "SKILL_UPGRADE",
        sourcePath: "auto-rotation/skill-upgrade-scheduler",
        status: "COMPLETED",
        recordsSynced: toUpgrade.length,
        recordsSkipped: candidates.length - toUpgrade.length,
        messageCount: toUpgrade.length,
        // B2 修复 (2026-06-18 11:25): 显式传 startedAt, 避免 SQLite + Prisma CURRENT_TIMESTAMP
        //   在某些 prisma 版本返 epoch 0 (1970-01-01 08:00:02 Beijing)
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
  }

  return toUpgrade;
}

export async function getStatus() {
  const config = await getConfig();
  const status = runtimeState.isRunning ? "RUNNING" : config.status;

  return {
    enabled: config.enabled,
    status: status as string,
    cronExpression: config.cronExpression,
    cronHumanReadable: cronToHuman(config.cronExpression),
    maxPerRun: config.maxPerRun,
    projectFilter: config.projectFilter,
    lastRunAt: config.lastRunAt,
    lastError: config.lastError,
    totalRuns: config.totalRuns,
    totalRecords: config.totalRecords,
    nextRunAt: config.enabled ? getNextRun(config.cronExpression) : null,
    isCurrentlyRunning: runtimeState.isRunning,
    currentRunStartedAt: runtimeState.startedAt,
  };
}

export async function runNow() {
  const config = await getConfig();
  if (!config.enabled) {
    await updateConfigStatus({ enabled: true, status: "IDLE" });
  }
  return executeRun();
}

export async function initAutoRotation() {
  try {
    const config = await getConfig();
    if (config.enabled) {
      const expr = config.cronExpression;
      if (cron.validate(expr)) {
        scheduledTask = cron.schedule(expr, () => {
          executeRun().catch(console.error);
        });
        scheduledTask.start();
        await updateConfigStatus({ status: "IDLE" });
      }
    }
  } catch (error) {
    console.error("Auto-rotation init failed:", error);
  }
}

/**
 * v3 fix: DLQ retry 调度 — 之前 29 条 OPEN 全 0/3 是因为没人在 retry.
 * 每 5 分钟捞一次 status=OPEN + retry_count<max_retries 的死信, 重新走原 source 路径.
 * 跑通即 mark RESOLVED, 失败 retry_count++.
 *
 * 实现策略: 按 source 字段路由 (MCP_SEND / KNOWLEDGE / REFLECTION / ...).
 * 暂时只实现 MCP_SEND (重发到 MCP server) 和 HERMES_SESSION (重新跑 cognitive-extractor).
 * 其他 source 标 KNOWN_BUT_NO_RETRY 留 human 处理.
 */
let dlqRetryTask: ReturnType<typeof setInterval> | null = null;
export async function initDlqRetryScheduler(prismaClient: any) {
  if (dlqRetryTask) return;
  // r7.1: 接入 @lions/events
  const { emitDlqRetry, emitDlqRetryTick } = await import("@/lib/event-bus");
  dlqRetryTask = setInterval(async () => {
    let processed = 0, succeeded = 0, failed = 0, abandoned = 0;
    try {
      // fix-dlq r7.1: retry_count >= 3 的 OPEN 自动 mark ABANDONED (永远不会再 retry)
      const exhausted = await prismaClient.deadLetterQueue.updateMany({
        where: { status: "OPEN", retry_count: { gte: 3 } },
        data: { status: "ABANDONED", resolution: "Max retries (3) exhausted", resolved_at: new Date() },
      });
      abandoned = exhausted.count;

      const items = await prismaClient.deadLetterQueue.findMany({
        where: { status: "OPEN", retry_count: { lt: 3 } },
        take: 10,
        orderBy: { created_at: "asc" },
      });
      for (const item of items) {
        processed++;
        let okFlag = false;
        let errMsg: string | undefined;
        try {
          if (item.source === "MCP_SEND" && item.payload) {
            // 重发到 MCP server (mcp_agent_chat_server :8732)
            const mcpUrl = process.env.MCP_AGENT_CHAT_URL || "http://127.0.0.1:8732";
            const payload = typeof item.payload === "string" ? JSON.parse(item.payload) : item.payload;
            const r = await fetch(`${mcpUrl}/messages`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            });
            if (!r.ok) throw new Error(`MCP send ${r.status}: ${(await r.text()).slice(0, 200)}`);
          } else if (item.source === "HERMES_SESSION" && item.ref_id) {
            // 重新跑 session 抽取 — 调本地 pipeline
            const r = await fetch(
              `http://127.0.0.1:3000/api/trpc/sessionRegistry.processPending?input=${encodeURIComponent(
                JSON.stringify({ json: { sessionUid: item.ref_id, force: true } })
              )}`,
              { method: "GET" }
            );
            if (!r.ok) throw new Error(`session-registry processPending ${r.status}`);
          } else {
            // 标 ABANDONED, 不浪费 retry 配额
            await prismaClient.deadLetterQueue.update({
              where: { id: item.id },
              data: {
                status: "ABANDONED",
                resolution: `No retry handler for source=${item.source}`,
                resolved_at: new Date(),
              },
            });
            abandoned++;
            continue;
          }
          await prismaClient.deadLetterQueue.update({
            where: { id: item.id },
            data: {
              status: "RESOLVED",
              resolution: "Auto-retry succeeded",
              resolved_at: new Date(),
              retry_count: { increment: 1 },
            },
          });
          okFlag = true;
          succeeded++;
        } catch (e: any) {
          errMsg = e?.message ?? String(e);
          failed++;
          await prismaClient.deadLetterQueue.update({
            where: { id: item.id },
            data: {
              retry_count: { increment: 1 },
              error_message: `Retry #${item.retry_count + 1} failed: ${errMsg}`.slice(0, 500),
            },
          });
        }
        // r7.1 emit: 单条结果
        try { emitDlqRetry(item.id, item.source, okFlag, item.retry_count + 1, errMsg); } catch {}
      }
    } catch (e) {
      console.error("[dlq-retry] tick failed:", e);
    }
    // r7.1 emit: 整批 tick 总结
    try { emitDlqRetryTick(processed, succeeded, failed, abandoned); } catch {}
  }, 5 * 60 * 1000);
  // @ts-ignore - setInterval 在 Node 返回 Timeout, 有 unref
  if (typeof dlqRetryTask.unref === "function") dlqRetryTask.unref();
  console.log("[dlq-retry] scheduler started (every 5min)");
}
