"use client";

/**
 * 空态组件 (EmptyState)
 * 列表无数据时统一用
 */

export interface EmptyStateProps {
  icon?: string;
  title?: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon = "📭", title = "暂无数据", description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="icon">{icon}</div>
      <div className="title">{title}</div>
      {description && <div className="desc">{description}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
