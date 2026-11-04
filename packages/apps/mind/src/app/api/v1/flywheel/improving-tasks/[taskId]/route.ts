/**
 * GET /api/v1/flywheel/improving-tasks/[taskId] — 单条改进任务详情 (2026-09-09 看板)
 * 返回: 任务全字段 + payload/structuredContext 结构化摘要 + 执行链(Transitions/Executions)
 *      + 完成后的数据流向(产物: Memory/Knowledge/Practice 的 FLYWHEEL_STRUCTURED 行)
 */
import { prisma } from "@/lib/prisma";

function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== "") return n;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.getTime();
    const d2 = new Date(v.replace(" ", "T") + "Z");
    if (!Number.isNaN(d2.getTime())) return d2.getTime();
  }
  return null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await ctx.params;
    const task: any = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return Response.json({ error: "NOT_FOUND" }, { status: 404 });

    let payload: any = null;
    try { payload = task.improvementPayload ? JSON.parse(task.improvementPayload) : null; } catch { payload = { parseError: true }; }
    let structured: any = null;
    try { structured = task.structuredContext ? JSON.parse(task.structuredContext) : null; } catch { structured = { parseError: true }; }

    const transitions: any[] = await prisma.taskStateTransition.findMany({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const executions: any[] = await prisma.taskExecution.findMany({
      where: { taskId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, agentId: true, status: true, output: true, qualityPassed: true, createdAt: true, completedAt: true, problemsEncountered: true },
    });

    // 产物窗口: 从任务创建起(轮次串行, 上一轮产物在更早任务窗口) → completedAt/now
    const startMs = toMs(task.createdAt);
    const endMs = toMs(task.completedAt) ?? Date.now() + 60000;
    const theme = task.theme || "";
    const produced: { type: string; count: number; samples: Array<{ id: string; title: string; createdAt: string | null }> }[] = [];
    if (theme && payload && !payload.parseError) {
      const tables: Array<[string, any]> = [
        ["Memory", { title: true, content: true }],
        ["Knowledge", { title: true, content: true }],
        ["Practice", { title: true, description: true }],
      ];
      for (const [tbl, sel] of tables) {
        try {
          const rows: any[] = await (prisma as any)[tbl.toLowerCase()].findMany({
            where: { theme, sourceType: "FLYWHEEL_STRUCTURED" },
            orderBy: { createdAt: "desc" },
            take: 100,
            select: { id: true, createdAt: true, ...sel },
          });
          const inWin = (rows || []).filter((r: any) => {
            const ms = toMs(r.createdAt);
            return ms != null && ms >= (startMs ?? 0) && ms <= endMs;
          });
          if (inWin.length > 0) {
            produced.push({
              type: tbl,
              count: inWin.length,
              samples: inWin.slice(0, 6).map((r: any) => ({
                id: r.id,
                title: String(r.title || r.content || r.description || "").slice(0, 90),
                createdAt: r.createdAt != null ? String(r.createdAt) : null,
              })),
            });
          }
        } catch (e: any) {
          console.warn(`[improving-task detail] produced ${tbl} fail (非致命): ${String(e?.message || e).slice(0, 200)}`);
        }
      }
    }

    return Response.json({
      task: {
        id: task.id, title: task.title, description: task.description, background: task.background,
        requirements: task.requirements, materials: task.materials, acceptanceCriteria: task.acceptanceCriteria,
        qualityStandards: task.qualityStandards, status: task.status, priority: task.priority, theme: task.theme,
        improvementType: task.improvementType, manualReview: task.manualReview,
        sourceReflectionIds: task.sourceReflectionIds, sourceSummaryId: task.sourceSummaryId,
        sourceProblemId: task.sourceProblemId, sourceTaskId: task.sourceTaskId, prerequisiteTaskIds: task.prerequisiteTaskIds,
        estimatedEffort: task.estimatedEffort, actualEffortMs: task.actualEffortMs,
        createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt, completedBy: task.completedBy,
        improvementPayload: task.improvementPayload,
      },
      payloadSummary: payload
        ? {
            actionCount: (payload.actions || []).length,
            actionTypes: countBy((payload.actions || []).map((a: any) => a.type)),
            findingCount: (payload.findings || []).length,
            cycleCount: (payload.cycles || []).length,
            coverageScore: payload.summary?.coverageScore ?? null,
            aliasedThemes: payload.aliasedThemes || [],
            relatedMemoryIds: payload.relatedMemoryIds || structured?.relatedMemoryIds || [],
          }
        : null,
      structured: structured ? {
        reflectionId: structured.reflectionId,
        reflectionUpdatedAt: structured.reflectionUpdatedAt,
        sourceChain: structured.sourceChain,
        relatedMemoryCount: structured.relatedMemoryCount,
      } : null,
      transitions: transitions.map((tr: any) => ({
        id: tr.id, fromStatus: tr.fromStatus, toStatus: tr.toStatus, actor: tr.actor,
        reason: (tr.reason || "").slice(0, 900),
        metadata: tr.metadata ? (() => { try { return JSON.parse(tr.metadata); } catch { return null; } })() : null,
        createdAt: tr.createdAt,
      })),
      executions: executions.map((e: any) => ({
        id: e.id, agentId: e.agentId, status: e.status, qualityPassed: e.qualityPassed,
        output: (e.output || "").slice(0, 1500), problemsEncountered: e.problemsEncountered || null,
        createdAt: e.createdAt, completedAt: e.completedAt,
      })),
      produced,
    });
  } catch (e: any) {
    console.error("[improving-task detail]", e);
    return Response.json({ error: (e && e.message) || String(e) }, { status: 500 });
  }
}

function countBy(arr: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of arr) o[x] = (o[x] || 0) + 1;
  return o;
}
