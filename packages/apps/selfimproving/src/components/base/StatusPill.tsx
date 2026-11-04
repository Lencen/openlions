"use client";

/**
 * 状态徽章 (StatusPill)
 * 任务状态 + 问题状态 + 反思状态 全部用这个
 *
 * 跨 mind + task 复用
 * 7 个任务状态: PENDING / IN_PROGRESS / COMPLETED / FAILED / BLOCKED / CANCELLED / DEPRECATED
 */

export type StatusKey =
  | "PENDING"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "DEPRECATED"
  | "OPEN"
  | "RESOLVED"
  | "SOLVED"
  | "MERGED"
  | "ABANDONED"
  | "ACTIVE"
  | "EXPIRED"
  | "INVESTIGATING";

const STATUS_TO_TONE: Record<StatusKey, "ok" | "warn" | "err" | "frozen" | "info"> = {
  PENDING: "warn",
  IN_PROGRESS: "info",
  COMPLETED: "ok",
  RESOLVED: "ok",
  SOLVED: "ok",
  FAILED: "err",
  BLOCKED: "err",
  CANCELLED: "frozen",
  DEPRECATED: "frozen",
  ABANDONED: "frozen",
  MERGED: "frozen",
  OPEN: "warn",
  ACTIVE: "info",
  EXPIRED: "frozen",
  INVESTIGATING: "info",
};

const STATUS_LABELS: Partial<Record<StatusKey, string>> = {
  PENDING: "待处理",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  FAILED: "失败",
  BLOCKED: "阻塞",
  CANCELLED: "取消",
  DEPRECATED: "弃用",
  ABANDONED: "放弃",
  OPEN: "开放",
  RESOLVED: "已解决",
  SOLVED: "已解决",
  MERGED: "已合并",
  ACTIVE: "活跃",
  EXPIRED: "已过期",
  INVESTIGATING: "调查中",
};

export interface StatusPillProps {
  status: StatusKey | string;
  label?: string;
  showDot?: boolean;
  size?: "sm" | "md";
}

export function StatusPill({ status, label, showDot = true, size = "sm" }: StatusPillProps) {
  const key = status as StatusKey;
  const tone = STATUS_TO_TONE[key] ?? "frozen";
  const text = label ?? STATUS_LABELS[key] ?? status;

  return (
    <span
      className={`status-pill ${tone}`}
      style={{
        fontSize: size === "md" ? "var(--text-md)" : "var(--text-sm)",
        padding: size === "md" ? "4px 12px" : "2px 10px",
      }}
    >
      {showDot && <span className="dot" />}
      {text}
    </span>
  );
}
