// 2026-10-26：界面错误文案的业务化（设计门 C6：界面不得出现「状态码 502」这类技术串）。
// 约定：**界面只说人话**，原始错误进 console.warn 供排查。
export function humanError(e: unknown, what = "这份数据"): string {
  const raw = String((e as Error)?.message ?? e ?? "");
  // eslint-disable-next-line no-console
  if (raw) console.warn("[ui] 取数失败:", raw);
  if (/502|503|500|上游|upstream/i.test(raw)) return `${what}暂时取不到（数据服务响应异常），可以稍后刷新重试。`;
  if (/timeout|超时|aborted/i.test(raw)) return `${what}加载超时，可以稍后刷新重试。`;
  if (/401|403|unauthori[sz]ed|forbidden/i.test(raw)) return `${what}需要重新登录后再看。`;
  if (/404|not found/i.test(raw)) return `${what}不存在或已被删除。`;
  return `${what}加载失败，可以稍后刷新重试。`;
}
