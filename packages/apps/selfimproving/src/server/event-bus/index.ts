/**
 * EventBus — 统一事件总线 (V2.0)
 *
 * 支持：
 * 1. 同进程内订阅/发布（内存事件）
 * 2. 跨进程事件传播（文件日志）
 * 3. WebSocket 广播（Socket.IO）
 *
 * 事件类型：
 * - TASK_* : 任务生命周期事件
 * - PROBLEM_* : 问题生命周期事件
 * - EXECUTION_* : 执行记录事件
 * - REVIEW_* : 评审事件
 * - SCHEDULER_* : 调度器事件
 * - SYSTEM_* : 系统事件
 */
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
// v3.1 平台化 (selfimproving 接入): 把本地事件转发到平台总线 @lions/events,
// 写 cwd/data/platform-events.jsonl, 供 EventCollector / mind 跨服务消费.
// 注意: 这里是 dual-write 桥接, 不替换 v2 本地能力 (WS 广播 / onType / getRecentEvents).
import { bus as platformBus } from "@lions/events";

// ─── 类型定义 ────────────────────────────────────────────────
export type EventType =
  // Task events
  | "TASK_CREATED"
  | "TASK_STARTED"
  | "TASK_COMPLETED"
  | "TASK_FAILED"
  | "TASK_CANCELLED"
  | "TASK_DELETED"
  | "TASK_STATUS_CHANGED"
  | "TASK_RETRY"
  // Execution events
  | "EXECUTION_CREATED"
  | "EXECUTION_RECORDED"
  | "EXECUTION_COMPLETED"
  // Review events
  | "REVIEW_CREATED"
  | "REVIEW_COMPLETED"
  // Problem events
  | "PROBLEM_CREATED"
  | "PROBLEM_STATUS_CHANGED"
  | "PROBLEM_SOLVED"
  | "PROBLEM_RESOLVED"
  | "PROBLEM_FAILED"
  // Scheduler events
  | "SCHEDULER_TICK"
  | "SCHEDULER_TASK_BATCH_START"
  | "SCHEDULER_TASK_BATCH_COMPLETE"
  | "SCHEDULER_PROBLEM_BATCH_START"
  | "SCHEDULER_PROBLEM_BATCH_COMPLETE"
  // System
  | "SYSTEM_ERROR"
  | "PRIORITY_ADJUSTED";

export interface BusEvent<T = unknown> {
  id: string;           // 唯一事件ID
  type: EventType;     // 事件类型
  timestamp: number;   // Unix ms
  actor: string;        // 触发者
  payload: T;          // 事件数据
}

export type EventHandler<T = unknown> = (event: BusEvent<T>) => void | Promise<void>;

// ─── EventBus 实现（用 EventEmitter 做内部实现，不继承）──────────
class EventBus {
  private static instance: EventBus;
  private emitter = new EventEmitter();
  private logFile: string;
  private wsEmitFn: ((event: BusEvent) => void) | null = null;

  private constructor() {
    this.emitter.setMaxListeners(100);

    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.logFile = path.join(dataDir, "event-bus.jsonl");

    if (!fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, "");
    }
  }

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  /** 注册 WebSocket 广播函数（由 WebSocket Server 调用） */
  setWsEmitter(fn: (event: BusEvent) => void) {
    this.wsEmitFn = fn;
  }

  /** 发布事件 */
  emit<T = unknown>(type: EventType, payload: T, actor = "system"): BusEvent<T> {
    const event: BusEvent<T> = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: Date.now(),
      actor,
      payload,
    };

    // 1. 内存事件（同步）
    this.emitter.emit("event", event);

    // 2. 持久化到文件（异步，不阻塞）
    this.persistEvent(event);

    // 3. WebSocket 广播（如果已设置）
    if (this.wsEmitFn) {
      this.wsEmitFn(event);
    }

    // 4. v3.1 平台总线 dual-write — 转发到 @lions/events outbox
    //    (写 cwd/data/platform-events.jsonl, 供 EventCollector / mind 跨服务消费).
    //    错误隔离: 平台转发失败不影响本地 v2 行为.
    try {
      platformBus.publish({
        type: event.type,
        payload: event.payload as unknown,
        actor: event.actor,
        source: "selfimproving",
      });
    } catch (err) {
      console.error("[EventBus] platform dual-write error:", err);
    }

    return event;
  }

  /** 订阅事件 */
  on<T = unknown>(type: EventType | "*", handler: EventHandler<T>): () => void {
    if (type === "*") {
      this.emitter.on("event", handler as EventHandler);
    } else {
      const wrapper: EventHandler = (event) => {
        if ((event as BusEvent).type === type) handler(event as BusEvent<T>);
      };
      this.emitter.on("event", wrapper);
    }
    return () => this.off(type, handler);
  }

  /** 取消订阅 */
  off<T = unknown>(type: EventType | "*", handler: EventHandler<T>): void {
    if (type === "*") {
      this.emitter.off("event", handler as EventHandler);
    } else {
      // 移除所有匹配类型的 wrapper（精确匹配需额外处理，这里简化）
      this.emitter.off("event", handler as EventHandler);
    }
  }

  /** 订阅指定类型事件（仅匹配 type 字段） */
  onType<T = unknown>(type: EventType, handler: EventHandler<T>): () => void {
    const wrapper: EventHandler = (event) => {
      if ((event as BusEvent).type === type) {
        handler(event as BusEvent<T>);
      }
    };
    this.emitter.on("event", wrapper);
    return () => this.emitter.off("event", wrapper);
  }

  /** 获取最近 N 条事件（从文件） */
  getRecentEvents(limit = 100): BusEvent[] {
    try {
      const content = fs.readFileSync(this.logFile, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      return lines
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line) as BusEvent;
          } catch {
            return null;
          }
        })
        .filter(Boolean) as BusEvent[];
    } catch {
      return [];
    }
  }

  private persistEvent(event: BusEvent) {
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(event) + "\n");

      const stats = fs.statSync(this.logFile);
      if (stats.size > 5 * 1024 * 1024) {
        const lines = fs.readFileSync(this.logFile, "utf-8").split("\n").filter((l) => l.trim());
        fs.writeFileSync(this.logFile, lines.slice(-10000).join("\n") + "\n");
      }
    } catch (err) {
      console.error("[EventBus] Persist error:", err);
    }
  }
}

// 单例
export const eventBus = EventBus.getInstance();

// ─── 便捷发射方法 ────────────────────────────────────────────
export function emitTaskCreated(taskId: string, title: string, priority: string, actor = "scheduler") {
  return eventBus.emit("TASK_CREATED", { taskId, title, priority }, actor);
}

export function emitTaskStarted(taskId: string, executionId: string, actor = "scheduler") {
  return eventBus.emit("TASK_STARTED", { taskId, executionId }, actor);
}

export function emitTaskCompleted(taskId: string, title: string, executionId: string, actor = "scheduler") {
  return eventBus.emit("TASK_COMPLETED", { taskId, title, executionId }, actor);
}

export function emitTaskFailed(taskId: string, error: string, retryCount: number, actor = "scheduler") {
  return eventBus.emit("TASK_FAILED", { taskId, error, retryCount }, actor);
}

export function emitTaskStatusChanged(taskId: string, oldStatus: string, newStatus: string, actor = "scheduler") {
  return eventBus.emit("TASK_STATUS_CHANGED", { taskId, oldStatus, newStatus }, actor);
}

export function emitTaskRetried(taskId: string, retryCount: number, reason: string, actor = "scheduler") {
  return eventBus.emit("TASK_RETRY", { taskId, retryCount, reason }, actor);
}

export function emitExecutionRecorded(taskId: string, executionId: string, status: string, actor = "scheduler") {
  return eventBus.emit("EXECUTION_RECORDED", { taskId, executionId, status }, actor);
}

export function emitReviewCreated(taskId: string, reviewId: string, reviewType: string, actor = "scheduler") {
  return eventBus.emit("REVIEW_CREATED", { taskId, reviewId, reviewType }, actor);
}

export function emitProblemCreated(problemId: string, taskId: string, description: string, severity: string, actor = "scheduler") {
  return eventBus.emit("PROBLEM_CREATED", { problemId, taskId, description, severity }, actor);
}

export function emitProblemStatusChanged(problemId: string, oldStatus: string, newStatus: string, actor = "system") {
  return eventBus.emit("PROBLEM_STATUS_CHANGED", { problemId, oldStatus, newStatus }, actor);
}

export function emitProblemSolved(problemId: string, rootCause: string, solution: string, actor = "problem-resolver") {
  return eventBus.emit("PROBLEM_SOLVED", { problemId, rootCause, solution }, actor);
}

export function emitProblemFailed(problemId: string, error: string, actor = "problem-resolver") {
  return eventBus.emit("PROBLEM_FAILED", { problemId, error }, actor);
}

export function emitSchedulerTick(scheduler: "TASK" | "PROBLEM", processed: number) {
  return eventBus.emit("SCHEDULER_TICK", { scheduler, processed, ts: Date.now() }, "scheduler");
}

export function emitSchedulerTaskBatchComplete(processed: number, completed: number, failed: number, errors: string[], actor = "scheduler") {
  return eventBus.emit("SCHEDULER_TASK_BATCH_COMPLETE", { processed, completed, failed, errors }, actor);
}

export function emitSchedulerProblemBatchComplete(result: { processed: number; resolved: number; errors: string[] }, actor = "problem-resolver") {
  return eventBus.emit("SCHEDULER_PROBLEM_BATCH_COMPLETE", result, actor);
}

export function emitSystemError(source: string, error: string, context?: Record<string, unknown>) {
  return eventBus.emit("SYSTEM_ERROR", { source, error, context }, source);
}

export function emitPriorityAdjusted(taskId: string, oldScore: number, newScore: number, actor = "priority-adjuster") {
  return eventBus.emit("PRIORITY_ADJUSTED", { taskId, oldScore, newScore }, actor);
}

// ─── Scheduler convenience functions ────────────────────────
export function emitTaskProcessStart(count: number, actor = "scheduler") {
  return eventBus.emit("SCHEDULER_TASK_BATCH_START", { count }, actor);
}

export function emitTaskProcessComplete(result: { processed: number; completed: number; failed: number; errors: string[] }, actor = "scheduler") {
  return eventBus.emit("SCHEDULER_TASK_BATCH_COMPLETE", result, actor);
}

export function emitProblemProcessStart(count: number, actor = "problem-resolver") {
  return eventBus.emit("SCHEDULER_PROBLEM_BATCH_START", { count }, actor);
}

export function emitProblemProcessComplete(result: { processed: number; resolved: number; errors: string[] }, actor = "problem-resolver") {
  return eventBus.emit("SCHEDULER_PROBLEM_BATCH_COMPLETE", result, actor);
}

export function emitProblemResolved(problemId: string, severity: string, rootCause: string, actor = "problem-resolver") {
  return eventBus.emit("PROBLEM_RESOLVED", { problemId, severity, rootCause }, actor);
}

