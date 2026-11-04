"use client";

import { useState } from "react";
import { formatDateTime } from "@/lib/timezone";

interface ExecutionCardProps {
  execution: {
    id: string;
    agentId: string;
    agentRole: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    output: string;
    thoughtProcess: string | null;
    problemsEncountered: string | null;
    solutionsApplied: string | null;
    blocks: string | null;
    nextSteps: string | null;
    qualityPassed: boolean | null;
    createdAt: string;
  };
  index: number;
}

export function ExecutionCard({ execution, index }: ExecutionCardProps) {
  const [expanded, setExpanded] = useState(false);

  const duration =
    execution.startedAt && execution.completedAt
      ? Math.round(
          (new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime()) / 1000
        )
      : null;

  const statusColor =
    execution.status === "COMPLETED"
      ? "#52c41a"
      : execution.status === "FAILED"
      ? "#ff4d4f"
      : execution.status === "BLOCKED"
      ? "#fa8c16"
      : "#1890ff";

  const qualityBadge =
    execution.qualityPassed === true ? (
      <span style={{ fontSize: 11, color: "#52c41a", background: "#f6ffed", padding: "1px 6px", borderRadius: 4 }}>✓ 质量通过</span>
    ) : execution.qualityPassed === false ? (
      <span style={{ fontSize: 11, color: "#ff4d4f", background: "#fff2f0", padding: "1px 6px", borderRadius: 4 }}>✗ 质量未通过</span>
    ) : null;

  return (
    <div style={{
      border: "1px solid #e8e8e8",
      borderRadius: 8,
      overflow: "hidden",
      marginBottom: 12,
    }}>
      {/* Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          background: expanded ? "#f9f9f9" : "#fff",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span style={{
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: statusColor,
          color: "#fff",
          fontSize: 12,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
          {index + 1}
        </span>

        <span style={{ fontSize: 14, fontWeight: 600, color: "#333", flex: 1 }}>
          #{execution.id.slice(-8)} — {execution.agentRole}
        </span>

        <span style={{ fontSize: 12, color: "#999" }}>
          {formatDateTime(new Date(execution.createdAt))}
        </span>

        {duration && (
          <span style={{ fontSize: 12, color: "#999" }}>{duration}s</span>
        )}

        <span style={{
          padding: "2px 8px",
          borderRadius: 4,
          background: statusColor,
          color: "#fff",
          fontSize: 11,
          fontWeight: 600,
        }}>
          {execution.status}
        </span>

        {qualityBadge}

        <span style={{ fontSize: 12, color: "#ccc", marginLeft: 4 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{ padding: "16px 20px", background: "#fff", borderTop: "1px solid #f0f0f0" }}>
          {execution.output && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 6 }}>产出 (Output)</div>
              <pre style={{
                fontSize: 13,
                lineHeight: 1.6,
                color: "#333",
                background: "#f5f5f5",
                padding: 12,
                borderRadius: 6,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 200,
              }}>
                {execution.output.slice(0, 500)}{execution.output.length > 500 ? "..." : ""}
              </pre>
            </div>
          )}

          {execution.thoughtProcess && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 6 }}>思考过程</div>
              <pre style={{
                fontSize: 13,
                lineHeight: 1.6,
                color: "#555",
                background: "#fafafa",
                padding: 12,
                borderRadius: 6,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 150,
              }}>
                {execution.thoughtProcess.slice(0, 300)}{execution.thoughtProcess.length > 300 ? "..." : ""}
              </pre>
            </div>
          )}

          {execution.problemsEncountered && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#ff4d4f", marginBottom: 6 }}>遇到的问题</div>
              <p style={{ fontSize: 13, color: "#d4380d", margin: 0 }}>{execution.problemsEncountered}</p>
            </div>
          )}

          {execution.solutionsApplied && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#52c41a", marginBottom: 6 }}>应用的解决方案</div>
              <p style={{ fontSize: 13, color: "#389e0d", margin: 0 }}>{execution.solutionsApplied}</p>
            </div>
          )}

          {execution.blocks && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#fa8c16", marginBottom: 6 }}>阻塞项</div>
              <p style={{ fontSize: 13, color: "#d46b00", margin: 0 }}>{execution.blocks}</p>
            </div>
          )}

          {execution.nextSteps && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#1890ff", marginBottom: 6 }}>下一步</div>
              <p style={{ fontSize: 13, color: "#096dd9", margin: 0 }}>{execution.nextSteps}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}