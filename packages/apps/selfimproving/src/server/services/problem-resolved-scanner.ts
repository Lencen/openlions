/**
 * Problem Resolved Scanner (P1-2)
 * 2026-06-06 SHARED-BRAIN-V2
 *
 * 监听 Problem 状态变为 SOLVED, 写一条反思到 Lions-Mind Memory + FlywheelEvent
 * 标注 agentSource = PROBLEM_RESOLVED_HERMES / PROBLEM_RESOLVED_CLAUDE
 *
 * 触发链路:
 * 1. problem-resolver emit PROBLEM_SOLVED (oldStatus != SOLVED, newStatus == SOLVED)
 * 2. 本 scanner 订阅, 拉 problem + rootCause + solution
 * 3. 调 Lions-Mind memory.create
 * 4. 写本地 FlywheelEvent.stage = PROBLEM_RESOLVED
 */
import { eventBus } from "../event-bus";

const MIND_API = process.env.MIND_API_URL || "http://localhost:3000";

type ProblemResolvedAgent = "PROBLEM_RESOLVED_HERMES" | "PROBLEM_RESOLVED_CLAUDE";

function inferProblemAgent(problem: any): ProblemResolvedAgent {
  const t = `${problem.description || ""} ${problem.rootCause || ""}`.toLowerCase();
  if (t.includes("claude") || t.includes("代码") || t.includes("编译")) return "PROBLEM_RESOLVED_CLAUDE";
  return "PROBLEM_RESOLVED_HERMES";
}

function extractProblemContent(problem: any): string {
  const lines: string[] = [];
  lines.push(`问题解决反思: ${(problem.description || "").slice(0, 100)}`);

  if (problem.description) {
    lines.push(`\n## 问题描述\n${problem.description.slice(0, 500)}`);
  }
  if (problem.rootCause) {
    lines.push(`\n## 根因分析\n${problem.rootCause.slice(0, 500)}`);
  }
  if (problem.solutionsAttempted) {
    lines.push(`\n## 尝试的方案\n${problem.solutionsAttempted.slice(0, 500)}`);
  }
  if (problem.severity) {
    lines.push(`\n## 严重度: ${problem.severity}`);
  }
  if (problem.resolvedAt) {
    lines.push(`\n## 解决时间: ${new Date(problem.resolvedAt).toISOString()}`);
  }
  if (problem.taskExecution?.task?.title) {
    lines.push(`\n## 关联任务: ${problem.taskExecution.task.title}`);
  }

  return lines.join("\n");
}

async function writeMemory(
  content: string,
  problem: any,
  agentSource: ProblemResolvedAgent,
  tier: "HOT" | "WARM" | "COLD" = "WARM"
): Promise<{ id: string; deduplicated: boolean } | null> {
  try {
    const url = `${MIND_API}/api/trpc/memory.create`;
    const payload = {
      content,
      tier,
      type: "EXPERIENCE",
      domain: "problem-resolution",
      tags: `problem,solved,${agentSource}`,
      importance: 0.7,  // 问题解决比任务更重要
      agentSource,
    };
    const r = await fetch(url, {
      method: "POST",
      // 2026-10-19: 同 task-resolved-scanner —— memory.create 需 x-api-key, 否则 401。
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.LIONS_MIND_SERVICE_KEY || process.env.LIONS_MIND_API_KEY || "",
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      console.error(`[ProblemResolvedScanner] mind 返 ${r.status}`);
      return null;
    }
    const j = await r.json();
    const m = j?.result?.data ?? j;
    return { id: m?.id, deduplicated: !!m?.deduplicated };
  } catch (e: any) {
    console.error(`[ProblemResolvedScanner] memory.create 异常: ${e?.message ?? e}`);
    return null;
  }
}

async function writeFlywheelEvent(args: {
  sourceType: string;
  sourceId: string;
  sourceTitle: string;
  targetId: string;
}): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");
    await prisma.flywheelEvent.create({
      data: {
        stage: "PROBLEM_RESOLVED",
        sourceType: args.sourceType,
        sourceId: args.sourceId,
        sourceTitle: args.sourceTitle.slice(0, 80),
        targetStage: "MEMORIZE",
        targetType: "MEMORY",
        targetId: args.targetId,
      },
    });
  } catch (e: any) {
    console.error(`[ProblemResolvedScanner] flywheel 写入失败: ${e?.message ?? e}`);
  }
}

let started = false;

export function startProblemResolvedScanner(): void {
  if (started) return;
  started = true;

  console.log(`[ProblemResolvedScanner] Started — 监听 PROBLEM_SOLVED + PROBLEM_RESOLVED`);

  // 启动时扫描最近 24h 已解决的问题
  scanRecentSolvedProblems().catch((e) => {
    console.error(`[ProblemResolvedScanner] 启动扫描失败: ${e?.message ?? e}`);
  });

  // 订阅 PROBLEM_SOLVED
  eventBus.on("PROBLEM_SOLVED", async (event) => {
    const p = event.payload as { problemId: string; rootCause: string; solution: string };
    await handleProblemSolved(p.problemId, event.actor);
  });

  // 订阅 PROBLEM_RESOLVED (兼容两种事件)
  eventBus.on("PROBLEM_RESOLVED", async (event) => {
    const p = event.payload as { problemId: string; severity: string; rootCause: string };
    await handleProblemSolved(p.problemId, event.actor);
  });

  // 订阅 PROBLEM_STATUS_CHANGED (兼容 scheduler 触发)
  eventBus.on("PROBLEM_STATUS_CHANGED", async (event) => {
    const p = event.payload as { problemId: string; oldStatus: string; newStatus: string };
    if (p.newStatus === "SOLVED") {
      await handleProblemSolved(p.problemId, event.actor);
    }
  });
}

async function handleProblemSolved(problemId: string, actor: string): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");

    // 防重复
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await prisma.flywheelEvent.findFirst({
      where: {
        stage: "PROBLEM_RESOLVED",
        sourceId: problemId,
        createdAt: { gte: since },
      },
    });
    if (recent) {
      console.log(`[ProblemResolvedScanner] problem ${problemId} 1h 内已写过 RESOLVED, 跳过`);
      return;
    }

    const problem = await prisma.problem.findUnique({
      where: { id: problemId },
      include: {
        taskExecution: { include: { task: true } },
      },
    });
    if (!problem) {
      console.warn(`[ProblemResolvedScanner] problem ${problemId} 不存在`);
      return;
    }

    const agentSource = inferProblemAgent(problem);
    const content = extractProblemContent(problem);

    const m = await writeMemory(content, problem, agentSource, "WARM");
    if (!m) {
      console.warn(`[ProblemResolvedScanner] problem ${problemId} memory 写入失败`);
      return;
    }

    await writeFlywheelEvent({
      sourceType: agentSource,
      sourceId: problem.id,
      sourceTitle: problem.description?.slice(0, 50) || `Problem ${problem.id.slice(0, 8)}`,
      targetId: m.id,
    });

    console.log(
      `[ProblemResolvedScanner] ✓ problem ${problemId} -> mind memory ${m.id} (${m.deduplicated ? "dedup" : "new"}, src=${agentSource})`
    );
  } catch (e: any) {
    console.error(`[ProblemResolvedScanner] handleProblemSolved 异常: ${e?.message ?? e}`);
  }
}

async function scanRecentSolvedProblems(): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const problems = await prisma.problem.findMany({
      where: {
        status: "SOLVED",
        resolvedAt: { gte: since },
      },
      take: 50,
      orderBy: { resolvedAt: "desc" },
    });
    console.log(`[ProblemResolvedScanner] 历史扫描: ${problems.length} 个最近 24h 已解决问题`);
    for (const p of problems) {
      await handleProblemSolved(p.id, "scanner");
    }
  } catch (e: any) {
    console.error(`[ProblemResolvedScanner] scanRecentSolvedProblems 失败: ${e?.message ?? e}`);
  }
}
