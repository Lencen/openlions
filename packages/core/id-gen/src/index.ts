// 🟡 最小 id-gen (agent-e 2026-07-29)
export function genId(prefix?: string): string {
  return (prefix ? prefix + '_' : '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export default genId;
