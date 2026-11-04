/**
 * EventBus 薄壳 (V3.1 平台化)
 *
 * 让 lsession 走 @lions/events 平台事件.
 * 老代码不引用本地 event-bus/index.ts — 这个薄壳是新增接入点.
 *
 * ===== 2026-10-12 round 72-AL 修(实测真缺陷) =====
 * 本文件原来是纯粹的"再导出":
 *     export { bus, defineEvent, emitSessionSynced, emitSessionBatchStart,
 *              emitSessionBatchComplete, emitSystemError } from "@lions/events";
 * 但 @lions/events 只导出 **bus**(和一个 default), 那 5 个名字**一个都不存在**。
 *
 * 后果不是"少几个类型提示", 而是真故障: app/api/sync/route.ts 的 POST 里直接调用
 * emitSessionBatchStart(...), 而它是 undefined —— 实测:
 *     POST /api/sync -> HTTP 500
 *     {"error":"TypeError: (0 , _lib_event_bus__WEBPACK_IMPORTED_MODULE_6__.emitSessionBatchStart) is not a function"}
 * 也就是**手动触发会话同步的入口一直是坏的**(GET 走的是另一支, 所以没被注意)。
 * tsc 早就报了 5 条 TS2614(有提示 default 导入), 但 session 跑 dev 模式不做全量类型检查,
 * 于是这个缺陷躺了很久 —— 它也是 session 一直无法生产构建的原因之一。
 *
 * 修法: 按调用处的**实际形态**(source / count / ms)实现这三个函数, 转发到 bus.emit。
 * 注意 bus 是**进程内**事件总线(内存 Map), 不做跨进程投递 —— 这里只保证"调用不再抛错、
 * 事件语义按调用处声明的形状发出去", 不假装它是持久化/跨进程的消息队列。
 */
import { bus } from "@lions/events";

export { bus };

/** 一批同步开始 (source: "local" | "mind") */
export function emitSessionBatchStart(source: string): void {
  bus.emit("session.batch.start", { source, at: Date.now() });
}

/** 一批同步结束: source / 条数 / 耗时(ms) */
export function emitSessionBatchComplete(source: string, count: number, ms: number): void {
  bus.emit("session.batch.complete", { source, count, ms, at: Date.now() });
}

/** 一次同步完成: source / 条数 / 耗时(ms) */
export function emitSessionSynced(source: string, count: number, ms: number): void {
  bus.emit("session.synced", { source, count, ms, at: Date.now() });
}

/** 通用系统错误事件 */
export function emitSystemError(message: string, detail?: unknown): void {
  bus.emit("system.error", { message, detail, at: Date.now() });
}
