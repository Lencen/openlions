/**
 * 跨服务端口/URL 单一真相源 (config registry)
 *
 * 背景: finding f-003「LIONS_TASK_URL 端口在不同 Memory 中记录为 3000/3001, 存在冲突」的根因
 *   是端口没有单一来源 —— 每个调用点各写各的默认值, Memory 只是配置的镜像, 必然失同步。
 *   本模块把跨服务端口/URL 的**权威默认值**收拢到一个文件, 业务代码一律从这里读,
 *   不再在调用点硬编码 `http://localhost:300X`。
 *
 * 权威口径 (2026-09-15 实测, 与 packages/apps/mind/.env.example PORT=3000 一致):
 *   - Mind (本服务, Next.js)     = 3000
 *   - Task (lions-selfimproving) = 3001   ← LIONS_TASK_URL 默认端口
 *   - Session (lions-session)    = 3002
 *   - Task WS (WS_PORT)          = 3003   ← 仅 WS, 不是 HTTP 服务端口, 不得用于 HTTP URL
 *
 * 使用约定:
 *   - LIONS_TASK_URL  : getLionsTaskUrl()  (env 优先, 默认 http://localhost:3001)
 *   - LIONS_MIND_URL  : getLionsMindUrl()  (env 优先, 默认 http://localhost:3000)
 *   - LIONS_SESSION_API_BASE : getSessionUrl() (env 优先, 默认 http://localhost:3002)
 *   - 禁止在业务代码里再写 `process.env.LIONS_TASK_URL || "http://localhost:3001"` 这类字面量。
 *
 * 校验: 改动端口后请跑 `node scripts/lint-cross-service-urls.cjs` (npm run check:cross-service-urls),
 *   它检查代码库与 Memory 中的端口口径与本 registry 一致。
 */
export const CROSS_SERVICE_PORTS = {
  mind: 3000,
  task: 3001,
  session: 3002,
  taskWs: 3003,
} as const;

/** 跨服务 URL 默认主机 (本机部署; 远端用环境变量覆盖) */
const DEFAULT_HOST = "localhost";

/** LIONS_TASK_URL: mind → task 的 HTTP 基址 (env 优先) */
export function getLionsTaskUrl(): string {
  return process.env.LIONS_TASK_URL || `http://${DEFAULT_HOST}:${CROSS_SERVICE_PORTS.task}`;
}

/** LIONS_MIND_URL: 指向 mind 自身的 HTTP 基址 (env 优先; 兼容历史 MIND_API_URL) */
export function getLionsMindUrl(): string {
  return (
    process.env.LIONS_MIND_URL ||
    process.env.MIND_API_URL ||
    `http://${DEFAULT_HOST}:${CROSS_SERVICE_PORTS.mind}`
  );
}

/** LIONS_SESSION_API_BASE: mind → session 的 HTTP 基址 (env 优先) */
export function getSessionUrl(): string {
  return process.env.LIONS_SESSION_API_BASE || `http://${DEFAULT_HOST}:${CROSS_SERVICE_PORTS.session}`;
}
