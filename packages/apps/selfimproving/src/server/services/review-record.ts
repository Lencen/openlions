/**
 * Review Record Service
 * 
 * Creates a review record when a task transitions from REVIEW to COMPLETED.
 * Used for quality tracking, analytics, and template improvement.
 */

import { prisma } from "@/lib/prisma";

export interface ReviewRecordInput {
  taskId: string;
  taskExecutionId: string;
  reviewType: "AUTO" | "MANUAL" | "REVIEWER" | "REVIEWER_REVISION" | "REVIEWER_PASS";
  reviewerId?: string;
  reviewResult: "PASSED" | "FAILED" | "REVISION_REQUIRED";
  qualityScore: number;
  keyFindings?: string[];
  issuesFound?: string[];
  improvementsSuggested?: string[];
}

/**
 * Create a review record for a task completion.
 */
export async function createReviewRecord(input: ReviewRecordInput): Promise<string | null> {
  try {
    // Get task and execution details for snapshot
    const task = await prisma.task.findUnique({ where: { id: input.taskId } });
    const execution = await prisma.taskExecution.findUnique({ where: { id: input.taskExecutionId } });

    if (!task || !execution) {
      console.error(`[ReviewRecord] Task or execution not found: ${input.taskId}`);
      return null;
    }

    // Create task snapshot
    const taskSnapshot = JSON.stringify({
      id: task.id,
      title: task.title,
      description: task.description,
      projectPath: task.projectPath,
      techStack: task.techStack,
      targetFiles: task.targetFiles,
      priority: task.priority,
      createdAt: task.createdAt,
    });

    // Create execution snapshot
    const executionSnapshot = JSON.stringify({
      id: execution.id,
      agentId: execution.agentId,
      agentRole: execution.agentRole,
      status: execution.status,
      duration: execution.completedAt && execution.startedAt
        ? execution.completedAt.getTime() - execution.startedAt.getTime()
        : 0,
      retryCount: execution.retryCount,
      qualityPassed: execution.qualityPassed,
      outputLength: execution.output?.length || 0,
    });

    const record = await prisma.reviewRecord.create({
      data: {
        taskId: input.taskId,
        taskExecutionId: input.taskExecutionId,
        reviewType: input.reviewType,
        reviewerId: input.reviewerId,
        reviewResult: input.reviewResult,
        qualityScore: input.qualityScore,
        keyFindings: input.keyFindings ? JSON.stringify(input.keyFindings) : null,
        issuesFound: input.issuesFound ? JSON.stringify(input.issuesFound) : null,
        improvementsSuggested: input.improvementsSuggested
          ? JSON.stringify(input.improvementsSuggested)
          : null,
        taskSnapshot,
        executionSnapshot,
      },
    });

    console.log(`[ReviewRecord] Created record ${record.id} for task ${input.taskId}`);
    return record.id;
  } catch (error) {
    console.error(`[ReviewRecord] Error creating record:`, error);
    return null;
  }
}

/**
 * Analyze review records to identify patterns and suggest template improvements.
 */
export async function analyzeReviewPatterns(): Promise<{
  commonIssues: string[];
  suggestedImprovements: string[];
}> {
  const recentRecords = await prisma.reviewRecord.findMany({
    where: {
      createdAt: {
        gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
      },
    },
    take: 50,
    orderBy: { createdAt: "desc" },
  });

  const issuesFound: Record<string, number> = {};
  const improvements: Record<string, number> = {};

  for (const record of recentRecords) {
    if (record.issuesFound) {
      try {
        const issues = JSON.parse(record.issuesFound) as string[];
        for (const issue of issues) {
          issuesFound[issue] = (issuesFound[issue] || 0) + 1;
        }
      } catch {}
    }

    if (record.improvementsSuggested) {
      try {
        const suggestions = JSON.parse(record.improvementsSuggested) as string[];
        for (const suggestion of suggestions) {
          improvements[suggestion] = (improvements[suggestion] || 0) + 1;
        }
      } catch {}
    }
  }

  // Sort and get top issues
  const commonIssues = Object.entries(issuesFound)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([issue]) => issue);

  const suggestedImprovements = Object.entries(improvements)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([improvement]) => improvement);

  return { commonIssues, suggestedImprovements };
}

/**
 * Get quality statistics from review records.
 */
export async function getQualityStats(): Promise<{
  totalReviews: number;
  passRate: number;
  avgQualityScore: number;
  byTaskType: Record<string, { count: number; avgScore: number }>;
}> {
  const records = await prisma.reviewRecord.findMany({
    take: 100,
    orderBy: { createdAt: "desc" },
  });

  if (records.length === 0) {
    return {
      totalReviews: 0,
      passRate: 0,
      avgQualityScore: 0,
      byTaskType: {},
    };
  }

  const passed = records.filter((r) => r.reviewResult === "PASSED").length;
  const totalScore = records.reduce((sum, r) => sum + r.qualityScore, 0);

  // Group by task type from taskSnapshot
  const byTaskType: Record<string, { count: number; totalScore: number }> = {};

  for (const record of records) {
    if (record.taskSnapshot) {
      try {
        const snapshot = JSON.parse(record.taskSnapshot);
        const type = snapshot.techStack || "GENERAL";
        if (!byTaskType[type]) {
          byTaskType[type] = { count: 0, totalScore: 0 };
        }
        byTaskType[type].count++;
        byTaskType[type].totalScore += record.qualityScore;
      } catch {}
    }
  }

  const byTaskTypeStats: Record<string, { count: number; avgScore: number }> = {};
  for (const [type, data] of Object.entries(byTaskType)) {
    byTaskTypeStats[type] = {
      count: data.count,
      avgScore: Math.round(data.totalScore / data.count),
    };
  }

  return {
    totalReviews: records.length,
    passRate: Math.round((passed / records.length) * 100),
    avgQualityScore: Math.round(totalScore / records.length),
    byTaskType: byTaskTypeStats,
  };
}