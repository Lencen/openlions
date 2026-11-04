/**
 * Scheduler Event Router — 实时调度事件查询
 *
 * 提供实时的调度器运行状态和最近事件流
 * 前端通过轮询获取最新状态
 * 事件从文件持久化存储加载，支持进程重启后恢复
 */

import { createRouter, publicProcedure } from "../trpc";
import { type SchedulerEvent, type SchedulerEventType } from "../agents/event-emitter";
import { z } from "zod";
import fs from "fs";
import path from "path";

// 事件文件路径
const EVENT_LOG_FILE = path.join(process.cwd(), "data", "scheduler-events.jsonl");

// 事件缓冲区 — 保留最近100条事件
const eventBuffer: SchedulerEvent[] = [];
const MAX_BUFFER = 100;

// 当前状态
let lastTick = {
  TASK: { timestamp: "", processed: 0 },
  PROBLEM: { timestamp: "", processed: 0 },
};

// 延迟初始化 eventBus 相关
let eventBusRef: any = null;
let initializationAttempted = false;

function getEventBus() {
  if (eventBusRef) return eventBusRef;
  if (initializationAttempted) return null;
  initializationAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../event-bus");
    eventBusRef = mod.eventBus;

    // 加载历史事件
    try {
      const recentEvents = eventBusRef.getRecentEvents(MAX_BUFFER);
      for (const event of recentEvents) {
        eventBuffer.push({
          type: event.type as SchedulerEventType,
          timestamp: new Date(event.timestamp).toISOString(),
          data: event.payload as Record<string, unknown>,
        });
      }
      for (const event of recentEvents.slice(-50)) {
        if (event.type === "SCHEDULER_TICK") {
          const scheduler = (event.payload as any).scheduler as "TASK" | "PROBLEM";
          if (scheduler) {
            lastTick[scheduler] = { timestamp: new Date(event.timestamp).toISOString(), processed: (event.payload as any).processed as number };
          }
        }
      }
      console.log(`[scheduler-event] Loaded ${eventBuffer.length} historical events into buffer`);
    } catch (e) {
      console.warn("[scheduler-event] Failed to load historical events:", e);
    }

    // 订阅新事件
    eventBusRef.on("*", (event: any) => {
      eventBuffer.push({
        type: event.type as SchedulerEventType,
        timestamp: new Date(event.timestamp).toISOString(),
        data: event.payload as Record<string, unknown>,
      });
      if (eventBuffer.length > MAX_BUFFER) {
        eventBuffer.shift();
      }
    });

    eventBusRef.onType("SCHEDULER_TICK", (event: any) => {
      const scheduler = event.payload.scheduler as "TASK" | "PROBLEM";
      if (scheduler) {
        lastTick[scheduler] = { timestamp: new Date(event.timestamp).toISOString(), processed: event.payload.processed as number };
      }
    });

    console.log("[scheduler-event] Subscribed to eventBus");
    return eventBusRef;
  } catch (e) {
    console.warn("[scheduler-event] Failed to get eventBus:", e);
    return null;
  }
}

// 确保在首次调用时初始化
getEventBus();

/**
 * 从event-bus.jsonl读取最近的事件
 */
function loadEventsFromEventBus(limit: number = 100): SchedulerEvent[] {
  const EVENT_BUS_FILE = path.join(process.cwd(), "data", "event-bus.jsonl");
  try {
    if (!fs.existsSync(EVENT_BUS_FILE)) return [];

    const content = fs.readFileSync(EVENT_BUS_FILE, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());

    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const events: SchedulerEvent[] = [];

    for (const line of lines) {
      try {
        const busEvent = JSON.parse(line);
        // Handle both ISO string timestamps and Unix ms numeric timestamps
        const eventTime = typeof busEvent.timestamp === "number"
          ? busEvent.timestamp
          : new Date(busEvent.timestamp).getTime();
        if (eventTime < oneWeekAgo) continue;
        if (busEvent.type === "SCHEDULER_TICK") {
          events.push({
            type: busEvent.type as SchedulerEventType,
            timestamp: eventTime,
            data: busEvent.payload || {},
          });
        }
      } catch {}
    }

    return events.slice(-limit);
  } catch {
    return [];
  }
}

/**
 * 从文件加载最近的事件
 */
function loadRecentEventsFromFile(sinceTimestamp?: string): SchedulerEvent[] {
  try {
    if (!fs.existsSync(EVENT_LOG_FILE)) return [];

    const content = fs.readFileSync(EVENT_LOG_FILE, "utf-8");
    const lines = content.split("\n").filter(l => l.trim());

    const events: SchedulerEvent[] = [];
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000; // 保留最近7天的事件

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as SchedulerEvent;
        const eventTime = new Date(event.timestamp).getTime();
        if (sinceTimestamp && eventTime < new Date(sinceTimestamp).getTime()) continue;
        if (eventTime > oneWeekAgo) {
          events.push(event);
        }
      } catch {}
    }

    return events.slice(-200); // 返回最近200条
  } catch {
    return [];
  }
}

/**
 * 合并多个事件源并按时间降序排列
 */
function mergeAndSortEvents(fileEvents: SchedulerEvent[], busEvents: SchedulerEvent[]): SchedulerEvent[] {
  const seen = new Set<string>();
  const unique: SchedulerEvent[] = [];

  // 按时间降序排列：新的在前
  const all = [...fileEvents, ...busEvents].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  for (const e of all) {
    const key = `${e.type}-${e.timestamp}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(e);
    }
  }
  return unique;
}

export const schedulerEventRouter = createRouter({
  /**
   * 获取当前调度器状态和最近事件
   * 优先使用内存中的eventBuffer，文件作为备份
   */
  getStatus: publicProcedure.query(async () => {
    // 确保已初始化
    getEventBus();

    const now = Date.now();

    // 从 eventBus 读取最近事件（合并 event-bus.jsonl 和 scheduler-events.jsonl）
    const busEvents = loadEventsFromEventBus(200);
    const fileEvents = loadRecentEventsFromFile();
    const allEvents = mergeAndSortEvents(fileEvents, busEvents);

    // 使用合并后的事件
    const taskTickEvents = allEvents.filter(e => e.type === "SCHEDULER_TICK" && (e.data as any)?.scheduler === "TASK");
    const problemTickEvents = allEvents.filter(e => e.type === "SCHEDULER_TICK" && (e.data as any)?.scheduler === "PROBLEM");

    // lastTick[0] = newest because events are sorted newest-first
    const lastTaskTick = taskTickEvents[0] ?? null;
    const lastProblemTick = problemTickEvents[0] ?? null;

    const taskActive = lastTaskTick
      ? (now - new Date(lastTaskTick.timestamp).getTime()) < 60000 // 1分钟内
      : false;
    const problemActive = lastProblemTick
      ? (now - new Date(lastProblemTick.timestamp).getTime()) < 120000 // 2分钟内
      : false;

    return {
      taskScheduler: {
        lastRun: lastTaskTick?.timestamp || "",
        isActive: taskActive,
      },
      problemScheduler: {
        lastRun: lastProblemTick?.timestamp || "",
        isActive: problemActive,
      },
      recentEvents: allEvents.slice(0, 20),
      totalEvents: allEvents.length,
    };
  }),

  /**
   * 获取事件流 — 用于实时监控面板
   * 返回指定数量的事件
   */
  getEvents: publicProcedure
    .input(
      z.object({ limit: z.number().default(50), offset: z.number().default(0) })
    )
    .query(async ({ input }) => {
      // 确保已初始化
      getEventBus();

      const { limit, offset } = input;
      // 合并内存buffer、scheduler-events.jsonl和event-bus.jsonl
      const fileEvents = loadRecentEventsFromFile();
      const busEvents = loadEventsFromEventBus(200);
      const allEvents = mergeAndSortEvents([...fileEvents, ...eventBuffer], busEvents);
      return {
        events: allEvents.slice(offset, offset + limit),
        total: allEvents.length,
        hasMore: allEvents.length > offset + limit,
      };
    }),

  /**
   * 获取问题处理的实时状态
   */
  getProblemStats: publicProcedure.query(async () => {
    // 确保已初始化
    getEventBus();

    const stats = {
      open: 0,
      solving: 0,
      solved: 0,
      total: 0,
    };

    // 从合并事件中获取状态
    const busEvents = loadEventsFromEventBus(200);
    const fileEvents = loadRecentEventsFromFile();
    const allEvents = mergeAndSortEvents(fileEvents, busEvents);

    let currentlyProcessing = false;
    let lastProcessed = "";

    for (const event of allEvents.slice(0, 50)) {
      if (event.type === "SCHEDULER_PROBLEM_BATCH_START" || event.type === "PROBLEM_PROCESS_START") {
        currentlyProcessing = true;
      }
      if (event.type === "SCHEDULER_PROBLEM_BATCH_COMPLETE" || event.type === "PROBLEM_PROCESS_COMPLETE") {
        currentlyProcessing = false;
        lastProcessed = event.timestamp;
      }
    }

    return {
      ...stats,
      currentlyProcessing,
      lastProcessed,
    };
  }),
});