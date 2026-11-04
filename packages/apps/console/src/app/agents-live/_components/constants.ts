// agents-live 页 · 状态与执行结果展示常量 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
export const STATE_TONE: Record<string, string> = { stuck: "crit", busy: "info", online: "ok", idle: "warn", offline: "mute" };

export const STATUS_TAG: Record<string, { color: string; label: string }> = {
  DONE: { color: "success", label: "已完成" },
  FAILED: { color: "error", label: "失败" },
  COMPLETED: { color: "success", label: "执行成功" },
  IN_PROGRESS: { color: "processing", label: "进行中" },
  PROCESSING: { color: "processing", label: "进行中" },
  PENDING: { color: "default", label: "待执行" },
  DEPRECATED: { color: "default", label: "已废弃" },
};
