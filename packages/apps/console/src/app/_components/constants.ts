"use client";
// 概览首页 · 共享常量 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 注意: 以下文案/颜色值必须与抽取前逐字一致。
import { t } from "@/i18n";
import { ENTITY_TYPES, entityLabel } from "@/config/artifactTypes";

export const TABLE_COLOR: Record<string, string> = { Memory: "var(--table-memory)", Knowledge: "var(--table-knowledge)", Practice: "var(--table-practice)", Skill: "var(--table-skill)" };
// 实体业务说法统一取 src/config/artifactTypes.ts, 不再在本文件重复硬编码。
// 用 ENTITY_TYPES (含反思) 而非产物表类型, 避免概览图表里漏出 "Reflection"。
export const TABLE_LABEL: Record<string, string> = Object.fromEntries(
  ENTITY_TYPES.map((x) => [x, entityLabel(x)])
);

export const STATUS_TAG: Record<string, { color: string; label: string }> = {
  DONE: { color: "success", label: "已完成" },
  FAILED: { color: "error", label: "失败" },
  IN_PROGRESS: { color: "processing", label: "进行中" },
  PROCESSING: { color: "processing", label: "进行中" },
  PENDING: { color: "default", label: "待执行" },
  DEPRECATED: { color: "default", label: "已废弃" },
};

export const EVENT_LABEL: Record<string, string> = {
  CALL_LLM: "LLM 调用",
  MEMORIZE: "记忆写入",
  KNOWLEDGE: "知识写入",
  PRACTICE: "实践写入",
  EVALUATE: "评估提炼",
  REFLECT: "反思",
  LEARN: "学习",
  OUTCOME: "结果回填",
  REFLECTION_TO_TASK: "反思转任务",
  CONTEXT_INJECTED: "上下文注入",
  AGENT_OUTPUT_INGESTED: t('overview.event.AGENT_OUTPUT_INGESTED'),
  QUALITY_AUDIT: "质量审计",
  KNOWLEDGE_VERIFIED: "知识已验证",
  KNOWLEDGE_REJECTED: "知识被驳回",
  KNOWLEDGE_VERIFY_TASK: "知识验证任务",
  GLOBAL_ORGANIZER: "全局整理",
  TASK_TO_FILL: "任务补全",
};
