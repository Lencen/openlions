/**
 * 复合 Message ID 构造器
 *
 * 根因：不同 agent 的 hermes DB 各自用 INTEGER AUTOINCREMENT 生成 message id，
 * id 空间重叠（agent-h 和 agent-e 都有 id=1..36670）。
 * upload 端点用 `where: { id: String(m.id) }` upsert 时，
 * agent-x 的 message 会命中 ut 的已有记录，update 分支覆盖 content 但不改 sessionId，
 * 导致数据污染。
 *
 * 修复：Message.id 统一使用 `${agentId}:${source}:${originalId}` 复合 ID，
 * 天然按 agent 隔离，从架构层面杜绝跨 agent id 冲突。
 *
 * 所有写入 Message 表的代码必须经过此 helper，不允许直接用原始 id。
 *
 * 2026-09-22 边界修正：cron 系统身份的 agentId 含冒号（如 `cron:v16:improving-tasks`），
 *   直接拼 `${agentId}:${source}:${originalId}` 会让 split(":") 解析出错误的 agentId 段。
 *   解决：构造时把 agentId 内部的冒号转义为占位符 `__COLON__`；解析时还原。
 *   占位符选 `__COLON__` 而非 `%3A`/单字符：① 直观可读；② 不可能与真实 id 撞
 *   (source/originalId 都不会出现 11 字符的下划线串)；③ 只影响 agentId 字段,
 *   source 与 originalId 仍是明文, 其它逻辑(查询/索引/排序)零变化。
 */

const COLON_PLACEHOLDER = "__COLON__";

export function buildMessageId(
  agentId: string,
  source: string,
  originalId: string | number
): string {
  const safeAgent = String(agentId).replace(/:/g, COLON_PLACEHOLDER);
  return `${safeAgent}:${source}:${originalId}`;
}

/** 从复合 ID 中解析出 agentId */
export function parseAgentId(messageId: string): string | null {
  const parts = messageId.split(":");
  if (parts.length < 3) return null;
  return parts[0].replace(new RegExp(COLON_PLACEHOLDER, "g"), ":");
}
