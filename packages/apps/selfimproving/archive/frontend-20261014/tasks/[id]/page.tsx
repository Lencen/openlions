"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { formatDateTime } from "@/lib/timezone";
import { StatusTimeline } from "./_components/StatusTimeline";
import { KeyMetrics } from "./_components/KeyMetrics";
import { ExecutionCard } from "./_components/ExecutionCard";
import { ActionButtons } from "./_components/ActionButtons";
import { StructuredContext } from "./_components/StructuredContext";

const STATUS_COLORS: Record<string, string> = {
  PENDING: "#6e7681",
  IN_PROGRESS: "#58a6ff",
  REVIEW: "#f0a500",
  COMPLETED: "#3fb950",
  FAILED: "#f85149",
  BLOCKED: "#f85149",
  ARCHIVED: "#484f58",
};
const PRIORITY_COLORS: Record<string, string> = { P1: "#f85149", P2: "#f0a500", P3: "#58a6ff" };
const PROBLEM_STATUS_COLORS: Record<string, string> = {
  OPEN: "#f85149", SOLVING: "#f0a500", SOLVED: "#3fb950", ABANDONED: "#6e7681",
};
const SEVERITY_COLORS: Record<string, string> = { P1: "#f85149", P2: "#f0a500", P3: "#58a6ff" };

export default function TaskDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const { data, isLoading } = useQuery({
    queryKey: ["task", "full", id],
    queryFn: () =>
      fetch(`/api/trpc/task.getFull?input=${JSON.stringify(id)}`)
        .then((r) => r.json())
        .then((r) => r.result.data),
  });

  if (isLoading) return <div style={wrap}><div style={loading}>加载中…</div></div>;
  if (!data) return <div style={wrap}><div style={loading}>任务未找到</div></div>;

  const task = data;
  const lastExecution = task.executions?.[0];
  const executions = task.executions ?? [];
  const reviews = task.reviews ?? [];
  const transitions = task.stateTransitions ?? [];

  return (
    <div style={wrap}>
      <Link href="/tasks" style={{ color: "#58a6ff", fontSize: 13, display: "inline-block", marginBottom: 16 }}>
        ← 返回任务列表
      </Link>

      {/* Header */}
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: "#e6edf3", marginBottom: 8 }}>{task.title}</h1>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <span style={{ ...badge, background: PRIORITY_COLORS[task.priority] }}>{task.priority}</span>
              <span style={{ ...badge, background: STATUS_COLORS[task.status] }}>{task.status.replace("_", " ")}</span>
              {task.estimatedEffort && <span style={{ ...badge, background: "#30363d" }}>{task.estimatedEffort}</span>}
              {task.sourceSummaryId && (
                <span style={{ ...badge, background: "#8b5498" }}>每日总结</span>
              )}
              {task.sourceProblemId && (
                <span style={{ ...badge, background: "#b54a32" }}>问题驱动</span>
              )}
              {task.sourceReflectionIds && (
                <span style={{ ...badge, background: "#4a7dff" }}>反思驱动</span>
              )}
            </div>
          </div>
          <ActionButtons
            taskId={task.id}
            currentStatus={task.status}
            retryCount={task.retryCount ?? 0}
            maxRetries={task.maxRetries ?? 3}
          />
        </div>

        {/* Key Metrics */}
        <div style={{ marginBottom: 16 }}>
          <KeyMetrics
            estimatedEffort={task.estimatedEffort}
            actualEffortMs={task.actualEffortMs}
            executionCount={executions.length}
            retryCount={task.retryCount ?? 0}
            maxRetries={task.maxRetries ?? 3}
            createdAt={task.createdAt}
            updatedAt={task.updatedAt}
          />
        </div>

        {/* Status Timeline */}
        {transitions.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#8b949e", marginBottom: 8 }}>状态时间线</div>
            <StatusTimeline transitions={transitions} currentStatus={task.status} />
          </div>
        )}

        <div style={{ fontSize: 12, color: "#6e7681" }}>
          创建于 {formatDateTime(new Date(task.createdAt))}
          {task.completedAt && <> · 完成于 {formatDateTime(new Date(task.completedAt))}</>}
          {task.completedBy && <> · 完成人: {task.completedBy}</>}
        </div>
      </div>

      {/* Task Fields */}
      <div style={{ ...cardStyle, marginTop: 16 }}>
        <Section title="任务描述" content={task.description} />
        {/* V3 结构化上下文(聚类 + 根因 + 计划 + 关联) */}
        <StructuredContext
          rawContext={task.structuredContext}
          sourceReflectionIds={task.sourceReflectionIds}
          theme={task.theme}
          contextVersion={task.contextVersion}
        />
        <Section title="背景" content={task.background} />
        <Section title="执行要求" content={task.requirements} />
        <Section title="所需材料" content={task.materials} />
        <Section title="验收标准" content={task.acceptanceCriteria} />
        <Section title="质量标准" content={task.qualityStandards} />
      </div>

      {/* Related Problems */}
      {task.problems && task.problems.length > 0 && (
        <div style={{ ...cardStyle, marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#8b949e", marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>
            关联问题 ({task.problems.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {task.problems.map((prob: Record<string,unknown>) => (
              <a
                key={prob.id as string}
                href={`/problems/${prob.id}`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 12px",
                  background: "#1c2128",
                  borderRadius: 6,
                  textDecoration: "none",
                  borderLeft: `3px solid ${PROBLEM_STATUS_COLORS[prob.status as string] || "#6e7681"}`,
                }}
              >
                <div>
                  <div style={{ fontSize: 13, color: "#e6edf3", marginBottom: 2 }}>{prob.description as string}</div>
                  <div style={{ fontSize: 11, color: "#6e7681" }}>
                    {prob.rootCause ? `根因: ${(prob.rootCause as string).slice(0, 50)}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ ...badge, background: SEVERITY_COLORS[prob.severity as string] || "#6e7681", fontSize: 10 }}>
                    {prob.severity as string}
                  </span>
                  <span style={{ ...badge, background: PROBLEM_STATUS_COLORS[prob.status as string] || "#6e7681", fontSize: 10 }}>
                    {prob.status as string}
                  </span>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Source: Reflection Info */}
      {task.sourceReflectionIds && (
        <div style={{ ...cardStyle, marginTop: 16, borderLeft: "3px solid #4a7dff" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#8b949e", marginBottom: 8, textTransform: "uppercase" }}>反思来源</div>
          <div style={{ fontSize: 13, color: "#e6edf3" }}>
            {task.sourceReflectionIds.split(",").map((id: string, i: number) => (
              <span key={i} style={{ marginRight: 8 }}>
                <a href={`/reflections/${id.trim()}`} style={{ color: "#4a7dff" }}>{id.trim().slice(0, 12)}...</a>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Execution Records — 滚动日志 */}
      {executions.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 16, color: "#f0a500", marginBottom: 12 }}>
            执行记录 ({executions.length})
          </h2>
          <div style={{
            maxHeight: 600,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}>
            {executions.map((ex: Record<string,unknown>, i: number) => (
              <ExecutionCard
                key={ex.id as string}
                execution={ex as any}
                index={i}
              />
            ))}
          </div>
        </div>
      )}

      {/* Reviews */}
      {reviews.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 16, color: "#58a6ff", marginBottom: 12 }}>评审记录</h2>
          {reviews.map((rev: Record<string,unknown>, i: number) => {
            const score = rev.score as number | undefined;
            const strengths = rev.strengths as string | undefined;
            const weaknesses = rev.weaknesses as string | undefined;
            const lessonsLearned = rev.lessonsLearned as string | undefined;
            const feedbackNotes = rev.feedbackNotes as string | undefined;
            return (
            <div key={rev.id as string} style={{ ...cardStyle, marginBottom: 12, borderLeft: "3px solid #58a6ff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontWeight: 600, color: "#58a6ff" }}>评审 #{i + 1} — {rev.reviewerRole as string}</span>
                <span style={{ ...badge, background: STATUS_COLORS[rev.status as string] || "#6e7681" }}>{rev.status as string}</span>
              </div>
              {score != null && score !== undefined && (
                <div style={{ fontSize: 24, fontWeight: 700, color: score >= 8 ? "#3fb950" : score >= 5 ? "#f0a500" : "#f85149", marginBottom: 8 }}>
                  {score.toFixed(1)}/10
                </div>
              )}
              {strengths && <Section title="优点" content={strengths} small green />}
              {weaknesses && <Section title="不足" content={weaknesses} small red />}
              {lessonsLearned && <Section title="经验教训" content={lessonsLearned} small />}
              {feedbackNotes && <Section title="反馈" content={feedbackNotes} small blue />}
            </div>
            );
          })}
        </div>
      )}

      {/* P2-1: Mind 同步状态 + 反思来源 */}
      <div style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, color: "#a371f7", marginBottom: 12 }}>🧠 认知同步 (Mind)</h2>
        <div style={{ ...cardStyle, borderLeft: "3px solid #a371f7" }}>
          {/* 同步状态总览 */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <span style={{ fontSize: 13, color: "#8b949e", fontWeight: 600 }}>同步状态:</span>
            {task.mindSynced ? (
              <span style={{ ...badge, background: "#3fb950" }}>✓ 已同步到 Lions-Mind</span>
            ) : (
              <span style={{ ...badge, background: "#6e7681" }}>○ 未同步</span>
            )}
            {task.lastMindSyncEvent && (
              <span style={{ fontSize: 11, color: "#8b949e" }}>
                最近: <code style={{ color: "#58a6ff" }}>{task.lastMindSyncEvent.stage}</code>
                {" · "}
                <code style={{ color: "#58a6ff" }}>{task.lastMindSyncEvent.sourceType}</code>
                {" · "}
                {formatDateTime(new Date(task.lastMindSyncEvent.createdAt as any))}
              </span>
            )}
          </div>

          {/* 反思来源 */}
          {task.sourceReflections && task.sourceReflections.length > 0 ? (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#8b949e", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
                📔 反思来源 ({task.sourceReflections.length})
              </div>
              {task.sourceReflections.map((ref: any) => (
                <div key={ref.id} style={{ ...cardStyle, marginTop: 8, marginBottom: 8, padding: 12, border: "1px solid #30363d", background: "#0d1117" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 13, color: "#a371f7", fontWeight: 600 }}>
                      🔗 {ref.title || "反思"}
                    </span>
                    <div style={{ display: "flex", gap: 4 }}>
                      {ref.category && <span style={{ ...badge, background: "#4a7dff", fontSize: 10 }}>{ref.category}</span>}
                      {ref.agentSource && <span style={{ ...badge, background: "#1f6feb", fontSize: 10 }}>{ref.agentSource}</span>}
                    </div>
                  </div>
                  {ref.lesson && (
                    <div style={{ fontSize: 12, color: "#c9d1d9", lineHeight: 1.6, marginTop: 4 }}>
                      {ref.lesson.slice(0, 300)}
                      {ref.lesson.length > 300 && "..."}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#6e7681", padding: 8 }}>
              {task.sourceReflectionIds
                ? `sourceReflectionIds 有 ${task.sourceReflectionIds.split(",").length} 条, 但暂未关联`
                : "无反思来源 (本任务非反思驱动)"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, content, small, red, green, blue }: { title: string; content: string; small?: boolean; red?: boolean; green?: boolean; blue?: boolean }) {
  if (!content) return null;
  const color = red ? "#f85149" : green ? "#3fb950" : blue ? "#58a6ff" : "#e6edf3";
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: small ? 11 : 12, fontWeight: 700, color: "#8b949e", marginBottom: small ? 3 : 5, textTransform: "uppercase", letterSpacing: 0.5 }}>{title}</div>
      <div style={{ fontSize: small ? 12 : 14, color, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{content}</div>
    </div>
  );
}

const wrap: React.CSSProperties = { padding: "24px", maxWidth: 900, margin: "0 auto" };
const cardStyle: React.CSSProperties = { background: "#161b22", border: "1px solid #30363d", borderRadius: 8, padding: "18px 22px" };
const badge: React.CSSProperties = { fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 12, color: "#fff" };
const loading: React.CSSProperties = { color: "#8b949e", textAlign: "center", padding: 48 };