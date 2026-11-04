// 2026-09-22 portal 静默吞错改为可告警(前置-3):
// 历史: 多个 portal 路由用 .catch(() => []) 让 prisma 失败完全不可见 ——
//   2026-09-17 ~ 2026-09-22 期间 stale-WAL fd 导致所有 prisma 读抛错,
//   HTTP 仍 200 + agents/knowledge/heartbeat/daily-report 全部返回空,
//   agent 看到的是"坏的平台"却无人知晓。
// 修法: silentQuery 统一捕错 → console.error(进 logs/portal-dev.log) + 返回兜底;
//   路由层通过 onError 回调设 warning 字段, 让后续 UI 可显示横幅。
//
// 2026-10-15 架构收口(配套 src/lib/mind-read.ts): 读取层从 Prisma 换成 better-sqlite3
//   —— **同步驱动**。原来传进来的总是 `prisma.$queryRawUnsafe(...)` 这个 Promise;
//   同步驱动没有 Promise 可传, 而且它的失败是**同步抛出**的(在 silentQuery 被调用之前就炸了)。
//   故这里把入口放宽为 `Promise<T> | (() => T)`:
//     · 传 Promise  → 行为与改造前逐字一致(向后兼容);
//     · 传 thunk    → 同步抛出也会被这里接住 → 同样落日志 + 返回兜底 + 触发 onError。
//   调用点因此长这样: silentQuery(() => q(sql), [], "agents.list", flag)。
export type QuerySource<T> = Promise<T> | (() => T | Promise<T>);

export async function silentQuery<T>(
  source: QuerySource<T>,
  fallback: T,
  tag: string,
  onError?: (e: unknown) => void,
): Promise<T> {
  try {
    return await (typeof source === "function" ? (source as () => T)() : source);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error(`[portal] ${tag} query failed: ${msg}`);
    onError?.(e);
    return fallback;
  }
}
