import { TASK_GENERATOR_PROMPT } from "./prompts/task-generator";
import { parseMiniMaxMessage, extractJsonFromResponse } from "@/lib/parsers/message-parser";
import { getAnthropicToken, getAnthropicBaseUrl, getAnthropicModel } from "@/lib/token-reader";

export interface TaskGeneratorInput {
  pendingAction: string;
  reflectionTitle: string;
  reflectionContent: string;
  reflectionCategory?: string;
  reflectionPriority?: string;
}

export interface TaskGeneratorOutput {
  title: string;
  description: string;
  background: string;
  requirements: string;
  materials: string;
  acceptanceCriteria: string;
  qualityStandards: string;
  priority: string;
  estimatedEffort: string;
}

export async function generateTaskFromPendingAction(
  input: TaskGeneratorInput
): Promise<TaskGeneratorOutput> {
  const ANTHROPIC_AUTH_TOKEN = getAnthropicToken();
  const ANTHROPIC_BASE_URL = getAnthropicBaseUrl();
  const ANTHROPIC_MODEL = getAnthropicModel();

  // Fallback to heuristic if no API token
  if (!ANTHROPIC_AUTH_TOKEN) {
    console.warn("[TaskGenerator] no usable ANTHROPIC_AUTH_TOKEN -> fallback heuristic");
    return heuristicTaskGenerator(input);
  }

  const prompt = buildPrompt(input);

  try {
    const response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ANTHROPIC_AUTH_TOKEN}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      console.warn(`[TaskGenerator] API error ${response.status}, falling back to heuristic`);
      return heuristicTaskGenerator(input);
    }

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
    };

    const parsed = parseMiniMaxMessage(data.content);
    const jsonResult = extractJsonFromResponse(parsed.output);

    if (jsonResult) {
      console.info(`[TaskGenerator] using LLM (model=${ANTHROPIC_MODEL}, tokenLen=${ANTHROPIC_AUTH_TOKEN.length})`);
      return validateOutput(jsonResult as Partial<TaskGeneratorOutput>);
    }

    // JSON parse failed, use heuristic
    console.warn(`[TaskGenerator] Could not parse LLM response as JSON, using heuristic`);
    return heuristicTaskGenerator(input);
  } catch (error) {
    console.error(`[TaskGenerator] LLM call failed: ${error}, falling back to heuristic`);
    return heuristicTaskGenerator(input);
  }
}

function buildPrompt(input: TaskGeneratorInput): string {
  return `${TASK_GENERATOR_PROMPT}

## Input

{
  "pendingAction": ${JSON.stringify(input.pendingAction)},
  "reflectionTitle": ${JSON.stringify(input.reflectionTitle)},
  "reflectionContent": ${JSON.stringify(input.reflectionContent.slice(0, 2000))},
  "reflectionCategory": ${JSON.stringify(input.reflectionCategory ?? null)},
  "reflectionPriority": ${JSON.stringify(input.reflectionPriority ?? null)}
}

Return only the JSON object. No preamble.`;
}

function toText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => String(x)).join("\n");
  return "";
}

function validateOutput(o: Partial<TaskGeneratorOutput>): TaskGeneratorOutput {
  const raw = o as unknown as Record<string, unknown>;
  return {
    title: o.title?.slice(0, 80) || "Untitled Task",
    description: o.description || "",
    background: o.background || "",
    requirements: toText(raw.requirements),
    materials: toText(raw.materials),
    acceptanceCriteria: toText(raw.acceptanceCriteria),
    qualityStandards: toText(raw.qualityStandards),
    priority: o.priority || "P2",
    estimatedEffort: o.estimatedEffort || "1-2 hours",
  };
}

function heuristicTaskGenerator(input: {
  pendingAction: string;
  reflectionTitle: string;
  reflectionContent: string;
  reflectionCategory?: string;
  reflectionPriority?: string;
}): TaskGeneratorOutput {
  const action = input.pendingAction.trim();
  const priority = input.reflectionPriority || detectPriority(action);

  const title = action.length > 80 ? action.slice(0, 77) + "…" : action;

  const description = [
    `任务目标：${action}`,
    ``,
    `预期成果：完成该改进项后，将带来以下变化：`,
    `1. 解决了反思"${input.reflectionTitle}"中提出的改进需求`,
    `2. 产出了具体的可验证的成果`,
    `3. 为后续类似工作积累了可复用的经验`,
  ].join("\n");

  const background = [
    `来源：每日总结反思 — "${input.reflectionTitle}"`,
    input.reflectionContent
      ? `反思内容摘要：${input.reflectionContent.slice(0, 200)}${input.reflectionContent.length > 200 ? "…" : ""}`
      : null,
    `背景：基于反思得出的改进方向，需要转化为可执行的行动项。`,
  ]
    .filter(Boolean)
    .join("\n");

  const requirements = [
    `1. 理解任务目标：分析"${action}"的具体含义`,
    `2. 收集信息：收集执行该任务所需的背景资料和相关知识`,
    `3. 制定计划：分解任务为具体可执行的步骤`,
    `4. 执行实施：按计划执行任务，产出具体成果`,
    `5. 验证完成：对照验收标准自检，确保任务完成且质量达标`,
  ].join("\n");

  const materials = [
    `1. 反思记录：${input.reflectionTitle}`,
    `2. 相关知识：从lions-mind知识库中检索相关领域的知识条目`,
    `3. 上下文理解：任务背景和需求文档`,
    `4. 如有代码任务：相关源代码文件、API文档`,
  ].join("\n");

  const acceptanceCriteria = [
    `1. 完成了"${action}"所描述的改进内容`,
    `2. 产出了可验证的成果物（文档、代码、分析报告等）`,
    `3. 执行过程有完整记录（思考过程、问题、解决方案）`,
    `4. 任务成果符合质量标准要求`,
  ].join("\n");

  const qualityStandards = [
    `1. 完整性：任务所有要求均已实现，无遗漏项`,
    `2. 准确性：产出内容准确无误，符合领域知识`,
    `3. 可读性：文档清晰、代码规范、表达准确`,
    `4. 可维护性：产出物易于后续使用和扩展`,
    `5. 反思性：执行过程有记录，问题有分析，解决有方案`,
  ].join("\n");

  const estimatedEffort = estimateEffort(action);

  return {
    title,
    description,
    background,
    requirements,
    materials,
    acceptanceCriteria,
    qualityStandards,
    priority,
    estimatedEffort,
  };
}

function detectPriority(action: string): string {
  const urgent = ["紧急", "立即", "马上", "critical", "urgent", "asap"];
  const high = ["重要", "优先", "p1", "p2", "关键"];
  if (urgent.some((w) => action.includes(w))) return "P1";
  if (high.some((w) => action.includes(w))) return "P2";
  return "P2";
}

function estimateEffort(action: string): string {
  const long = ["研究", "调研", "分析", "review", "research", "analyze", "设计"];
  const medium = ["改进", "优化", "implement", "improve", "refactor", "调整"];
  if (long.some((w) => action.includes(w))) return "2-4 小时";
  if (medium.some((w) => action.includes(w))) return "1-2 小时";
  return "30 分钟 - 1 小时";
}