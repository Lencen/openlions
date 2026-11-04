/**
 * Task Crew Orchestrator — crewAI integration for multi-agent task execution
 *
 * Wraps TaskExecutor + TaskReviewer as a crewAI Crew for complex scenarios.
 * This is a NEW capability layer — existing scheduler.ts is unaffected.
 *
 * Usage:
 *   import { TaskCrew } from "./orchestrator";
 *   const crew = TaskCrew.create(task);
 *   const results = await crew.kickoff();
 */
import { Agent, Crew, Task } from "crewai";
import type { Task } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Placeholder tools for crewAI Agent (not used in v1 — agents call prisma directly)
const noOpTool = {
  name: "no_op",
  description: "Placeholder tool",
  method: async () => ({ result: "nop" }),
};

/**
 * Create a crewAI Crew for executing and reviewing a single task.
 * Sequential process: TaskExecutor → TaskReviewer
 */
export async function createTaskCrew(taskId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`Task not found: ${taskId}`);

  // Agent 1: Task Executor
  const taskExecutor = new Agent({
    role: "TaskExecutor",
    goal: "Execute the given task and produce a detailed execution report",
    backstory: `You are the TaskExecutor agent. You specialize in executing tasks
delivered by the Lions-Task system. You follow the plan precisely, record your
thought process, and report problems encountered and solutions applied.`,
    verbose: false,
    tools: [noOpTool as any],
    memory: false,
  });

  // Agent 2: Task Reviewer
  const taskReviewer = new Agent({
    role: "TaskReviewer",
    goal: "Review completed task execution and provide structured feedback",
    backstory: `You are the TaskReviewer agent. You specialize in evaluating
task execution quality against acceptance criteria and quality standards.
You provide scores, identify strengths/weaknesses, and suggest improvements.`,
    verbose: false,
    tools: [noOpTool as any],
    memory: false,
  });

  // Task 1: Execute
  const executeTask = new Task({
    description: [
      `Execute task: ${task.title}`,
      `Description: ${task.description}`,
      `Background: ${task.background}`,
      `Requirements: ${task.requirements}`,
      `Materials: ${task.materials}`,
      `Acceptance Criteria: ${task.acceptanceCriteria}`,
      `Quality Standards: ${task.qualityStandards}`,
    ].join("\n"),
    agent: taskExecutor,
    expectedOutput:
      "JSON with fields: status (COMPLETED|FAILED|BLOCKED), thoughtProcess, output, " +
      "problemsEncountered, solutionsApplied, blocks, nextSteps, qualitySelfAssessment",
    async callback({ output }) {
      // Store execution result in DB
      const execution = await prisma.taskExecution.create({
        data: {
          taskId: task.id,
          status: "COMPLETED",
          output: typeof output === "string" ? output : JSON.stringify(output),
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });
      console.log(`[TaskCrew] Execution recorded: ${execution.id}`);
    },
  });

  // Task 2: Review (context = executeTask output)
  const reviewTask = new Task({
    description: [
      `Review execution of task: ${task.title}`,
      `Requirements: ${task.requirements}`,
      `Acceptance Criteria: ${task.acceptanceCriteria}`,
      `Quality Standards: ${task.qualityStandards}`,
      `Review the execution output and determine if the task meets all criteria.`,
    ].join("\n"),
    agent: taskReviewer,
    expectedOutput:
      "JSON with fields: status (PASSED|FAILED|REVISION_REQUIRED), score (0-10), " +
      "strengths, weaknesses, lessonsLearned, feedbackNotes",
    context: [executeTask],
  });

  // Create crew with sequential process
  const crew = new Crew({
    agents: [taskExecutor, taskReviewer],
    tasks: [executeTask, reviewTask],
    process: "sequential",
    verbose: false,
  });

  return crew;
}

/**
 * Quick execute-and-review for a task via crewAI.
 * Returns the final review result.
 */
export async function runTaskCrew(taskId: string) {
  const crew = await createTaskCrew(taskId);
  const results = await crew.kickoff();

  // Find the review task result
  const reviewResult = results.find((r: any) => r.taskName?.includes("review"));
  return reviewResult?.raw || results;
}