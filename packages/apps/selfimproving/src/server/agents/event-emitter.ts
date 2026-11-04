/**
 * 调度事件系统 — 统一的事件发射器
 * 用于实时监控 scheduler 的运行状态
 * 
 * 事件同时写入内存buffer（供实时订阅）和文件持久化（解决进程重启丢失问题）
 */
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";

// 事件文件持久化路径
const EVENT_LOG_FILE = path.join("/data~@uos/00 ai agent/claude code/test/lions-selfimproving-task/data", "scheduler-events.jsonl");
const MAX_EVENTS_IN_MEMORY = 100;

// 调试：确认路径
console.log("[SchedulerEventLog] Event log file:", EVENT_LOG_FILE);

// 事件类型定义
export type SchedulerEventType =
  | "SCHEDULER_TICK"           // 调度器触发
  | "PROBLEM_PROCESS_START"    // 问题处理开始
  | "PROBLEM_PROCESS_COMPLETE" // 问题处理完成
  | "PROBLEM_RESOLVED"         // 单个问题已解决
  | "PROBLEM_FAILED"           // 单个问题失败
  | "TASK_PROCESS_START"       // 任务处理开始
  | "TASK_PROCESS_COMPLETE"    // 任务处理完成
  | "TASK_COMPLETED"           // 单个任务完成
  | "TASK_FAILED"              // 单个任务失败
  | "SCHEDULER_PROBLEM_BATCH_START"    // 问题批处理开始
  | "SCHEDULER_PROBLEM_BATCH_COMPLETE" // 问题批处理完成
  | "ERROR";                   // 错误事件

export interface SchedulerEvent {
  type: SchedulerEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// 单例 EventEmitter
class SchedulerEventEmitter extends EventEmitter {
  private static instance: SchedulerEventEmitter;

  private constructor() {
    super();
    // 设置最大监听器数量，避免警告
    this.setMaxListeners(100);
  }

  static getInstance(): SchedulerEventEmitter {
    if (!SchedulerEventEmitter.instance) {
      SchedulerEventEmitter.instance = new SchedulerEventEmitter();
    }
    return SchedulerEventEmitter.instance;
  }

  /**
   * 发射调度事件
   * 同时写入内存buffer和文件持久化
   */
  emitEvent(type: SchedulerEventType, data: Record<string, unknown> = {}) {
    const event: SchedulerEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    this.emit("event", event);

    // 同时持久化到文件（异步，不阻塞事件发射）
    try {
      // 确保data目录存在
      const dir = path.dirname(EVENT_LOG_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // 追加到文件
      fs.appendFileSync(EVENT_LOG_FILE, JSON.stringify(event) + "\n");
      
      // 限制文件大小，只保留最近10000条
      const stats = fs.statSync(EVENT_LOG_FILE);
      if (stats.size > 5 * 1024 * 1024) { // 5MB
        // 读取最后10000行
        const content = fs.readFileSync(EVENT_LOG_FILE, "utf-8");
        const lines = content.split("\n").filter(l => l.trim());
        const keepLines = lines.slice(-10000);
        fs.writeFileSync(EVENT_LOG_FILE, keepLines.join("\n") + "\n");
      }
    } catch (error) {
      console.error("[SchedulerEventLog] Failed to persist event:", error);
    }
  }

  /**
   * 订阅调度事件
   */
  onEvent(callback: (event: SchedulerEvent) => void) {
    this.on("event", callback);
    return () => this.off("event", callback);
  }
}

export const schedulerEvents = SchedulerEventEmitter.getInstance();

// 便捷方法：发射各类事件
export function emitSchedulerTick(scheduler: "TASK" | "PROBLEM", processed: number) {
  schedulerEvents.emitEvent("SCHEDULER_TICK", { scheduler, processed });
}

export function emitProblemProcessStart(count: number) {
  schedulerEvents.emitEvent("PROBLEM_PROCESS_START", { count });
}

export function emitProblemProcessComplete(results: { processed: number; resolved: number; errors: string[] }) {
  schedulerEvents.emitEvent("PROBLEM_PROCESS_COMPLETE", results);
}

export function emitProblemResolved(problemId: string, severity: string, rootCause?: string) {
  schedulerEvents.emitEvent("PROBLEM_RESOLVED", { problemId, severity, rootCause });
}

export function emitProblemFailed(problemId: string, error: string) {
  schedulerEvents.emitEvent("PROBLEM_FAILED", { problemId, error });
}

export function emitTaskProcessStart(count: number) {
  schedulerEvents.emitEvent("TASK_PROCESS_START", { count });
}

export function emitTaskProcessComplete(results: { processed: number; completed: number; failed: number; errors: string[] }) {
  schedulerEvents.emitEvent("TASK_PROCESS_COMPLETE", results);
}

export function emitTaskCompleted(taskId: string, title: string) {
  schedulerEvents.emitEvent("TASK_COMPLETED", { taskId, title });
}

export function emitTaskFailed(taskId: string, error: string) {
  schedulerEvents.emitEvent("TASK_FAILED", { taskId, error });
}

export function emitError(source: string, error: string) {
  schedulerEvents.emitEvent("ERROR", { source, error });
}