// 2026-09-15 文案业务化 (待办 todo_c0c8aee4ca134af0b5ed) 复核增补:
// AI 接入向导的**智能体框架**选项 —— 技术值 (hermes/claude/mcp/custom) -> 业务说法。
//
// 约束:
//   1) 选项列表与展示文案都从这里取, StepInfoForm (下拉) 与 StepConfirm (回显) 不再各自硬编码;
//   2) 业务说法集中在 src/i18n/messages/<locale>.ts, 本文件只保留"技术值 -> 文案 key"的骨架,
//      以支持后续多语言;
//   3) 未知技术值原样返回 (宁可漏出原文, 也不瞎翻译)。
import { t } from '@/i18n';

export const AGENT_CHANNELS = [
  { value: 'hermes', labelKey: 'onboard.framework.hermes' },
  { value: 'claude', labelKey: 'onboard.framework.claude' },
  { value: 'mcp', labelKey: 'onboard.framework.mcp' },
  { value: 'custom', labelKey: 'onboard.framework.custom' },
] as const;

/** 智能体框架技术值 -> 业务说法; 未知值原样返回 */
export function channelLabel(value: string): string {
  const found = AGENT_CHANNELS.find((c) => c.value === value);
  return found ? t(found.labelKey) : value;
}
