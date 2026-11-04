"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { formatDateTime } from "@/lib/timezone";

export default function ProblemDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const problemId = params.id as string;

  const { data: problem, isLoading } = useQuery({
    queryKey: ["problem", "detail", problemId],
    queryFn: () =>
      fetch(`/api/trpc/problem.getDetail?input=${JSON.stringify(problemId)}`)
        .then((r) => r.json())
        .then((r) => r.result.data),
  });

  const resolveMutation = useMutation({
    mutationFn: () =>
      fetch("/api/trpc/problem.attemptAutoResolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problemId }),
      }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["problem", "detail", problemId] }),
  });

  const createTaskMutation = useMutation({
    mutationFn: () =>
      fetch("/api/trpc/problem.createTaskFromProblem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problemId }),
      }).then((r) => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["problem", "list"] }),
  });

  if (isLoading) {
    return <div style={{ padding: 24, color: "#666" }}>加载中...</div>;
  }

  if (!problem) {
    return <div style={{ padding: 24, color: "#999" }}>问题未找到</div>;
  }

  const severityColor = problem.severity === "P1" ? "#ff4d4f" : problem.severity === "P2" ? "#faad14" : "#1890ff";
  const statusColor = problem.status === "OPEN" ? "#ff4d4f" : problem.status === "SOLVING" ? "#faad14" : "#52c41a";

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <a
          href="/problems"
          style={{ color: "#666", textDecoration: "none", fontSize: 14, marginRight: 16 }}
        >
          ← 返回问题列表
        </a>
      </div>

      {/* Title and Status */}
      <div style={{
        background: "#fff",
        borderRadius: 8,
        padding: 24,
        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
        marginBottom: 16,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <span style={{
            padding: "2px 10px",
            borderRadius: 4,
            background: severityColor,
            color: "#fff",
            fontSize: 12,
            fontWeight: 600,
          }}>
            {problem.severity}
          </span>
          <span style={{
            padding: "2px 10px",
            borderRadius: 4,
            background: statusColor,
            color: "#fff",
            fontSize: 12,
            fontWeight: 600,
          }}>
            {problem.status}
          </span>
          <span style={{ color: "#999", fontSize: 13 }}>
            创建于 {formatDateTime(new Date(problem.createdAt))}
          </span>
          {problem.resolvedAt && (
            <span style={{ color: "#52c41a", fontSize: 13 }}>
              已解决 {formatDateTime(new Date(problem.resolvedAt))}
            </span>
          )}
        </div>

        <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>问题描述</h1>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: "#333", background: "#f5f5f5", padding: 16, borderRadius: 6 }}>
          {problem.description}
        </p>
      </div>

      {/* Source: origin task link */}
      {problem.originTaskId && (
        <div style={{
          background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.1)", marginBottom: 16,
        }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#666", marginBottom: 12 }}>来源任务</h3>
          <a href={`/tasks/${problem.originTaskId}`} style={{
            display: "block", padding: "10px 14px", background: "#f0f5ff", borderRadius: 6,
            color: "#4a7dff", textDecoration: "none", fontSize: 14,
          }}>
            查看来源任务 →
          </a>
        </div>
      )}

      {/* Source Info */}
      {problem.taskExecution && problem.taskExecution.task && (
        <div style={{
          background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          marginBottom: 16,
          borderLeft: problem.sourceType === "REFLECTION" ? "3px solid #4a7dff" : "3px solid #52c41a",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "#666", marginBottom: 0 }}>
              {problem.sourceType === "REFLECTION" ? "来源反思" : "来源任务"}
            </h3>
            <span style={{ fontSize: 11, background: problem.sourceType === "REFLECTION" ? "#e6f0ff" : "#e6f7e6", color: problem.sourceType === "REFLECTION" ? "#4a7dff" : "#52c41a", padding: "2px 8px", borderRadius: 4 }}>
              {problem.sourceType || "TASK"}
            </span>
          </div>
          <a href={`/tasks/${problem.taskExecution.task.id}`} style={{
            display: "block", padding: "10px 14px", background: "#f5f5f5", borderRadius: 6,
            color: "#4a7dff", textDecoration: "none", fontSize: 14, fontWeight: 500,
          }}>
            {problem.taskExecution.task.title}
          </a>
          <div style={{ marginTop: 12, fontSize: 13, color: "#999" }}>
            执行时间: {formatDateTime(new Date(problem.taskExecution.createdAt))} · {problem.taskExecution.agentRole}
            {problem.taskExecution.output && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
                执行产出: <span style={{ fontStyle: "italic" }}>{problem.taskExecution.output.slice(0, 100)}...</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Solutions Attempted */}
      {problem.solutionsAttempted && (
        <div style={{
          background: "#fff",
          borderRadius: 8,
          padding: 20,
          boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          marginBottom: 16,
        }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#666", marginBottom: 12 }}>尝试过的方案</h3>
          {(() => {
            try {
              const solutions = JSON.parse(problem.solutionsAttempted);
              return (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {(Array.isArray(solutions) ? solutions : []).map((s: string, i: number) => (
                    <li key={i} style={{ fontSize: 14, color: "#333", marginBottom: 6 }}>{s}</li>
                  ))}
                </ul>
              );
            } catch {
              return <p style={{ fontSize: 14, color: "#333" }}>{problem.solutionsAttempted}</p>;
            }
          })()}
        </div>
      )}

      {/* Auto-resolution attempts */}
      {problem.autoResolveAttempts > 0 && (
        <div style={{
          background: "#fff",
          borderRadius: 8,
          padding: 20,
          boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          marginBottom: 16,
        }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#666", marginBottom: 12 }}>自动解析尝试</h3>
          <div style={{ fontSize: 13, color: "#333" }}>
            共尝试 {problem.autoResolveAttempts} 次
            {problem.lastAttemptAt && ` · 最近: ${formatDateTime(new Date(problem.lastAttemptAt))}`}
          </div>
          {problem.resolutionNotes && (
            <div style={{ marginTop: 8, padding: 12, background: "#f5f5f5", borderRadius: 4, fontSize: 13 }}>
              {problem.resolutionNotes}
            </div>
          )}
        </div>
      )}

      {/* Root Cause */}
      {problem.rootCause && (
        <div style={{
          background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.1)", marginBottom: 16,
        }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "#666", marginBottom: 12 }}>根因分析</h3>
          <p style={{ fontSize: 14, color: "#333", lineHeight: 1.6 }}>{problem.rootCause}</p>
        </div>
      )}

      {/* Execution Log — 7步问题解决流程滚动日志 */}
      <div style={{
        background: "#fff", borderRadius: 8, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.1)", marginBottom: 16,
      }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: "#666", marginBottom: 12 }}>解决流程日志</h3>
        <div style={{ maxHeight: 400, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Step 1: 问题确认 */}
          <div style={{ padding: "8px 12px", background: "#f5f5f5", borderRadius: 6, borderLeft: "3px solid #1890ff" }}>
            <div style={{ fontSize: 12, color: "#1890ff", fontWeight: 600, marginBottom: 4 }}>Step 1 · 问题确认</div>
            <div style={{ fontSize: 13, color: "#333" }}>{problem.description}</div>
            {problem.taskTitle && <div style={{ fontSize: 12, color: "#999", marginTop: 4 }}>关联任务: {problem.taskTitle}</div>}
          </div>

          {/* Auto-resolution attempts log */}
          {problem.autoResolveAttempts > 0 && (
            <div style={{ padding: "8px 12px", background: "#fff7e6", borderRadius: 6, borderLeft: "3px solid #fa8c16" }}>
              <div style={{ fontSize: 12, color: "#fa8c16", fontWeight: 600, marginBottom: 4 }}>自动解析尝试</div>
              <div style={{ fontSize: 13, color: "#333" }}>共尝试 {problem.autoResolveAttempts} 次</div>
              {problem.lastAttemptAt && <div style={{ fontSize: 12, color: "#999" }}>最近尝试: {formatDateTime(new Date(problem.lastAttemptAt))}</div>}
            </div>
          )}

          {/* Step 2: Root Cause */}
          {problem.rootCause && (
            <div style={{ padding: "8px 12px", background: "#f5f5f5", borderRadius: 6, borderLeft: "3px solid #f0a500" }}>
              <div style={{ fontSize: 12, color: "#f0a500", fontWeight: 600, marginBottom: 4 }}>Step 2 · 根因分析</div>
              <div style={{ fontSize: 13, color: "#333" }}>{problem.rootCause}</div>
            </div>
          )}

          {/* Resolution Notes — contains solution/steps info */}
          {problem.resolutionNotes && (
            <div style={{ padding: "8px 12px", background: "#f5f5f5", borderRadius: 6, borderLeft: "3px solid #52c41a" }}>
              <div style={{ fontSize: 12, color: "#52c41a", fontWeight: 600, marginBottom: 4 }}>解决结果</div>
              <div style={{ fontSize: 13, color: "#333", whiteSpace: "pre-wrap" }}>{problem.resolutionNotes}</div>
            </div>
          )}

          {/* Resolved / Abandoned state */}
          {problem.status === "SOLVED" && problem.resolvedAt && (
            <div style={{ padding: "8px 12px", background: "#f6ffed", borderRadius: 6, borderLeft: "3px solid #52c41a" }}>
              <div style={{ fontSize: 12, color: "#52c41a", fontWeight: 600, marginBottom: 4 }}>✓ 问题已解决</div>
              <div style={{ fontSize: 12, color: "#52c41a" }}>解决时间: {formatDateTime(new Date(problem.resolvedAt))}</div>
            </div>
          )}
          {problem.status === "ABANDONED" && (
            <div style={{ padding: "8px 12px", background: "#fff2f0", borderRadius: 6, borderLeft: "3px solid #ff4d4f" }}>
              <div style={{ fontSize: 12, color: "#ff4d4f", fontWeight: 600, marginBottom: 4 }}>✗ 问题已拒绝</div>
              <div style={{ fontSize: 12, color: "#ff4d4f" }}>原因: 信息缺失且无法补充</div>
            </div>
          )}

          {/* Execution output if available */}
          {problem.taskExecution?.output && (
            <div style={{ padding: "8px 12px", background: "#f5f5f5", borderRadius: 6, borderLeft: "3px solid #8b949e" }}>
              <div style={{ fontSize: 12, color: "#8b949e", fontWeight: 600, marginBottom: 4 }}>原始执行产出</div>
              <div style={{ fontSize: 12, color: "#666", whiteSpace: "pre-wrap" }}>{problem.taskExecution.output.slice(0, 200)}</div>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div style={{
        background: "#fff",
        borderRadius: 8,
        padding: 20,
        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
      }}>
        {problem.status === "OPEN" && (
          <button
            onClick={() => resolveMutation.mutate()}
            disabled={resolveMutation.isPending}
            style={{
              padding: "8px 20px",
              background: "#4a7dff",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: resolveMutation.isPending ? "not-allowed" : "pointer",
              fontSize: 14,
              opacity: resolveMutation.isPending ? 0.6 : 1,
            }}
          >
            {resolveMutation.isPending ? "解析中..." : "自动解析"}
          </button>
        )}
        <button
          onClick={() => createTaskMutation.mutate()}
          disabled={createTaskMutation.isPending}
          style={{
            padding: "8px 20px",
            background: "#fff",
            color: "#4a7dff",
            border: "1px solid #4a7dff",
            borderRadius: 6,
            cursor: createTaskMutation.isPending ? "not-allowed" : "pointer",
            fontSize: 14,
            opacity: createTaskMutation.isPending ? 0.6 : 1,
          }}
        >
          {createTaskMutation.isPending ? "创建中..." : "创建任务"}
        </button>
      </div>

      {/* P2-1: Mind 同步状态 */}
      <div style={{
        background: "#fff",
        borderRadius: 8,
        padding: 20,
        boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
        marginTop: 16,
        borderLeft: "4px solid #a371f7",
      }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: "#a371f7", marginBottom: 12 }}>🧠 认知同步 (Mind)</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: "#666" }}>同步状态:</span>
          {problem.mindSynced ? (
            <span style={{ fontSize: 11, background: "#e6f7e6", color: "#52c41a", padding: "2px 8px", borderRadius: 4, fontWeight: 600 }}>
              ✓ 已同步到 Lions-Mind
            </span>
          ) : (
            <span style={{ fontSize: 11, background: "#f5f5f5", color: "#999", padding: "2px 8px", borderRadius: 4 }}>
              ○ 未同步
            </span>
          )}
        </div>
        {problem.lastMindSyncEvent && (
          <div style={{ fontSize: 11, color: "#999" }}>
            最近: <code style={{ color: "#a371f7" }}>{problem.lastMindSyncEvent.stage}</code>
            {" · "}
            <code style={{ color: "#a371f7" }}>{problem.lastMindSyncEvent.sourceType}</code>
            {" · "}
            {formatDateTime(new Date(problem.lastMindSyncEvent.createdAt))}
          </div>
        )}
        {!problem.mindSynced && (
          <div style={{ fontSize: 11, color: "#999", marginTop: 8 }}>
            说明: 本问题未触发 mind memory 写入. V1 scanner (P1-2) 会在问题解决时自动同步.
          </div>
        )}
      </div>
    </div>
  );
}