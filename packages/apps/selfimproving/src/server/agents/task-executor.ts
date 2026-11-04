import { TASK_EXECUTOR_PROMPT } from "./prompts/task-executor";
import { parseMiniMaxMessage, extractJsonFromResponse } from "@/lib/parsers/message-parser";
import { getAnthropicToken, getAnthropicBaseUrl, getAnthropicModel } from "@/lib/token-reader";

export interface TaskExecutorInput {
  taskId: string;
  title: string;
  description: string;
  background: string;
  requirements: string;
  materials: string;
  acceptanceCriteria: string;
  qualityStandards: string;
  priority: string;
}

export interface TaskExecutorOutput {
  status: "COMPLETED" | "FAILED" | "BLOCKED";
  thoughtProcess: string;
  output: string;
  problemsEncountered: string;
  solutionsApplied: string;
  blocks: string;
  nextSteps: string;
  qualitySelfAssessment: string;
}

// 2026-09-15 (finding f-001): 原来在**模块作用域**读 process.env 并缓存 —— 一旦应用启动时 env 未注入,
// 之后即使 .env.local 修好也永远为空。改为在 executeTask 调用时经 token-reader 取(带占位符校验 + 来源可观测)。

/**
 * Execute a task using Anthropic Claude API.
 */
export async function executeTask(
  task: TaskExecutorInput
): Promise<TaskExecutorOutput> {
  const ANTHROPIC_BASE_URL = getAnthropicBaseUrl();
  const ANTHROPIC_AUTH_TOKEN = getAnthropicToken();
  const ANTHROPIC_MODEL = getAnthropicModel();
  if (!ANTHROPIC_AUTH_TOKEN) {
    return {
      status: "BLOCKED",
      thoughtProcess: "",
      output: "",
      problemsEncountered: "",
      solutionsApplied: "",
      blocks: "No usable ANTHROPIC_AUTH_TOKEN configured — cannot execute task",
      nextSteps: "在 packages/apps/selfimproving/.env.local 配置真实 ANTHROPIC_AUTH_TOKEN(占位符/掩码会被拒绝)",
      qualitySelfAssessment: "0/10 — execution not started",
    };
  }

  const taskDoc = `
## Task: ${task.title}

### Context
${task.description}

### Background
${task.background}

### Requirements
${task.requirements}

### Materials
${task.materials}

### Acceptance Criteria
${task.acceptanceCriteria}

### Quality Standards
${task.qualityStandards}

### Priority
${task.priority}
`.trim();

  const prompt = `${TASK_EXECUTOR_PROMPT}

## Task Document
${taskDoc}

Return only the JSON object. No preamble.`;

  try {
    // P3 修复: fetch 加 AbortController timeout (90s)
    // 真根因: 之前无 timeout, LLM API 慢/429/卡 → fetch 永远不返回 → worker 卡死 → Task.status 永远 IN_PROGRESS
    // 90s 是 LLM API p99 timeout (比 60s 长以容下大输出)
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 90_000);
    let response;
    try {
      response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ANTHROPIC_AUTH_TOKEN}`,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 4096,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(fetchTimeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      return {
        status: "FAILED",
        thoughtProcess: "",
        output: "",
        problemsEncountered: `API error: ${response.status} ${response.statusText}`,
        solutionsApplied: "",
        blocks: "",
        nextSteps: `Fix API configuration: ${errorText.slice(0, 200)}`,
        qualitySelfAssessment: "0/10 — execution failed",
      };
    }

    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string; thinking?: string }> };
    const parsed = parseMiniMaxMessage(data.content);
    const responseText = parsed.output;

    // Try to parse as JSON from the text content
    const jsonResult = extractJsonFromResponse(responseText);
    let result: Partial<TaskExecutorOutput> = {};
    if (jsonResult) {
      result = jsonResult as Partial<TaskExecutorOutput>;
      // Ensure problemsEncountered is always a string, not an array
      if (Array.isArray(result.problemsEncountered)) {
        result.problemsEncountered = result.problemsEncountered.join("; ");
      }
    } else if (responseText.trim()) {
      // Response is not JSON — use raw text as output, preserve thinking blocks
      result = {
        status: "COMPLETED",
        thoughtProcess: parsed.thoughtProcess || "Task executed — response was not in structured JSON format",
        output: responseText.slice(0, 2000),
        problemsEncountered: "",
        solutionsApplied: "",
        blocks: "",
        nextSteps: "",
        qualitySelfAssessment: "5/10 — completed but output format unknown",
      };
    } else {
      // Empty response
      result = {
        status: "FAILED",
        thoughtProcess: parsed.thoughtProcess,
        output: "",
        problemsEncountered: "Empty response from API",
        solutionsApplied: "",
        blocks: "",
        nextSteps: "Check API configuration and request format",
        qualitySelfAssessment: "0/10 — empty response",
      };
    }

    const rawStatus = (result.status as string) || "";
    const upperStatus = rawStatus.toUpperCase();
    return {
      status: (upperStatus === "COMPLETED" || upperStatus === "FAILED" || upperStatus === "BLOCKED"
        ? upperStatus
        : "COMPLETED") as TaskExecutorOutput["status"],
      thoughtProcess: result.thoughtProcess || parsed.thoughtProcess || "",
      output: result.output || responseText.slice(0, 2000),
      problemsEncountered: result.problemsEncountered || "",
      solutionsApplied: result.solutionsApplied || "",
      blocks: result.blocks || "",
      nextSteps: result.nextSteps || "",
      qualitySelfAssessment: result.qualitySelfAssessment || "5/10 — completed",
    };
  } catch (error) {
    // P3 修复: 区分 abort timeout 和其他 error
    const isAbort = error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
    return {
      status: isAbort ? "FAILED" : "FAILED",
      thoughtProcess: "",
      output: "",
      problemsEncountered: isAbort
        ? "API call timed out after 90s — LLM API 慢/卡/429, fetch 主动 abort"
        : error instanceof Error ? error.message : "Unknown error",
      solutionsApplied: "",
      blocks: isAbort
        ? "LLM API 卡死. Reschedule with retry, 1min 内会重试"
        : "",
      nextSteps: isAbort
        ? "1) 检查 ANTHROPIC_BASE_URL 是否可达 2) 减少 max_tokens 3) 加 retry 退避"
        : "Fix execution environment",
      qualitySelfAssessment: "0/10 — execution failed",
    };
  }
}
