/**
 * 飞轮统一日志 - LIONS Flywheel Structured Logger
 *
 * 三层日志架构 (2026-08-21 agent-x 设计):
 * - L1 文本: stdout → /tmp/lions-flywheel.log, 人读
 * - L2 JSON:  stdout → /tmp/lions-flywheel.jsonl, 机读 (dashboard / grep -j)
 * - L3 DB:   FlywheelEvent / FlywheelJob / FlywheelReflection / FlywheelErrorLog (新增)
 *
 * traceId: 每次完整飞轮循环一个 UUID v4, 全链路传递, 方便追踪单循环.
 *
 * 5 阶段埋点 (withStage 自动打):
 *   [scan] / [extract] / [write] / [reflect] / [structure]
 *
 * 用法:
 *   const traceId = createTraceId();
 *   setTraceId(traceId);
 *   await withStage('extract', { sessions: 5 }, async (log) => {
 *     log('progress', { done: 2 });
 *     return { extracted: 42 };
 *   });
 */

import { randomUUID } from 'crypto';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ============================================================
// 配置
// ============================================================

// B-3/B-4 修复: 文件名带 PID 避免多进程互相覆盖
// cron 和手动 run 各自有独立日志文件, 不再共享
const _PID = process.pid;
const L1_LOG = process.env.FLYWHEEL_LOG_L1 || `/tmp/lions-flywheel-${_PID}.log`;
const L2_LOG = process.env.FLYWHEEL_LOG_L2 || `/tmp/lions-flywheel-${_PID}.jsonl`;

// 不再启动时 truncate (多进程会互相覆盖)
function ensureDirs() {
  for (const p of [L1_LOG, L2_LOG]) {
    if (!existsSync(p)) {
      try { mkdirSync(dirname(p), { recursive: true }); } catch {}
    }
  }
}

let _dirsReady = false;
function initDirs() {
  if (!_dirsReady) {
    ensureDirs();
    _dirsReady = true;
  }
}

// ============================================================
// traceId 上下文 (AsyncLocalStorage, 跨 await 传递)
// ============================================================

import { AsyncLocalStorage } from 'async_hooks';

interface TraceContext {
  traceId: string;
  startTime: number;
  stages: Record<string, { start: number; end?: number; status?: string }>;
}

const _als = new AsyncLocalStorage<TraceContext>();

export function createTraceId(): string {
  return randomUUID();
}

export function setTraceId(traceId: string): void {
  const ctx: TraceContext = {
    traceId,
    startTime: Date.now(),
    stages: {},
  };
  // 进入新 traceId 上下文
  _als.enterWith(ctx);
}

export function getTraceContext(): TraceContext | undefined {
  return _als.getStore();
}

export function getTraceId(): string | undefined {
  return _als.getStore()?.traceId;
}

// ============================================================
// 核心 log 函数
// ============================================================

export type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogEntry {
  ts: string;            // ISO 时间
  level: Level;
  module: string;        // flywheel / scan / extract / write / reflect / structure
  stage?: string;        // ENTER / PROGRESS / EXIT
  traceId?: string;
  msg: string;           // 一句话描述
  data?: Record<string, any>;  // 任意 KV (数字/字符串/对象)
  durationMs?: number;
}

function getCurrentTraceId(): string | undefined {
  return _als.getStore()?.traceId;
}

function emit(entry: LogEntry) {
  initDirs();

  // L1: 文本格式 - 人读
  const l1Parts: string[] = [
    `[${entry.ts}]`,
    `[${entry.level}]`,
  ];
  if (entry.module) l1Parts.push(`[${entry.module}]`);
  if (entry.stage) l1Parts.push(`[${entry.stage}]`);
  if (entry.traceId) l1Parts.push(`[trace=${entry.traceId.slice(0, 8)}]`);
  l1Parts.push(entry.msg);
  if (entry.data) {
    const flatData: string[] = [];
    for (const [k, v] of Object.entries(entry.data)) {
      if (v === undefined || v === null) continue;
      let s: string;
      if (typeof v === 'string') s = `"${v}"`;
      else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
      else s = summarize(v);  // 2026-08-21: 用 summarize 避免大对象爆日志
      flatData.push(`${k}=${s}`);
    }
    if (flatData.length) l1Parts.push(flatData.join(' '));
  }
  if (entry.durationMs !== undefined) {
    l1Parts.push(`durationMs=${entry.durationMs}`);
  }
  const l1Line = l1Parts.join(' ') + '\n';

  // L2: JSON - 机读 (不限制大小, 完整数据留作分析)
  // 2026-08-21 agent-x: P3 修复 -- 错误消息可能含真实换行符 (API 响应多行文本)
  //   JSON.stringify 会转义 \n, 但为防御性, 先 sanitize 所有字符串
  function sanitizeNewlines(obj: any): any {
    if (typeof obj === 'string') return obj.replace(/[\r\n]+/g, ' ');
    if (obj && typeof obj === 'object') {
      const r: any = Array.isArray(obj) ? [] : {};
      for (const k of Object.keys(obj)) r[k] = sanitizeNewlines(obj[k]);
      return r;
    }
    return obj;
  }
  const l2Entry = sanitizeNewlines({ ...entry });
  if (l2Entry.data) {
    // L2 也不展开超过 100KB, 但保留完整 type 信息
    l2Entry.data = deepTruncate(l2Entry.data, 100_000);
  }
  const l2Line = JSON.stringify(l2Entry) + '\n';

  try { appendFileSync(L1_LOG, l1Line); } catch {}
  try { appendFileSync(L2_LOG, l2Line); } catch {}

  // 不写 stdout (cron 自己 redirect 到 L1, 避免双重)
  // 调试时可打开: try { process.stdout.write(l1Line); } catch {}
}

/**
 * 摘要对象 - L1 友好格式
 * - 数组: [length=N, first=...]
 * - 对象: {key1, key2, ...}
 * - 大字符串: 截前 100 字符
 */
function summarize(v: any, depth = 0): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') {
    return v.length > 100 ? `"${v.slice(0, 100)}..."` : `"${v}"`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (depth > 1) return `[len=${v.length}]`;
    const first = summarize(v[0], depth + 1);
    return `[len=${v.length},first=${first}]`;
  }
  if (typeof v === 'object') {
    if (depth > 1) return '{...}';
    const keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    const preview = keys.slice(0, 5).map(k => `${k}=${summarize(v[k], depth + 1)}`).join(',');
    return `{${preview}${keys.length > 5 ? `, +${keys.length - 5}more` : ''}}`;
  }
  return String(v);
}

/**
 * 深截断 - L2 JSON 防爆
 */
function deepTruncate(v: any, maxBytes: number): any {
  const json = JSON.stringify(v);
  if (json.length <= maxBytes) return v;
  // 替换大字符串 + 大数组
  if (Array.isArray(v)) return { __truncated: true, type: 'array', length: v.length, preview: v.slice(0, 3) };
  if (typeof v === 'string') return v.slice(0, maxBytes / 2) + '...[truncated]';
  if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v);
    return {
      __truncated: true,
      type: 'object',
      keys: keys.length,
      preview: Object.fromEntries(keys.slice(0, 5).map(k => [k, deepTruncate(v[k], maxBytes / keys.length)])),
    };
  }
  return v;
}

/**
 * 通用 log - 模块内调用
 */
export function log(
  module: string,
  msg: string,
  data?: Record<string, any>,
  level: Level = 'INFO',
  stage?: string,
) {
  emit({
    ts: new Date().toISOString(),
    level,
    module,
    stage,
    traceId: getCurrentTraceId(),
    msg,
    data,
  });
}

// ============================================================
// 便捷模块 logger (省去每次传 module)
// ============================================================

export function makeLogger(module: string) {
  return {
    info: (msg: string, data?: Record<string, any>) => log(module, msg, data, 'INFO'),
    warn: (msg: string, data?: Record<string, any>) => log(module, msg, data, 'WARN'),
    error: (msg: string, data?: Record<string, any>) => log(module, msg, data, 'ERROR'),
    debug: (msg: string, data?: Record<string, any>) => log(module, msg, data, 'DEBUG'),
    progress: (msg: string, data?: Record<string, any>) =>
      log(module, msg, data, 'INFO', 'PROGRESS'),
  };
}

// ============================================================
// withStage - 阶段埋点高阶函数 (5 阶段必须用)
// ============================================================

export interface StageResult<T> {
  ok: boolean;
  durationMs: number;
  output?: T;
  error?: Error;
}

export type ProgressCallback = (msg: string, data?: Record<string, any>) => void;

/**
 * 包装一个异步函数, 自动打 ENTER/PROGRESS/EXIT 三类日志.
 *
 * @param stage 阶段名 - scan / extract / write / reflect / structure
 * @param input  输入摘要 (会被记入 ENTER log)
 * @param fn    业务函数, 返回 output + 可调 log.progress() 报告进度
 */
export async function withStage<T = any>(
  stage: string,
  input: Record<string, any>,
  fn: (progress: ProgressCallback) => Promise<T>,
): Promise<StageResult<T>> {
  initDirs();
  const ctx = _als.getStore();
  const traceId = ctx?.traceId;
  const stageStart = Date.now();

  // ENTER
  emit({
    ts: new Date().toISOString(),
    level: 'INFO',
    module: stage,
    stage: 'ENTER',
    traceId,
    msg: `stage="${stage}" enter`,
    data: input,
  });

  // 注册到 trace 上下文
  if (ctx) {
    ctx.stages[stage] = { start: stageStart };
  }

  let ok = true;
  let output: T | undefined;
  let error: Error | undefined;

  const progress: ProgressCallback = (msg, data) => {
    emit({
      ts: new Date().toISOString(),
      level: 'INFO',
      module: stage,
      stage: 'PROGRESS',
      traceId,
      msg,
      data,
    });
  };

  try {
    output = await fn(progress);
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e : new Error(String(e));
  }

  const durationMs = Date.now() - stageStart;

  // EXIT
  emit({
    ts: new Date().toISOString(),
    level: ok ? 'INFO' : 'ERROR',
    module: stage,
    stage: 'EXIT',
    traceId,
    msg: ok
      ? `stage="${stage}" ok`
      : `stage="${stage}" failed: ${error?.message?.slice(0, 200) || 'unknown'}`,
    data: ok && typeof output === 'object' && output !== null
      ? (output as any)
      : undefined,
    durationMs,
  });

  if (ctx) {
    ctx.stages[stage].end = Date.now();
    ctx.stages[stage].status = ok ? 'OK' : 'FAILED';
  }

  return { ok, durationMs, output, error };
}

// ============================================================
// runWithTrace - 整个飞轮 tick 包一层 traceId
// ============================================================

export async function runWithTrace<T = any>(
  fn: () => Promise<T>,
): Promise<T> {
  initDirs();
  const traceId = createTraceId();
  setTraceId(traceId);

  emit({
    ts: new Date().toISOString(),
    level: 'INFO',
    module: 'flywheel',
    stage: 'TICK_START',
    traceId,
    msg: 'flywheel tick start',
  });

  const tickStart = Date.now();
  let result: T;
  let error: Error | undefined;

  try {
    result = await fn();
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    emit({
      ts: new Date().toISOString(),
      level: 'ERROR',
      module: 'flywheel',
      stage: 'TICK_END',
      traceId,
      msg: `flywheel tick failed: ${error.message}`,
      durationMs: Date.now() - tickStart,
    });
    throw error;
  }

  const totalDurationMs = Date.now() - tickStart;

  // 总结各阶段耗时
  const ctx = _als.getStore();
  const stageSummary: Record<string, number> = {};
  if (ctx) {
    for (const [name, info] of Object.entries(ctx.stages)) {
      if (info.end) stageSummary[name] = info.end - info.start;
    }
  }

  emit({
    ts: new Date().toISOString(),
    level: 'INFO',
    module: 'flywheel',
    stage: 'TICK_END',
    traceId,
    msg: 'flywheel tick end',
    durationMs: totalDurationMs,
    data: { stageDurationMs: stageSummary },
  });

  return result;
}

// ============================================================
// 工具: 估算 token 数 (中文 1.5 字符/token, 英文 4 字符/token)
// ============================================================

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjkCount++;
    else otherCount++;
  }
  return Math.ceil(cjkCount / 1.5 + otherCount / 4);
}