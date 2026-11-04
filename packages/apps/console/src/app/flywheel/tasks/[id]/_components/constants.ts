"use client";
// 任务详情页 · 共享常量 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 注意: 以下文案/颜色值必须与抽取前逐字一致。

export const STATUS_TAG: Record<string, { color: string; label: string }> = {
  DONE: { color: "success", label: "已完成" },
  FAILED: { color: "error", label: "失败" },
  IN_PROGRESS: { color: "processing", label: "进行中" },
  PROCESSING: { color: "processing", label: "处理中" },
  PENDING: { color: "default", label: "待认领" },
  DEPRECATED: { color: "default", label: "已废弃" },
};

export const PRODUCT_LINK: Record<string, string> = {
  Knowledge: "/cognitive/knowledge/detail?id=",
  Memory: "/cognitive/memory/detail?id=",
  Practice: "/cognitive/practice/detail?id=",
  Skill: "/cognitive/skills/detail?id=",
};

export const PRODUCT_COLOR: Record<string, string> = { Memory: "var(--table-memory)", Knowledge: "var(--table-knowledge)", Practice: "var(--status-warn)", Skill: "var(--primary)" };
export const PRODUCT_LABEL: Record<string, string> = { Memory: "记忆", Knowledge: "知识", Practice: "实践", Skill: "技能" };

export const VERDICT_LABEL: Record<string, string> = {
  KNOWLEDGE_VERIFIED: "平台裁定: 已验证通过",
  KNOWLEDGE_PROPOSAL_ACCEPTED: "平台裁定: 提案接受",
  KNOWLEDGE_REJECTED: "平台裁定: 驳回",
  KNOWLEDGE_VERDICT_MISSING: "平台裁定: 缺少裁定依据",
  HUMAN_INTERVENTION: "人类介入",
  QUALITY_AUDIT: "质量审计",
};

export const TRUNCATE_HINT = "已截断：本页只显示前面的内容；完整全文请见数据血脉页的任务链路，或直接调用 /api/task-detail?id=<任务编号> 取数据。";
