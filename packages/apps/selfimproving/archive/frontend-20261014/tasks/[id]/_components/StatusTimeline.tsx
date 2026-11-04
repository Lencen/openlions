"use client";

import { formatDateTime } from "@/lib/timezone";

const STATUS_ORDER = ["PENDING", "IN_PROGRESS", "REVIEW", "COMPLETED", "FAILED", "BLOCKED", "ARCHIVED"];

interface Transition {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string | null;
  reason: string | null;
  createdAt: string;
}

interface StatusTimelineProps {
  transitions: Transition[];
  currentStatus: string;
}

export function StatusTimeline({ transitions, currentStatus }: StatusTimelineProps) {
  // Build a sorted list of significant transitions
  const steps: Array<{
    status: string;
    timestamp: string | null;
    actor: string | null;
    fromStatus: string | null;
  }> = [];

  // Start from PENDING if first transition is to PENDING
  for (const t of transitions) {
    if (t.fromStatus === null && t.toStatus === "PENDING") {
      steps.push({ status: "PENDING", timestamp: t.createdAt, actor: t.actor, fromStatus: null });
    }
    if (!steps.find((s) => s.status === t.toStatus)) {
      steps.push({ status: t.toStatus, timestamp: t.createdAt, actor: t.actor, fromStatus: t.fromStatus });
    }
  }

  // If current status not in steps, add it at the end
  if (!steps.find((s) => s.status === currentStatus)) {
    steps.push({ status: currentStatus, timestamp: null, actor: null, fromStatus: steps[steps.length - 1]?.status ?? null });
  }

  const statusColor: Record<string, string> = {
    PENDING: "#faad14",
    IN_PROGRESS: "#1890ff",
    REVIEW: "#722ed1",
    COMPLETED: "#52c41a",
    FAILED: "#ff4d4f",
    BLOCKED: "#fa8c16",
    ARCHIVED: "#999",
  };

  const statusLabel: Record<string, string> = {
    PENDING: "待处理",
    IN_PROGRESS: "进行中",
    REVIEW: "评审中",
    COMPLETED: "已完成",
    FAILED: "已失败",
    BLOCKED: "已阻塞",
    ARCHIVED: "已归档",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, overflowX: "auto", padding: "8px 0" }}>
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        const color = statusColor[step.status] ?? "#999";
        const label = statusLabel[step.status] ?? step.status;

        return (
          <div key={i} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 80 }}>
              <div style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: color,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontSize: 12,
                fontWeight: 700,
              }}>
                {i + 1}
              </div>
              <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color }}>{label}</div>
              {step.timestamp && (
                <div style={{ fontSize: 11, color: "#999", marginTop: 2, textAlign: "center" }}>
                  {formatDateTime(new Date(step.timestamp)).split(" ")[1]}
                </div>
              )}
              {step.actor && (
                <div style={{ fontSize: 10, color: "#bbb", marginTop: 1 }}>{step.actor}</div>
              )}
            </div>
            {!isLast && (
              <div style={{
                width: 40,
                height: 2,
                background: "#e8e8e8",
                margin: "0 4px",
                marginBottom: 24,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}