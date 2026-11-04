"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

interface ActionButtonsProps {
  taskId: string;
  currentStatus: string;
  retryCount: number;
  maxRetries: number;
}

export function ActionButtons({ taskId, currentStatus, retryCount, maxRetries }: ActionButtonsProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const reExecuteMutation = useMutation({
    mutationFn: (reason: string) =>
      fetch("/api/trpc/task.reExecute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, reason }),
      }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task", "full", taskId] }),
  });

  const markCompleteMutation = useMutation({
    mutationFn: () =>
      fetch("/api/trpc/task.markComplete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, reviewerId: "MANUAL" }),
      }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task", "full", taskId] }),
  });

  const abandonMutation = useMutation({
    mutationFn: () =>
      fetch("/api/trpc/task.abandon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, reason: "Manual abandon" }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task", "full", taskId] });
      router.push("/tasks");
    },
  });

  const canReExecute =
    (currentStatus === "PENDING" || currentStatus === "FAILED" || currentStatus === "IN_PROGRESS" || currentStatus === "REVIEW") &&
    retryCount < maxRetries;

  const canMarkComplete = currentStatus === "REVIEW" || currentStatus === "IN_PROGRESS";
  const canAbandon = currentStatus !== "COMPLETED" && currentStatus !== "ARCHIVED";

  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {canReExecute && (
        <button
          onClick={() => reExecuteMutation.mutate("Manual re-execute")}
          disabled={reExecuteMutation.isPending}
          style={{
            padding: "8px 16px",
            background: "#1890ff",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: reExecuteMutation.isPending ? "not-allowed" : "pointer",
            fontSize: 13,
            opacity: reExecuteMutation.isPending ? 0.6 : 1,
          }}
        >
          重新执行
        </button>
      )}

      {canMarkComplete && (
        <button
          onClick={() => markCompleteMutation.mutate()}
          disabled={markCompleteMutation.isPending}
          style={{
            padding: "8px 16px",
            background: "#52c41a",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: markCompleteMutation.isPending ? "not-allowed" : "pointer",
            fontSize: 13,
            opacity: markCompleteMutation.isPending ? 0.6 : 1,
          }}
        >
          标记完成
        </button>
      )}

      {canAbandon && (
        <button
          onClick={() => abandonMutation.mutate()}
          disabled={abandonMutation.isPending}
          style={{
            padding: "8px 16px",
            background: "#fff",
            color: "#ff4d4f",
            border: "1px solid #ff4d4f",
            borderRadius: 6,
            cursor: abandonMutation.isPending ? "not-allowed" : "pointer",
            fontSize: 13,
            opacity: abandonMutation.isPending ? 0.6 : 1,
          }}
        >
          放弃
        </button>
      )}
    </div>
  );
}