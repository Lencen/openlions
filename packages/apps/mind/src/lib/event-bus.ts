/**
 * EventBus 薄壳 — mind 端 (v3.1 平台化, r7.1)
 *
 * 实现下沉到 packages/core/events/dist.
 * mind 端用法:
 *   - DLQ retry 成功/失败: emitSystemError + 新增 DLQ_RETRY_OK/FAIL (定义在核心包)
 *   - SyncSession 完成: emitSessionSynced
 *   - SessionRegistry 抽取完成: emitSystemError (失败) / 写一条新 EXTRACT_DONE
 *
 * outbox 路径: cwd/data/platform-events.jsonl (会落到 mind/data/)
 */
// 遗留#8 (2026-09-01): 原 re-export 不存在的成员 (32 个类型错误 + 运行时 undefined)
//   改为基于 bus.emit 的兼容实现
import { bus } from "@lions/events";

const makeEmit =
  (type: string) =>
  (...args: any[]) =>
    bus.emit(type, { type, data: args, ts: Date.now() });

export { bus };
export const eventBus = bus;
export const defineEvent = (t: string) => makeEmit(t);

export const emitTaskCreated = makeEmit("task:created");
export const emitTaskProcessStart = makeEmit("task:process:start");
export const emitTaskProcessComplete = makeEmit("task:process:complete");
export const emitTaskStarted = makeEmit("task:started");
export const emitTaskCompleted = makeEmit("task:completed");
export const emitTaskFailed = makeEmit("task:failed");
export const emitTaskStatusChanged = makeEmit("task:status:changed");
export const emitTaskRetried = makeEmit("task:retried");
export const emitExecutionRecorded = makeEmit("execution:recorded");
export const emitReviewCreated = makeEmit("review:created");
// 2026-09-18 标注为**已废弃(死代码)**, 不要照它去"补调用方":
//   实测 git log -S emitProblemCreated --all -> 只有 initial commit(该 emit 从未接过调用);
//   且 packages/apps/mind/src 里 Problem 模型**零读零写**, 唯一引用者是 .archived-frontend-20260905 的归档前端;
//   后继是 findings 管道(24h 内 REFLECT 231 次)。详见 file:docs/platform-logic/problem-pipeline-liveness-2026-09-18.md
//   (结论=废弃而非故障; 历史行保留不删; 也不要为一个已废弃子系统建"零产出"告警)。
export const emitProblemCreated = makeEmit("problem:created"); // @deprecated 见上
export const emitProblemProcessStart = makeEmit("problem:process:start"); // @deprecated 见上
export const emitProblemProcessComplete = makeEmit("problem:process:complete"); // @deprecated 见上
export const emitProblemStatusChanged = makeEmit("problem:status:changed");
export const emitProblemResolved = makeEmit("problem:resolved");
export const emitProblemSolved = makeEmit("problem:solved");
export const emitProblemFailed = makeEmit("problem:failed");
export const emitSchedulerTick = makeEmit("scheduler:tick");
export const emitSchedulerTaskBatchStart = makeEmit("scheduler:task:batch:start");
export const emitSchedulerTaskBatchComplete = makeEmit("scheduler:task:batch:complete");
export const emitSchedulerProblemBatchStart = makeEmit("scheduler:problem:batch:start");
export const emitSchedulerProblemBatchComplete = makeEmit("scheduler:problem:batch:complete");
export const emitSystemError = makeEmit("system:error");
export const emitSessionSynced = makeEmit("session:synced");
export const emitSessionBatchStart = makeEmit("session:batch:start");
export const emitSessionBatchComplete = makeEmit("session:batch:complete");
export const emitDlqRetry = makeEmit("dlq:retry");
export const emitDlqRetryTick = makeEmit("dlq:retry:tick");
export const emitExtractDone = makeEmit("extract:done");
export const emitMindSync = makeEmit("mind:sync");
