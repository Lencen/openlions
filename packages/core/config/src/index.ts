// 🟡 最小 config (agent-e 2026-07-29)
export function getConfig(key: string, fallback?: any): any {
  if (typeof process !== 'undefined' && process.env) return process.env[key] ?? fallback;
  return fallback;
}
export default { get: getConfig };
