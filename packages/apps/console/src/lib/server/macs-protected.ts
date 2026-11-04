/**
 * 2026-10-21 写操作保护名单（由 MACS 后端线在协作消息里明确指定）。
 *
 * 背景：这 8 条 expired 消息是**真实业务消息**，不是测试数据；对它们做 retry/assign 会打扰真实会话。
 * 处理：BFF 层直接拒绝（403），不调用 MACS 上游；返回原因，便于操作者理解为什么点不动。
 * 维护：新增保护对象请在此追加并注明来源（哪条协作消息/哪次评审）。
 */
export const PROTECTED_MESSAGES: Record<string, string> = {
  msg_8c7cb9d7a9e441f5: "真实业务消息（MACS 后端 2026-10-21 协作消息指定）",
  msg_1faef0804f3349e4: "真实业务消息（同上）",
  msg_67e2551c3b9c483d: "真实业务消息（同上）",
  msg_d4796669576f4f3f: "真实业务消息（同上）",
  msg_6baa8509539745fe: "真实业务消息（同上）",
  msg_cafb7da4becc405b: "真实业务消息（同上）",
  msg_a9ee81d09aa24f18: "真实业务消息（同上）",
  msg_b12ff3d6e69841ea: "真实业务消息（同上）",
};

export function protectedReason(messageId: string): string | null {
  return PROTECTED_MESSAGES[messageId] || null;
}
