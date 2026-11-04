import { TASK_REVIEWER_PROMPT } from "./prompts/task-reviewer";
import type { TaskExecutorOutput } from "./task-executor";

export interface TaskReviewerInput {
  taskId: string;
  title: string;
  requirements: string;
  acceptanceCriteria: string;
  qualityStandards: string;
  execution: TaskExecutorOutput;
}

export interface TaskReviewerOutput {
  status: "PASSED" | "FAILED" | "REVISION_REQUIRED";
  score: number;
  strengths: string;
  weaknesses: string;
  lessonsLearned: string;
  feedbackNotes: string;
}

/**
 * TaskReviewer Agent
 *
 * Evaluates a completed task execution against:
 * 1. Acceptance criteria (is it done?)
 * 2. Quality standards (is it done well?)
 * 3. Thought process quality (can we learn from it?)
 *
 * In full crewAI integration:
 *
 * const agent = new Agent({
 *   role: "TaskReviewer",
 *   goal: "Evaluate task quality rigorously",
 *   backstory: TASK_REVIEWER_PROMPT,
 * });
 *
 * crewAI handles the LLM call and returns structured output.
 */
export async function reviewTask(
  task: TaskReviewerInput
): Promise<TaskReviewerOutput> {
  // Full integration with crewAI would look like:
  // const agent = new Agent({ role, goal, backstory, tools });
  // const crew = new Crew({ agents: [agent], tasks: [reviewTask] });
  // return crew.kickoff();

  // Heuristic fallback until agent is wired
  const score = heuristicScore(task);

  const strengths = [
    task.execution.status === "COMPLETED" ? "任务状态标记为完成" : null,
    task.execution.thoughtProcess ? "有思考过程记录" : null,
    task.execution.solutionsApplied ? "有解决方案记录" : null,
    task.execution.qualitySelfAssessment && task.execution.qualitySelfAssessment !== "0/10" ? "有自我质量评估" : null,
  ]
    .filter(Boolean)
    .join("\n") || "基本结构完整";

  const weaknesses = [
    !task.execution.thoughtProcess ? "缺少思考过程记录 — 难以复盘学习" : null,
    !task.execution.problemsEncountered && !task.execution.solutionsApplied ? "缺少问题/解决记录 — 经验未被捕获" : null,
    task.execution.status === "BLOCKED" ? "任务被阻塞 — 未实际执行" : null,
    task.execution.status === "FAILED" ? "任务执行失败 — 需要分析原因" : null,
  ]
    .filter(Boolean)
    .join("\n") || "无明显不足";

  return {
    status: score >= 6 ? (score >= 8 ? "PASSED" : "REVISION_REQUIRED") : "FAILED",
    score,
    strengths,
    weaknesses,
    lessonsLearned: `执行${task.execution.status === "COMPLETED" ? "成功" : task.execution.status === "FAILED" ? "失败" : "未完成"}，` +
      `质量自评：${task.execution.qualitySelfAssessment}`,
    feedbackNotes: score < 8
      ? `建议改进：${task.execution.blocks || "解决阻塞项后重新执行"}`
      : "任务执行质量良好，可进入下一阶段",
  };
}

function heuristicScore(task: TaskReviewerInput): number {
  let score = 5;

  if (task.execution.status === "COMPLETED") score += 2;
  if (task.execution.status === "BLOCKED") score -= 2;
  if (task.execution.status === "FAILED") score -= 1;

  if (task.execution.thoughtProcess && task.execution.thoughtProcess.length > 50) score += 1;
  if (task.execution.problemsEncountered && task.execution.problemsEncountered.length > 20) score += 1;
  if (task.execution.solutionsApplied && task.execution.solutionsApplied.length > 20) score += 1;
  if (task.execution.output && task.execution.output.length > 50) score += 1;

  return Math.min(10, Math.max(0, score));
}