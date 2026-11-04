/**
 * ui-flag.ts — UI 重构灰度开关 (Phase2 交付物, 2026-09-18 agent-d 落地)
 *
 * 为什么需要: Phase2 的"antd 绞杀式替换"要求**可灰度** —— 新组件体系(UI_V2)先在壳层灰度,
 *   线上出问题能一键回退, 而不是一次性全量替换。读取构建期注入的 NEXT_PUBLIC_UI_V2, 默认关闭
 *   (未显式打开时保持旧渲染路径, 行为与改动前一致)。
 * 验收: scripts/acceptance/checks/ui-refactor-gate.cjs 的 ui-v2-flag 检查项。
 */
export const UI_V2_ENABLED =
  String(process.env.NEXT_PUBLIC_UI_V2 ?? "").trim() === "1" ||
  String(process.env.NEXT_PUBLIC_UI_V2 ?? "").trim().toLowerCase() === "true";

/** 运行期读取(客户端组件用); 构建期常量在客户端会被内联, 两者一致。 */
export function uiV2Enabled(): boolean {
  return UI_V2_ENABLED;
}
