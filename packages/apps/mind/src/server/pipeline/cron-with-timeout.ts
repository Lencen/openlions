/**
 * cron-with-timeout.ts — 统一 cron HTTP handler 的超时包装
 *
 * P0-3 飞轮空转治理 (2026-08-31):
 *   - 反思 cron 卡 65 分钟是这次空转根因之一
 *   - 所有 flywheel cron 调用的 route 必须包这个
 *   - 超过 timeoutMs 直接返 408 + abort 内部 Promise
 *
 * 设计原则:
 *   - 不改业务函数签名, 业务函数继续跑 (后台完成可能)
 *   - 但 route 立刻返 408, curl --max-time / timeout 命令看到 408 退出
 *   - abort 触发后, 业务函数如果在 await, 可以选择捕获 (很多 fetch 没 catch abort 会 throw)
 *   - AbortError 会被 catch 住, 内部返回 aborted=true 给 cron 日志
 *
 * 用法:
 *   export async function GET(req: Request) {
 *     return withCronTimeout(
 *       async (signal) => {
 *         const r = await runReflectionsCron({ signal });
 *         return Response.json(r);
 *       },
 *       { timeoutMs: 90_000, label: "reflect-cron" },
 *     );
 *   }
 */

export interface CronTimeoutOpts {
  timeoutMs?: number;  // 默认 90s
  label: string;       // 日志标签, e.g. "reflect-cron"
}

export interface CronTimeoutResult<T> {
  ok: boolean;
  aborted: boolean;
  reason?: string;
  data?: T;
  error?: string;
  durationMs: number;
}

export async function withCronTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: CronTimeoutOpts,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const data = await fn(controller.signal);
    return Response.json({
      ok: true,
      aborted: false,
      data,
      durationMs: Date.now() - t0,
    });
  } catch (e: any) {
    const isAbort = e?.name === "AbortError" || controller.signal.aborted;
    if (isAbort) {
      console.warn(
        `[${opts.label}] aborted after ${timeoutMs}ms (took ${Date.now() - t0}ms)`,
      );
      return Response.json(
        {
          ok: false,
          aborted: true,
          reason: `TIMEOUT_${timeoutMs}ms`,
          durationMs: Date.now() - t0,
        },
        { status: 408 },
      );
    }
    console.error(`[${opts.label}] error: ${e?.message?.slice(0, 200)}`);
    return Response.json(
      {
        ok: false,
        aborted: false,
        error: e?.message ?? String(e),
        durationMs: Date.now() - t0,
      },
      { status: 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}