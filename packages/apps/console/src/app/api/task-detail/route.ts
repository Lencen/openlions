import { NextResponse } from "next/server";
import { asOf, num, one, openMind, parseInjection, q, safeClose } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// GET /api/task-detail?id=<taskId>
// 任务详情独立页数据源: 任务全字段 + 状态流转 + agent 执行记录 + 关联产物 + 裁定/注入事件
// 只读 + 容错: 任务不存在或库不可用时返回 found:false, 绝不 500。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  const mind = openMind();
  const empty = {
    asOf: asOf(), id, found: false,
    warnings: id ? ["未找到该任务, 或 mind 库不可用"] : ["缺少 id 参数"],
    task: null, transitions: [], executions: [], products: [], verdicts: [], injections: [], qualityAudit: null,
  };
  if (!id || !mind) {
    safeClose(mind);
    return NextResponse.json(empty);
  }

  const task = await one(mind, "SELECT * FROM Task WHERE id = ? LIMIT 1", id);
  if (!task) {
    safeClose(mind);
    return NextResponse.json(empty);
  }

  const transitions = await q(
    mind,
    "SELECT id, fromStatus, toStatus, actor, reason, createdAt FROM TaskStateTransition WHERE taskId = ? ORDER BY createdAt ASC LIMIT 200",
    id
  );

  // 2026-09-10: 同时返回各文本字段的"完整长度", 页面据此显式提示"已截断"(避免用户以为看到的就是全文)
  const executions = await q(
    mind,
    "SELECT id, agentId, agentRole, status, qualityPassed, retryCount, startedAt, completedAt, createdAt, " +
      "length(output) outputLength, substr(output,1,20000) output, " +
      "length(thoughtProcess) thoughtProcessLength, substr(thoughtProcess,1,4000) thoughtProcess, " +
      "length(problemsEncountered) problemsEncounteredLength, substr(problemsEncountered,1,2000) problemsEncountered, " +
      "length(solutionsApplied) solutionsAppliedLength, substr(solutionsApplied,1,2000) solutionsApplied, " +
      "length(nextSteps) nextStepsLength, substr(nextSteps,1,2000) nextSteps " +
      "FROM TaskExecution WHERE taskId = ? ORDER BY COALESCE(completedAt, startedAt, createdAt) ASC LIMIT 50",
    id
  );

  // 关联产物: 四类认知表里 sourceId = taskId 的行
  const products: any[] = [];
  const productTables: { table: string; titleCol: string }[] = [
    { table: "Knowledge", titleCol: "title" },
    { table: "Memory", titleCol: "COALESCE(title, substr(content,1,80))" },
    { table: "Practice", titleCol: "title" },
    { table: "Skill", titleCol: "name" },
  ];
  for (const t of productTables) {
    const rows = await q(
      mind,
      `SELECT id, ${t.titleCol} title, qualityScore, verification, stale, createdAt, usageCount FROM ${t.table} WHERE sourceId = ? ORDER BY createdAt DESC LIMIT 30`,
      id
    );
    for (const r of rows) {
      products.push({
        table: t.table, id: r.id, title: r.title, qualityScore: r.qualityScore,
        verification: r.verification ?? null, stale: r.stale ?? null,
        createdAt: num(r.createdAt), usageCount: r.usageCount ?? null,
      });
    }
  }
  products.sort((a, b) => b.createdAt - a.createdAt);

  // 2026-09-11 反向关联: 由本任务引发的待办 (sourceRefId = taskId 或 meta.taskIds 含该 taskId)
  const todoRows = await q(
    mind,
    "SELECT id, title, status, priority, ownerType, ownerId, source, sourceRefId, createdAt, updatedAt, doneAt, doneBy, substr(detail,1,400) detail, meta " +
      "FROM Todo WHERE sourceRefId = ? OR meta LIKE ? " +
      // 活跃待办排前面, DONE/DROPPED 沉底 (避免归档项淹没仍待处理项)
      "ORDER BY (CASE WHEN status IN ('DONE','DROPPED') THEN 1 ELSE 0 END), createdAt DESC LIMIT 50",
    id, "%" + id + "%"
  );
  const todos = todoRows.map((t) => {
    let metaObj: any = null;
    try { metaObj = t.meta ? JSON.parse(String(t.meta)) : null; } catch { metaObj = null; }
    const taskIds: string[] = Array.isArray(metaObj?.taskIds) ? metaObj.taskIds : [];
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      ownerType: t.ownerType,
      ownerId: t.ownerId,
      source: t.source,
      sourceRefId: t.sourceRefId,
      createdAt: num(t.createdAt),
      updatedAt: num(t.updatedAt),
      doneAt: t.doneAt ? num(t.doneAt) : null,
      doneBy: t.doneBy ?? null,
      detailPreview: t.detail ?? null,
      viaMeta: taskIds.includes(id),
      relatedTaskCount: taskIds.length,
      structured: String(t.detail || "").trim().startsWith("【"),
    };
  });

  // 裁定 / 人类干预 / 注入 / 产出收下 事件 (sourceTitle 里带 task=<id> 或 sourceId=taskId)
  const eventRows = await q(
    mind,
    "SELECT id, stage, sourceType, sourceId, substr(sourceTitle,1,500) sourceTitle, targetStage, createdAt FROM FlywheelEvent " +
      "WHERE (sourceId = ? OR sourceTitle LIKE ?) AND createdAt > ? ORDER BY createdAt DESC LIMIT 200",
    id, "%task=" + id + "%", num(task.createdAt) - 7 * 86400e3
  );
  const verdicts = eventRows
    .filter((e) => ["KNOWLEDGE_VERIFIED", "KNOWLEDGE_REJECTED", "KNOWLEDGE_PROPOSAL_ACCEPTED", "KNOWLEDGE_VERDICT_MISSING", "HUMAN_INTERVENTION", "QUALITY_AUDIT"].includes(e.stage))
    .map((e) => ({ id: e.id, stage: e.stage, sourceType: e.sourceType, targetId: e.sourceId, title: e.sourceTitle, at: num(e.createdAt) }));
  const injections = eventRows
    .filter((e) => e.stage === "CONTEXT_INJECTED")
    .map((e) => {
      const info = parseInjection(e.sourceTitle);
      return { id: e.id, agentId: info.agentId, count: info.ids.length || info.count, kinds: info.kinds, at: num(e.createdAt) };
    });
  const ingested = eventRows
    .filter((e) => e.stage === "AGENT_OUTPUT_INGESTED")
    .map((e) => ({ id: e.id, title: e.sourceTitle, at: num(e.createdAt) }));

  safeClose(mind);
  return NextResponse.json({
    asOf: asOf(),
    id,
    found: true,
    warnings: [],
    task: {
      ...task,
      createdAt: num(task.createdAt),
      updatedAt: num(task.updatedAt),
      completedAt: task.completedAt ? num(task.completedAt) : null,
    },
    transitions: transitions.map((t) => ({ ...t, createdAt: num(t.createdAt) })),
    executions: executions.map((e) => ({
      ...e,
      createdAt: num(e.createdAt),
      startedAt: e.startedAt ? num(e.startedAt) : null,
      completedAt: e.completedAt ? num(e.completedAt) : null,
    })),
    products,
    todos,
    verdicts,
    injections,
    ingested,
    stats: {
      todos: todos.length,
      transitions: transitions.length,
      executions: executions.length,
      outputChars: executions.reduce((s, e) => s + num(e.outputLength), 0),
      products: products.length,
      verdicts: verdicts.length,
      injections: injections.length,
      durationMs: task.completedAt && task.createdAt ? num(task.completedAt) - num(task.createdAt) : null,
    },
  });
}
