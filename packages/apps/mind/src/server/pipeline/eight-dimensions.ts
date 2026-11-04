/**
 * eight-dimensions.ts — 平台自己的"8 维审视清单"(2026-09-14 抽出)
 * 出处: docs/LIONS-PLATFORM-V2-DESIGN.md §8 维度清单 —— 复用既有约定, 不另造一套。
 * 用途: 方案/决策的自检基线; 人类决策超时后由 auto-decide 任务要求执行体逐条过一遍;
 *       2026-09-22 起同时是 todo_worker 升级落地 Task 的 requirements 注入内容(全平台单一口径),
 *       权威定义文档见 docs/platform-logic/8-dimensions-review-2026-09-22.md。
 */
export const EIGHT_DIMENSIONS: string[] = [
  "1 业务目标: 与'AI 驱动的业务集中开发与管理平台'的定位对齐吗? 用户要的是什么?",
  "2 架构设计: 与平台既有架构原则一致吗?",
  "3 模块/节点影响: 会影响哪些模块/agent/终端?",
  "4 业务流程清晰: 业务方/用户看流程更清楚了吗?",
  "5 数据准确: 数据流完整、口径一致吗?",
  "6 根本解决 vs 治标: 修的是根因还是症状?",
  "7 稳定/无冲突/无死循环: 与历史设计冲突吗? 会不会引入死循环或卡死?",
  "8 可持续/不重复/不破坏: 未来加模块/业务还要再改吗?",
];

export const EIGHT_DIMENSIONS_TEXT = EIGHT_DIMENSIONS.map((d) => "- " + d).join("\n");
