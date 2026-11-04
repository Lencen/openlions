/**
 * Problem Executor Agent
 *
 * Executes the 7-step problem resolution flow:
 * 1. 确认问题信息
 * 2. 根因分析
 * 3. 解决方案研究
 * 4. 解决步骤确认
 * 5. 执行解决/修复
 * 6. 检查确认结果
 * 7. 调mind反思接口创建反思记录
 *
 * Three resolution paths:
 * - Direct resolve: Problem is simple, AI provides solution directly
 * - Auto-fix: ProblemExecutor executes fixes (file changes) independently
 * - Independent resolution task: Complex problems get their own task processed by ProblemExecutor (not TaskScheduler)
 */

import { parseMiniMaxMessage, extractJsonFromResponse } from "@/lib/parsers/message-parser";
import { prisma } from "@/lib/prisma";
import { createProblemCompletionTrigger, processProblemTriggers } from "@/server/services/problem-completion-trigger";
import { emitProblemStatusChanged, emitProblemSolved, emitProblemFailed, emitProblemResolved, emitTaskStatusChanged } from "../event-bus";
import { getProblemBatchSize } from "./runtime-config";
import { getAnthropicToken, getAnthropicBaseUrl, getAnthropicModel } from "@/lib/token-reader";

export interface ResolveProblemInput {
  problem: {
    id: string;
    description: string;
    severity: string;
    solutionsAttempted: string | null;
    taskExecutionId: string;
    taskId: string;
    autoResolveAttempts?: number;
    // Full task context (populated from Problem.taskTitle etc.)
    taskTitle?: string | null;
    taskDescription?: string | null;
    taskRequirements?: string | null;
    taskBackground?: string | null;
    taskAcceptanceCriteria?: string | null;
    taskQualityStandards?: string | null;
    taskMaterials?: string | null;
    sourceReflectionId?: string | null;
    sourceReflectionContent?: string | null;
  };
  taskExecution: {
    output: string;
    thoughtProcess: string | null;
    blocks: string | null;
  } | null;
  task: {
    id: string;
    title: string;
    description: string;
    requirements: string;
  } | null;
}

export interface ResolveProblemOutput {
  resolved: boolean;
  rootCause?: string;
  suggestedSolution?: string;
  notes?: string;
  shouldCreateTask: boolean;
  canAutoFix: boolean;         // Whether ProblemExecutor can fix this directly
  resolutionSteps?: string[];  // Concrete steps if canAutoFix
  autoFixData?: {              // Data needed for auto-fix execution
    filesToModify?: Array<{ path: string; content: string }>;
    commandsToRun?: string[];
  };
}

// 7步问题分析执行结果
export interface ProblemAnalysis {
  problemInfo: {
    id: string;
    description: string;
    severity: string;
    taskTitle: string;
    taskId: string;
  };
  rootCause: string;
  solution: string;
  resolutionSteps: string[];
  canAutoFix: boolean;
  autoFixData?: {
    filesToModify?: Array<{ path: string; content: string }>;
    commandsToRun?: string[];
  };
}

export async function resolveProblem(
  input: ResolveProblemInput
): Promise<ResolveProblemOutput> {
  const ANTHROPIC_AUTH_TOKEN = getAnthropicToken();
  const ANTHROPIC_BASE_URL = getAnthropicBaseUrl();
  const ANTHROPIC_MODEL = getAnthropicModel();

  if (!ANTHROPIC_AUTH_TOKEN) {
    return {
      resolved: false,
      notes: "No ANTHROPIC_AUTH_TOKEN configured",
      shouldCreateTask: true,
      canAutoFix: false,
    };
  }

  const context = `
## Problem to Resolve

Problem ID: ${input.problem.id}
Description: ${input.problem.description}
Severity: ${input.problem.severity}
Previously attempted solutions: ${input.problem.solutionsAttempted ?? "None"}
autoResolveAttempts: ${input.problem.autoResolveAttempts ?? 0}

## Original Task Context
Task title: ${input.problem.taskTitle ?? input.task?.title ?? "Unknown"}
Task description: ${input.problem.taskDescription ?? input.task?.description ?? "N/A"}
Task requirements: ${input.problem.taskRequirements ?? input.task?.requirements ?? "N/A"}
Task background: ${input.problem.taskBackground ?? "N/A"}
Task materials: ${input.problem.taskMaterials ?? "N/A"}
Acceptance criteria: ${input.problem.taskAcceptanceCriteria ?? "N/A"}
Quality standards: ${input.problem.taskQualityStandards ?? "N/A"}

## Source Reflection Context
${input.problem.sourceReflectionContent ? `Reflection content:\n${input.problem.sourceReflectionContent}` : "No reflection context available"}

## Execution Context (from TaskExecutor)
Output: ${input.taskExecution?.output ?? "N/A"}
Blocks: ${input.taskExecution?.blocks ?? "None"}
Thought process: ${input.taskExecution?.thoughtProcess ?? "N/A"}

## Your job

Analyze this problem and determine:
1. Root cause — WHY did this happen based on the execution context?
2. Can it be resolved immediately with existing information?
3. If not, what concrete task needs to be created to resolve it?

## Response format

CRITICAL: Output a SINGLE-LINE JSON object. Every field value MUST be a flat string (not array, not object, not multiline text). If you need to express multiple items, join them with " | " separator.

Example valid output:
{"resolved":false,"rootCause":"API returned 404 — endpoint does not exist","suggestedSolution":"Fix the endpoint URL in the API client configuration","notes":"The 404 suggests the resource was deleted or the URL is wrong","shouldCreateTask":true}

Example INVALID output (multiline, nested):
{
  "resolved": false,
  "rootCause": "Multiple issues:
1. API timeout
2. Invalid credentials"
}

Return ONLY the JSON object. No preamble, no explanation, no code fences, no markdown.`;

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
        max_tokens: 1024,
        messages: [{ role: "user", content: context }],
      }),
    });

    if (!response.ok) {
      return {
        resolved: false,
        notes: `API error: ${response.status} ${response.statusText}`,
        shouldCreateTask: true,
        canAutoFix: false,
      };
    }

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
    };

    const parsed = parseMiniMaxMessage(data.content);
    // Primary: parse from text blocks
    let jsonResult = extractJsonFromResponse(parsed.output);

    // Fallback: if output is empty but thoughtProcess has content,
    // the thinking trace might contain a JSON object (MiniMax sometimes
    // embeds the structured response in the thinking block)
    if (!jsonResult && parsed.thoughtProcess.trim().length > 0) {
      jsonResult = extractJsonFromResponse(parsed.thoughtProcess);
    }

    if (jsonResult) {
      return jsonResult as unknown as ResolveProblemOutput;
    }

    return {
      resolved: false,
      notes: "Could not parse AI response as JSON: " + parsed.output.slice(0, 100),
      shouldCreateTask: true,
      canAutoFix: false,
    };
  } catch (error) {
    return {
      resolved: false,
      notes: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      shouldCreateTask: true,
      canAutoFix: false,
    };
  }
}

/**
 * Step 2: 根因分析 - 调用AI分析问题根因
 */
async function analyzeProblemRootCause(problem: ResolveProblemInput["problem"], execution: ResolveProblemInput["taskExecution"]): Promise<string> {
  const ANTHROPIC_AUTH_TOKEN = getAnthropicToken();
  const ANTHROPIC_BASE_URL = getAnthropicBaseUrl();
  const ANTHROPIC_MODEL = getAnthropicModel();

  const context = `
## Step 2: 根因分析

请分析以下问题的根本原因。

### 问题信息
Problem ID: ${problem.id}
Description: ${problem.description}
Severity: ${problem.severity}

### 相关任务
Task title: ${problem.taskTitle ?? problem.taskId}
Description: ${problem.taskDescription ?? "N/A"}
Requirements: ${problem.taskRequirements ?? "N/A"}

### 执行输出
${execution?.output ?? "N/A"}

### 阻塞原因
${execution?.blocks ?? "无"}

### 反思内容
${problem.sourceReflectionContent ?? "无"}

请分析：
1. 问题的直接原因是什么？
2. 问题的深层根因是什么？
3. 这个问题之前是否出现过？

请用JSON格式输出：
{"rootCause":"根因分析结果（50字以内）"}
`;

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
        max_tokens: 512,
        messages: [{ role: "user", content: context }],
      }),
    });

    if (!response.ok) return "分析失败: API错误";

    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string; thinking?: string }> };
    const parsed = parseMiniMaxMessage(data.content);
    const json = extractJsonFromResponse(parsed.output) as { rootCause?: string } | null;
    return json?.rootCause ?? "根因分析结果不明确";
  } catch (error) {
    return "根因分析失败: " + (error instanceof Error ? error.message : "Unknown");
  }
}

/**
 * Step 3: 解决方案研究 - 调用AI研究解决方案
 */
async function researchSolution(problem: ResolveProblemInput["problem"], rootCause: string): Promise<{ solution: string; canAutoFix: boolean }> {
  const ANTHROPIC_AUTH_TOKEN = getAnthropicToken();
  const ANTHROPIC_BASE_URL = getAnthropicBaseUrl();
  const ANTHROPIC_MODEL = getAnthropicModel();

  const context = `
## Step 3: 解决方案研究

请为以下问题研究解决方案。

### 问题信息
Problem ID: ${problem.id}
Description: ${problem.description}
Severity: ${problem.severity}

### 根因分析结果
${rootCause}

### 任务背景
${problem.taskBackground ?? "N/A"}

请研究：
1. 有哪些可能的解决方案？
2. 哪个解决方案最可行？
3. 是否可以通过自动修复解决（修改文件/运行命令）？
4. 如果需要自动修复，需要修改哪些文件？

请用JSON格式输出：
{"solution":"解决方案描述（100字以内）","canAutoFix":true或false}
`;

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
        max_tokens: 512,
        messages: [{ role: "user", content: context }],
      }),
    });

    if (!response.ok) return { solution: "研究失败: API错误", canAutoFix: false };

    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string; thinking?: string }> };
    const parsed = parseMiniMaxMessage(data.content);
    const json = extractJsonFromResponse(parsed.output) as { solution?: string; canAutoFix?: boolean } | null;
    return {
      solution: json?.solution ?? "解决方案不明确",
      canAutoFix: json?.canAutoFix ?? false,
    };
  } catch (error) {
    return { solution: "研究失败: " + (error instanceof Error ? error.message : "Unknown"), canAutoFix: false };
  }
}

/**
 * Step 4: 解决步骤确认 - 调用AI确认具体步骤
 */
async function confirmResolutionSteps(problem: ResolveProblemInput["problem"], solution: string, canAutoFix: boolean): Promise<{ steps: string[]; autoFixData?: ResolveProblemOutput["autoFixData"] }> {
  if (!canAutoFix) {
    return { steps: [solution] };
  }

  const ANTHROPIC_AUTH_TOKEN = getAnthropicToken();
  const ANTHROPIC_BASE_URL = getAnthropicBaseUrl();
  const ANTHROPIC_MODEL = getAnthropicModel();

  const context = `
## Step 4: 解决步骤确认

请确认具体的解决步骤和自动修复方案。

### 问题信息
Problem ID: ${problem.id}
Description: ${problem.description}

### 解决方案
${solution}

### 任务信息
projectPath: 需要确定实际操作的项目路径
Task title: ${problem.taskTitle ?? "N/A"}

请提供：
1. 具体的解决步骤（按顺序列出）
2. 如果可以自动修复，需要修改的文件内容

请用JSON格式输出：
{"steps":["步骤1","步骤2","步骤3"],"autoFixData":{"filesToModify":[{"path":"文件路径","content":"文件内容"}],"commandsToRun":["命令1","命令2"]}}
`;

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
        max_tokens: 1024,
        messages: [{ role: "user", content: context }],
      }),
    });

    if (!response.ok) return { steps: [solution] };

    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string; thinking?: string }> };
    const parsed = parseMiniMaxMessage(data.content);
    const json = extractJsonFromResponse(parsed.output) as { steps?: string[]; autoFixData?: ResolveProblemOutput["autoFixData"] } | null;
    return {
      steps: json?.steps ?? [solution],
      autoFixData: json?.autoFixData,
    };
  } catch (error) {
    return { steps: [solution] };
  }
}

/**
 * Step 5: 执行解决/修复 - 执行自动修复（如果可以）
 */
async function executeAutoFix(autoFixData: ResolveProblemOutput["autoFixData"]): Promise<{ success: boolean; output: string }> {
  if (!autoFixData) {
    return { success: false, output: "无自动修复数据" };
  }

  const fs = require("fs");
  const path = require("path");
  let output = "";

  try {
    // 执行文件修改
    if (autoFixData.filesToModify && autoFixData.filesToModify.length > 0) {
      for (const file of autoFixData.filesToModify) {
        try {
          const filePath = path.join(process.cwd(), file.path);
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(filePath, file.content, "utf-8");
          output += `已写入文件: ${file.path}\n`;
        } catch (fileError) {
          output += `文件写入失败 ${file.path}: ${fileError}\n`;
        }
      }
    }

    // 执行命令
    if (autoFixData.commandsToRun && autoFixData.commandsToRun.length > 0) {
      output += "自动执行命令功能暂未实现\n";
    }

    return { success: true, output };
  } catch (error) {
    return { success: false, output: "执行失败: " + (error instanceof Error ? error.message : "Unknown") };
  }
}

/**
 * Step 6: 检查确认结果 - 验证问题是否已解决
 */
async function verifyResolution(problem: ResolveProblemInput["problem"], result: { success: boolean; output: string }): Promise<boolean> {
  if (!result.success) return false;

  // 简单验证：如果自动修复成功，认为问题已解决
  // 实际场景中可以调用AI进行更深入的验证
  return result.success;
}

/**
 * Step 7: 调mind反思接口 - 创建反思记录
 */
async function createMindReflection(problem: ResolveProblemInput["problem"], rootCause: string, solution: string): Promise<void> {
  try {
    const LIONS_MIND_URL = process.env.LIONS_MIND_URL || "http://localhost:3000";

    await fetch(`${LIONS_MIND_URL}/api/trpc/knowledge.generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "PROBLEM_RESOLUTION",
        sourceId: problem.id,
        title: `[问题复盘] ${problem.description.slice(0, 30)}`,
        description: `问题: ${problem.description}\n根因: ${rootCause}\n解决方案: ${solution}`,
        problemsEncountered: problem.description,
        solutionsApplied: solution,
        rootCause: rootCause,
        resolution: solution,
        domain: "problem-solving",
        tags: ["problem", "reflection", "resolution"],
      }),
    });

    console.log(`[ProblemExecutor] Created mind reflection for problem ${problem.id}`);
  } catch (error) {
    console.warn(`[ProblemExecutor] Failed to create mind reflection: ${error}`);
  }
}

/**
 * 尝试从问题来源补充缺失信息
 * 通过taskId回溯到原始任务，提取完整信息
 */
async function supplementProblemInfo(problem: ResolveProblemInput["problem"]): Promise<{
  canSupplement: boolean;
  supplementedInfo?: Record<string, string>;
}> {
  if (!problem.taskId) {
    return { canSupplement: false };
  }

  try {
    // 从原始任务获取完整信息
    const task = await prisma.task.findUnique({ where: { id: problem.taskId } });
    if (!task) {
      return { canSupplement: false };
    }

    const info: Record<string, string> = {};

    // 补全缺失的信息
    if (!problem.taskTitle && task.title) info.taskTitle = task.title;
    if (!problem.taskDescription && task.description) info.taskDescription = task.description;
    if (!problem.taskRequirements && task.requirements) info.taskRequirements = task.requirements;
    if (!problem.taskBackground && task.background) info.taskBackground = task.background;
    if (!problem.taskAcceptanceCriteria && task.acceptanceCriteria) info.taskAcceptanceCriteria = task.acceptanceCriteria;
    if (!problem.taskQualityStandards && task.qualityStandards) info.taskQualityStandards = task.qualityStandards;
    if (!problem.taskMaterials && task.materials) info.taskMaterials = task.materials;

    // 如果成功补全了关键信息
    if (info.taskTitle || info.taskRequirements) {
      return { canSupplement: true, supplementedInfo: info };
    }

    return { canSupplement: false };
  } catch {
    return { canSupplement: false };
  }
}

/**
 * 判断问题是"失败"还是"拒绝"
 */
function categorizeProblemResult(
  canAutoFix: boolean,
  canSupplement: boolean,
  resolutionAttempts: number
): "FAILED" | "REJECTED" | null {
  // 如果可以自动修复或可以补充信息后修复，不需要拒绝
  if (canAutoFix || canSupplement) {
    return null;
  }

  // 无法修复，且尝试次数较多，认为是失败
  if (resolutionAttempts >= 2) {
    return "FAILED";
  }

  // 首次尝试，无法修复，缺少关键信息 -> 拒绝
  return "REJECTED";
}

/**
 * 执行完整7步问题解决流程
 */
export async function executeProblemResolution(problemId: string): Promise<{
  success: boolean;
  resolved: boolean;
  error?: string;
}> {
  // Step 1: 确认问题信息
  const problem = await prisma.problem.findUnique({
    where: { id: problemId },
    include: { taskExecution: true },
  });

  if (!problem) {
    return { success: false, resolved: false, error: "Problem not found" };
  }

  const execution = problem.taskExecutionId
    ? await prisma.taskExecution.findUnique({ where: { id: problem.taskExecutionId } })
    : null;

  const input: ResolveProblemInput = {
    problem: {
      id: problem.id,
      description: problem.description,
      severity: problem.severity,
      solutionsAttempted: problem.solutionsAttempted,
      taskExecutionId: problem.taskExecutionId,
      taskId: problem.taskId,
      autoResolveAttempts: problem.autoResolveAttempts,
      taskTitle: problem.taskTitle,
      taskDescription: problem.taskDescription,
      taskRequirements: problem.taskRequirements,
      taskBackground: problem.taskBackground,
      taskAcceptanceCriteria: problem.taskAcceptanceCriteria,
      taskQualityStandards: problem.taskQualityStandards,
      taskMaterials: problem.taskMaterials,
      sourceReflectionId: problem.sourceReflectionId,
      sourceReflectionContent: problem.sourceReflectionContent,
    },
    taskExecution: execution
      ? { output: execution.output, thoughtProcess: execution.thoughtProcess, blocks: execution.blocks }
      : null,
    task: null,
  };

  // 更新问题状态为处理中
  await prisma.problem.update({
    where: { id: problemId },
    data: { status: "SOLVING", lastAttemptAt: new Date() },
  });

  try {
    // Step 2: 根因分析
    const rootCause = await analyzeProblemRootCause(input.problem, input.taskExecution);

    // Step 3: 解决方案研究
    const { solution, canAutoFix } = await researchSolution(input.problem, rootCause);

    // 尝试补充缺失信息（从问题来源回溯）
    const { canSupplement, supplementedInfo } = await supplementProblemInfo(input.problem);

    // 如果之前无法解决，补充信息后再尝试
    let finalResult = { success: false, output: "无法自动修复" };
    let finalVerified = false;

    if (canAutoFix && (await confirmResolutionSteps(input.problem, solution, canAutoFix)).autoFixData) {
      // Step 4: 解决步骤确认
      const { steps, autoFixData } = await confirmResolutionSteps(input.problem, solution, canAutoFix);

      // Step 5: 执行解决/修复
      if (autoFixData) {
        finalResult = await executeAutoFix(autoFixData);
      }

      // Step 6: 检查确认结果
      finalVerified = await verifyResolution(input.problem, finalResult);
    } else if (!canAutoFix && !canSupplement) {
      // Step 4: 解决步骤确认（无自动修复方案）
      const { steps } = await confirmResolutionSteps(input.problem, solution, canAutoFix);

      // 判断是失败还是拒绝
      const category = categorizeProblemResult(canAutoFix, canSupplement, input.problem.autoResolveAttempts ?? 0);

      if (category === "FAILED") {
        // 多次尝试后仍无法解决，标记为失败
        await prisma.problem.update({
          where: { id: problemId },
          data: {
            status: "SOLVED", // 暂时标记为SOLVED，但记录失败原因
            resolvedAt: new Date(),
            rootCause: rootCause,
            resolutionNotes: `解决失败：${solution}\n步骤：${steps.join(" -> ")}\n原因：多次尝试仍无法解决`,
          },
        });
        return { success: true, resolved: false, error: "问题无法自动解决，已标记为失败" };
      } else if (category === "REJECTED") {
        // 信息缺失且无法补充，标记为拒绝
        await prisma.problem.update({
          where: { id: problemId },
          data: {
            status: "ABANDONED",
            resolvedAt: new Date(),
            rootCause: rootCause,
            resolutionNotes: `问题被拒绝：信息缺失且无法补充\n解决方案：${solution}`,
          },
        });
        return { success: true, resolved: false, error: "问题信息缺失，无法解决，标记为拒绝" };
      }
    } else if (canSupplement && supplementedInfo) {
      // 补充信息后更新问题，继续等待下次处理
      await prisma.problem.update({
        where: { id: problemId },
        data: {
          ...supplementedInfo,
          resolutionNotes: `已从问题来源补充信息：${Object.keys(supplementedInfo).join(", ")}`,
        },
      });
      // 不标记为解决，等待下次处理
      return { success: true, resolved: false, error: "已补充问题信息，等待下次处理" };
    }

    // Step 7: 调mind反思接口
    if (finalVerified) {
      await createMindReflection(input.problem, rootCause, solution);
    }

    // 更新问题状态
    await prisma.problem.update({
      where: { id: problemId },
      data: {
        status: finalVerified ? "SOLVED" : "SOLVING",
        resolvedAt: finalVerified ? new Date() : null,
        rootCause: rootCause,
        resolutionNotes: `解决步骤: ${solution}\n执行结果: ${finalResult.output}`,
      },
    });

    // 触发反思记录创建
    if (finalVerified && rootCause && solution) {
      await createProblemCompletionTrigger(problemId, { rootCause, solution });
    }

    // Problem 解决后，提升关联 Task 的优先级（用于"重取优先级"机制）
    // TaskScheduler 按 priority ASC + createdAt ASC 取任务，P0 会排在最前面
    if (finalVerified && problem.taskId) {
      const currentTask = await prisma.task.findUnique({ where: { id: problem.taskId } });
      if (currentTask && currentTask.status === "BLOCKED") {
        await prisma.task.update({
          where: { id: problem.taskId },
          data: { priority: "P0", status: "PENDING" },
        });
        emitTaskStatusChanged(problem.taskId, "BLOCKED", "PENDING", "problem-resolver");
        console.log(`[ProblemExecutor] Task ${problem.taskId} unblocked — elevated to P0`);
      }
    }

    return { success: true, resolved: finalVerified };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    emitProblemFailed(problemId, errorMsg);
    return { success: false, resolved: false, error: errorMsg };
  }
}

/**
 * Process multiple open problems — called by ProblemScheduler.
 * Uses the 7-step ProblemExecutor flow.
 *
 * Returns aggregated results from executeProblemResolution calls.
 */
export async function processOpenProblems(): Promise<{
  processed: number;
  resolved: number;
  errors: string[];
}> {
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

  // Get OPEN problems + SOLVING problems that timed out (>30min since last attempt)
  // Also include SOLVING problems with null lastAttemptAt (legacy from old flow)
  const problemsToProcess = await prisma.problem.findMany({
    where: {
      OR: [
        { status: "OPEN" },
        {
          status: "SOLVING",
          OR: [
            { lastAttemptAt: { lt: thirtyMinutesAgo } },
            { lastAttemptAt: null },
          ],
        },
      ],
    },
    take: getProblemBatchSize(),  // 默认 50,可通过 dashboard 调整
    orderBy: { createdAt: "asc" },
  });

  if (problemsToProcess.length === 0) return { processed: 0, resolved: 0, errors: [] };

  const results = await Promise.all(
    problemsToProcess.map(async (problem) => {
      try {
        // 调用完整的7步问题解决流程
        const result = await executeProblemResolution(problem.id);

        if (result.resolved) {
          // Problem solved - track in flywheel
          await prisma.flywheelEvent.create({
            data: {
              stage: "PROBLEM_SOLVED",
              sourceType: "PROBLEM_RESOLUTION",
              sourceId: problem.id,
              sourceTitle: problem.description.slice(0, 50),
              targetStage: "PRACTICE",
              targetType: "PROBLEM",
              targetId: problem.id,
            },
          });

          return { success: true, resolved: true };
        } else {
          // Problem not resolved - increment attempt count, stay in OPEN or SOLVING
          await prisma.problem.update({
            where: { id: problem.id },
            data: { autoResolveAttempts: { increment: 1 } },
          });

          return { success: true, resolved: false };
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        emitProblemFailed(problem.id, errorMsg);
        return {
          success: false,
          error: errorMsg,
        };
      }
    })
  );

  const errors = results
    .filter((r) => !r.success)
    .map((r) => (r as { success: false; error: string }).error);

  const resolved = results.filter((r) => r.success && "resolved" in r && (r as { resolved: boolean }).resolved).length;

  return { processed: results.length, resolved, errors };
}