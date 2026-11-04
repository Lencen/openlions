/**
 * with-retry.ts — 统一 LLM 调用重试/超时/早停封装 (P1-A 2026-08-31)
 *
 * 背景 (P0-FLYWHEEL-IDLE-CALLS 文档):
 *   6 个 LLM 入口 (main/reflect/structured/improving-tasks/bridge/SessionReg)
 *   各自独立实现 fetch/retry/超时/错误处理, 行为不一致:
 *     - 有的没有早停, 429/500 后无限重试
 *     - 有的 fetch 没有 signal, client 断连后 token 仍扣
 *  本模块统一四件事:
 *   1. fetchWithTimeout: 统一超时 + AbortSignal 透传
 *   2. withRetryAndEarlyStop: 统一重试 + 连续错误早停
 *   3. isNonRetryable: 统一错误分类 (401/403/SCHEMA_INVALID 不重试)
 *   4. withLlmConcurrency: 全局 LLM 并发信号量 (P0-3 2026-09-01, MiniMax 并发 5 上限)
 */

// ============================================================================
// P0-3 2026-09-01: 全局 LLM 并发信号量
//   问题: 6 个 LLM 入口各自独立 fetch, 多 cron 并发 (reflect/structured/improving)
//     同时调 MiniMax -> 超并发 5 上限 -> 429 -> RATE_LIMIT 395 次/天 (空转)
//   方案: in-process semaphore, max=3, 各入口共享; 等待超时 30s 后放行 (降级不阻塞)
// ============================================================================
let _active = 0;
let _max = 3;
const _waiters: Array<() => void> = [];

export function setLlmConcurrency(max: number): void {
  _max = Math.max(1, max);
}

async function _acquire(timeoutMs: number): Promise<boolean> {
  if (_active < _max) {
    _active++;
    return true;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs); // 超时放行 (防死锁)
    _waiters.push(() => {
      clearTimeout(timer);
      _active++;
      resolve(true);
    });
  });
}

function _release(): void {
  _active = Math.max(0, _active - 1);
  const next = _waiters.shift();
  if (next) next();
}

/** 包装 LLM 调用, 限制全局并发 (超时 30s 后放行, 不阻塞业务) */
export async function withLlmConcurrency<T>(
  fn: () => Promise<T>,
  timeoutMs = 30000,
): Promise<T> {
  const acquired = await _acquire(timeoutMs);
  try {
    return await fn();
  } finally {
    if (acquired) _release();
  }
}

export interface RetryOpts {
  maxRetries?: number;     // 默认 1
  baseDelayMs?: number;    // 默认 2000
  earlyStopAfter?: number; // 默认 3 (连续 N 个错就停整个流程)
  onConsecutiveError?: (count: number) => void;
  label?: string;          // 日志标签
}

export type EarlyStopResult = { aborted: true; reason: string; consecutiveErrors: number };

/**
 * 统一 fetch + 超时 + 外部 signal
 * - timeoutMs: 默认 120s (与历史一致)
 * - externalSignal: route 层 cron-with-timeout 注入的 AbortSignal,
 *   与内部超时共用 AbortController (任一触发即 abort)
 * - 超时抛 "fetch timeout after Xms"; 外部 abort 抛 AbortError (透传)
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 120000,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      if (externalSignal?.aborted) throw e; // 外部 abort: 透传, 上层可捕获
      throw new Error(`fetch timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/** 错误分类: 哪些不重试 (401/403/SCHEMA_INVALID/输入类) */
export function isNonRetryable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|403|AUTH_ERROR|FORBIDDEN|SCHEMA_INVALID|JSON\.parse|SyntaxError/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * 统一重试 + 连续错误早停
 * - 失败可重试错误: 指数退避重试 (baseDelay * (attempt+1))
 * - 不可重试错误: 直接抛
 * - 连续 earlyStopAfter 次错误: 返回 { aborted: true } 让上层放弃整个 batch
 *
 * 用法:
 *   const r = await withRetryAndEarlyStop(() => callLLM(...), "reflect:callLLM", { earlyStopAfter: 3 });
 *   if (r && "aborted" in r) return { aborted: true, ...r };
 */
export async function withRetryAndEarlyStop<T>(
  fn: () => Promise<T>,
  label: string,
  opts: RetryOpts = {},
): Promise<T | EarlyStopResult> {
  const maxRetries = opts.maxRetries ?? 1;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  const earlyStopAfter = opts.earlyStopAfter ?? 3;

  let consecutiveErrors = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await fn();
      if (consecutiveErrors > 0) {
        console.info(`[withRetry] ${label}: recovered after ${consecutiveErrors} errors`);
      }
      return r;
    } catch (e: any) {
      consecutiveErrors++;
      opts.onConsecutiveError?.(consecutiveErrors);
      const msg = e?.message || String(e);

      // 不可重试: 直接抛 (调用方决定是否算一次失败)
      if (isNonRetryable(e)) {
        console.warn(`[withRetry] ${label}: non-retryable error: ${msg.slice(0, 120)}`);
        throw e;
      }

      // 早停: 连续 N 次错就放弃整个流程
      if (consecutiveErrors >= earlyStopAfter) {
        console.error(`[withRetry] ${label}: early stop after ${consecutiveErrors} consecutive errors`);
        return { aborted: true, reason: "EARLY_STOP", consecutiveErrors };
      }

      if (attempt < maxRetries) {
        const delay = baseDelayMs * (attempt + 1);
        console.error(`[withRetry] ${label}: attempt ${attempt + 1}/${maxRetries + 1} failed (${msg.slice(0, 100)}), retry in ${delay}ms`);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }
  throw new Error(`${label}: max retries exhausted after ${maxRetries} retries`);
}
