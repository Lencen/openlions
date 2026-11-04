/**
 * 健康面板后端 — 运维/医生双视角
 *
 * 数据维度:
 *   1. 服务心跳: 3000(Mind) + 3001(Self-Task) 是否在跑
 *   2. DB 状态:  两 DB 文件大小、最后写入时间、关键表行数
 *   3. 资源占用: process.memoryUsage / process.cpuUsage(本进程)
 *   4. 飞轮状态: 两 DB 的 FlywheelEvent 时间分布、转/静判断
 *   5. 反思引擎: Task 端 REFLECTION_TASK 事件 + 频率
 *   6. 任务引擎: TaskExecution 状态分布、卡住数、利用率
 *   7. 问题引擎: Problem 状态、引擎占用
 *   8. 告警:   阈值告警列表(可操作工单)
 *   9. 配置:   data/system-config.json
 *  10. 调度器: 调度器最后心跳时间(从 taskResources.batchSize / runningTasks 推断)
 */

import { createRouter, publicProcedure } from "../trpc";
import { prisma } from "@/lib/prisma";
import fs from "fs";
import path from "path";
import { z } from "zod";
import {
  getRuntimeConfig,
} from "../agents/runtime-config";

const MIND_URL = "http://localhost:3000";
const TASK_URL = "http://localhost:3001";
const MIND_DB = "/data~@uos/00 ai agent/claude code/test/lions-mind/prisma/dev.db";
const TASK_DB = "/data~@uos/00 ai agent/claude code/test/lions-selfimproving-task/prisma/dev.db";
const SYSTEM_CONFIG_PATH = path.join(process.cwd(), "data", "system-config.json");

// ---- 工具函数 ----
async function pingService(url: string, timeoutMs = 2000): Promise<{ up: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    const resp = await fetch(url, { signal: ctl.signal });
    clearTimeout(to);
    return { up: resp.ok || resp.status < 500, latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { up: false, latencyMs: Date.now() - t0, error: e?.message || String(e) };
  }
}

function dbStat(p: string): { exists: boolean; sizeBytes: number; mtime?: string; ageMinutes?: number } {
  try {
    if (!fs.existsSync(p)) return { exists: false, sizeBytes: 0 };
    const st = fs.statSync(p);
    return {
      exists: true,
      sizeBytes: st.size,
      mtime: st.mtime.toISOString(),
      ageMinutes: Math.round((Date.now() - st.mtime.getTime()) / 60000),
    };
  } catch {
    return { exists: false, sizeBytes: 0 };
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function fmtAge(minutes: number): string {
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 60 / 24)} 天前`;
}

function healthColor(value: number, thresholds: { warn: number; bad: number }): "good" | "warn" | "bad" {
  if (value >= thresholds.bad) return "bad";
  if (value >= thresholds.warn) return "warn";
  return "good";
}

export const healthRouter = createRouter({
  /**
   * 健康检查综合报告(主入口)
   */
  report: publicProcedure.query(async () => {
    const now = new Date();

    // ---- 1) 服务心跳 ----
    // P1-9 修复: mind 端是 stats.getOverview 不是 system.getOverview (sibling 设计 bug)
    const [mindPing, taskPing] = await Promise.all([
      pingService(`${MIND_URL}/api/trpc/stats.getOverview`).catch(() => ({ up: false, latencyMs: 0, error: "timeout" })),
      pingService(`${TASK_URL}/api/trpc/dashboard.overview`).catch(() => ({ up: false, latencyMs: 0, error: "timeout" })),
    ]);

    // ---- 2) DB 状态 ----
    const mindDb = dbStat(MIND_DB);
    const taskDb = dbStat(TASK_DB);

    // ---- 3) 资源占用(本进程 = 3001) ----
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const resourceUsage = {
      rss: fmtSize(mem.rss),
      heapUsed: fmtSize(mem.heapUsed),
      heapTotal: fmtSize(mem.heapTotal),
      external: fmtSize(mem.external),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      uptimeSec: Math.round(process.uptime()),
    };

    // ---- 4) 飞轮状态(Task DB FlywheelEvent 24h/1h 分布) ----
    // P1-9 修复: prisma DateTime 在 SQLite 存成 unix ms integer, 用 prisma client gte 转换正常
    //   警告: 后续 raw SQL 写 WHERE createdAt >= ? 必须传 ms integer, 不能用 datetime('now') 字符串
    //   实测: datetime('now', '-24 hours') 返 ISO 字符串 vs unix ms 整数 → 0 命中 (P3 假象)
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since1h = new Date(Date.now() - 60 * 60 * 1000);

    const flywheel24h = await prisma.flywheelEvent.groupBy({
      by: ["stage"],
      where: { createdAt: { gte: since24h } },
      _count: true,
    });
    const flywheel1h = await prisma.flywheelEvent.groupBy({
      by: ["stage"],
      where: { createdAt: { gte: since1h } },
      _count: true,
    });
    const flywheelLast = await prisma.flywheelEvent.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, stage: true, sourceType: true, sourceTitle: true },
    });
    const flywheelIdleMin = flywheelLast
      ? Math.round((now.getTime() - flywheelLast.createdAt.getTime()) / 60000)
      : 999999;
    const flywheelState: "spinning" | "slow" | "idle" | "stalled" =
      flywheelIdleMin < 5 ? "spinning" :
      flywheelIdleMin < 60 ? "slow" :
      flywheelIdleMin < 24 * 60 ? "idle" : "stalled";

    // ---- 5) 反思引擎(REFLECTION_TASK 事件) ----
    const reflection24h = flywheel24h.find(f => f.stage === "REFLECTION_TASK")?._count ?? 0;
    const reflection1h = flywheel1h.find(f => f.stage === "REFLECTION_TASK")?._count ?? 0;
    const reflectionLast = await prisma.flywheelEvent.findFirst({
      where: { stage: "REFLECTION_TASK" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, sourceTitle: true },
    });
    const reflectionIdleMin = reflectionLast
      ? Math.round((now.getTime() - reflectionLast.createdAt.getTime()) / 60000)
      : 999999;
    const reflectionState: "active" | "slow" | "idle" | "never" =
      reflectionLast == null ? "never" :
      reflectionIdleMin < 30 ? "active" :
      reflectionIdleMin < 6 * 60 ? "slow" : "idle";

    // ---- 6) 任务引擎(TaskExecution 状态 + 卡住) ----
    const taskExecStats = await prisma.taskExecution.groupBy({
      by: ["status"],
      _count: true,
    });
    const taskStats = await prisma.task.groupBy({
      by: ["status"],
      _count: true,
    });
    const taskExecMap: Record<string, number> = {};
    taskExecStats.forEach(s => { taskExecMap[s.status] = s._count; });
    const taskMap: Record<string, number> = {};
    taskStats.forEach(s => { taskMap[s.status] = s._count; });

    const stuckCount = await prisma.taskExecution.count({
      where: {
        status: "IN_PROGRESS",
        startedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
      },
    });
    const runningCount = taskExecMap["IN_PROGRESS"] ?? 0;

    // 任务引擎状态
    const taskEngine = {
      pending: taskMap["PENDING"] ?? 0,
      running: runningCount,
      stuck: stuckCount,
      blocked: taskMap["BLOCKED"] ?? 0,
      failed: taskMap["FAILED"] ?? 0,
      completed: taskMap["COMPLETED"] ?? 0,
      cancelled: taskMap["CANCELLED"] ?? 0,
      state: runningCount > 0 ? "running" : "idle",
    };

    // ---- 7) 问题引擎 ----
    const problemStats = await prisma.problem.groupBy({
      by: ["status"],
      _count: true,
    });
    const problemMap: Record<string, number> = {};
    problemStats.forEach(s => { problemMap[s.status] = s._count; });
    const problemEngine = {
      open: problemMap["OPEN"] ?? 0,
      solving: problemMap["SOLVING"] ?? 0,
      solved: problemMap["SOLVED"] ?? 0,
      abandoned: problemMap["ABANDONED"] ?? 0,
      state: (problemMap["SOLVING"] ?? 0) > 0 ? "running" : "idle",
    };

    // ---- 8) 告警(按严重度排) ----
    interface Alert {
      level: "critical" | "warning" | "info";
      category: string;
      title: string;
      detail: string;
      action?: string;
    }
    const alerts: Alert[] = [];

    if (!taskPing.up) {
      alerts.push({ level: "critical", category: "service", title: "Selfimproving-Task 服务不可达", detail: `3001 ${taskPing.error || "无响应"}`, action: "检查进程和日志 /tmp/lions-selfimproving-dev.log" });
    }
    if (!mindPing.up) {
      alerts.push({ level: "warning", category: "service", title: "Lions-Mind 服务不可达", detail: `3000 ${mindPing.error || "无响应"}` });
    }
    if (stuckCount > 0) {
      alerts.push({
        level: stuckCount > 100 ? "critical" : "warning",
        category: "engine",
        title: `${stuckCount} 个执行卡死(>30min)`,
        detail: `TaskExecution.IN_PROGRESS 跑超 30min,需要手动清理或重启调度器`,
        action: "Dashboard 资源面板 / 或调 scheduler.stuckGuard",
      });
    }
    if (flywheelState === "stalled") {
      alerts.push({
        level: "critical", category: "flywheel",
        title: `飞轮停转 ${fmtAge(flywheelIdleMin)}`,
        detail: `无 FlywheelEvent ${flywheelIdleMin} 分钟,系统完全停摆`,
        action: "检查 Task.PENDING 是否为 0、scheduler 是否在跑",
      });
    } else if (flywheelState === "idle" || flywheelState === "slow") {
      alerts.push({
        level: flywheelState === "idle" ? "warning" : "info",
        category: "flywheel",
        title: `飞轮缓慢 ${fmtAge(flywheelIdleMin)}`,
        detail: `无新事件 ${flywheelIdleMin} 分钟 — 可能没有 PENDING 任务可处理`,
        action: "Task.PENDING 数为 0 是正常空转;否则检查 scheduler",
      });
    }
    if (reflectionState === "never") {
      alerts.push({ level: "info", category: "reflection", title: "反思引擎从未产出", detail: "历史无 REFLECTION_TASK 事件" });
    } else if (reflectionState === "idle") {
      alerts.push({ level: "info", category: "reflection", title: `反思引擎空闲 ${fmtAge(reflectionIdleMin)}`, detail: "无新反思产出" });
    }
    if (problemEngine.open > 5000) {
      alerts.push({ level: "warning", category: "data", title: `OPEN 问题堆积 ${problemEngine.open}`, detail: "问题引擎未及时处理新问题" });
    }
    if (taskDb.ageMinutes !== undefined && taskDb.ageMinutes > 60) {
      alerts.push({ level: "warning", category: "db", title: `Task DB 静止 ${fmtAge(taskDb.ageMinutes)}`, detail: `dev.db ${fmtSize(taskDb.sizeBytes)} 最后写入 ${taskDb.mtime}` });
    }

    // 整体状态颜色
    const overall: "good" | "warn" | "bad" =
      alerts.some(a => a.level === "critical") ? "bad" :
      alerts.some(a => a.level === "warning") ? "warn" : "good";

    // ---- 9) 运行时配置 ----
    let sysConfig: any = null;
    try {
      if (fs.existsSync(SYSTEM_CONFIG_PATH)) {
        sysConfig = JSON.parse(fs.readFileSync(SYSTEM_CONFIG_PATH, "utf-8"));
      }
    } catch { /* ignore */ }
    const runtimeCfg = getRuntimeConfig();

    // ---- 10) 调度器最后心跳(从最近 FlywheelEvent 推断) ----
    const schedulerHeartbeat = {
      taskLastEvent: flywheelLast?.createdAt?.toISOString() ?? null,
      taskLastEventStage: flywheelLast?.stage ?? null,
      mindLastEvent: null as string | null,
    };
    // Mind 端不连 DB,这里标 -1 让前端跳过
    schedulerHeartbeat.mindLastEvent = null;

    return {
      timestamp: now.toISOString(),
      overall,
      summary: {
        servicesUp: (mindPing.up ? 1 : 0) + (taskPing.up ? 1 : 0),
        servicesTotal: 2,
        alertsCritical: alerts.filter(a => a.level === "critical").length,
        alertsWarning: alerts.filter(a => a.level === "warning").length,
        alertsInfo: alerts.filter(a => a.level === "info").length,
      },
      services: {
        mind: {
          url: MIND_URL,
          up: mindPing.up,
          latencyMs: mindPing.latencyMs,
          error: mindPing.error,
          state: mindPing.up ? "online" : "offline",
        },
        task: {
          url: TASK_URL,
          up: taskPing.up,
          latencyMs: taskPing.latencyMs,
          error: taskPing.error,
          state: taskPing.up ? "online" : "offline",
        },
      },
      databases: {
        mind: { ...mindDb, size: fmtSize(mindDb.sizeBytes), age: mindDb.ageMinutes !== undefined ? fmtAge(mindDb.ageMinutes) : "—" },
        task: { ...taskDb, size: fmtSize(taskDb.sizeBytes), age: taskDb.ageMinutes !== undefined ? fmtAge(taskDb.ageMinutes) : "—" },
      },
      resources: resourceUsage,
      flywheel: {
        state: flywheelState,
        lastEventAt: flywheelLast?.createdAt?.toISOString() ?? null,
        lastEventStage: flywheelLast?.stage ?? null,
        lastEventTitle: flywheelLast?.sourceTitle?.slice(0, 80) ?? null,
        idleMin: flywheelIdleMin,
        idleLabel: fmtAge(flywheelIdleMin),
        events24h: flywheel24h.reduce((a, b) => a + b._count, 0),
        events1h: flywheel1h.reduce((a, b) => a + b._count, 0),
        byStage24h: Object.fromEntries(flywheel24h.map(f => [f.stage, f._count])),
      },
      reflection: {
        state: reflectionState,
        events24h: reflection24h,
        events1h: reflection1h,
        lastAt: reflectionLast?.createdAt?.toISOString() ?? null,
        lastTitle: reflectionLast?.sourceTitle?.slice(0, 80) ?? null,
        idleMin: reflectionIdleMin,
        idleLabel: fmtAge(reflectionIdleMin),
      },
      taskEngine,
      problemEngine,
      alerts,
      config: {
        system: sysConfig,
        runtime: runtimeCfg,
      },
      scheduler: schedulerHeartbeat,
    };
  }),

  /**
   * 飞轮事件时间线(最近 50 条)
   */
  timeline: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit ?? 50;
      const events = await prisma.flywheelEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true, stage: true, sourceType: true, sourceTitle: true,
          createdAt: true, targetStage: true, targetType: true, targetId: true,
        },
      });
      return events.map(e => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
        idleMin: Math.round((Date.now() - e.createdAt.getTime()) / 60000),
      }));
    }),
});
