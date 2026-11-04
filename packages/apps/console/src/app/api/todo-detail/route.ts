import { NextResponse } from "next/server";
import { asOf, num, one, openMind, q, safeClose } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// GET /api/todo-detail?id=<todoId>
// 待办详情补充数据 (对齐任务详情页的"执行链/关联产物"):
//   todo         —— 待办本体 (含 meta, 只读 mind 库)
//   relatedTasks —— meta.taskIds 解析出的任务摘要 (标题/状态/优先级/负责人/类型)
//   timeline     —— 处理时间线: 创建 (Todo 行) + TODO_STATUS/TODO_CREATED 事件 (FlywheelEvent) + 完成
//   source       —— 来源回溯 (source/sourceRefId 解析成可点对象)
// 只读 + 容错: 库不可用或待办不存在返回 found:false, 绝不 500。
const SOURCE_LABEL: Record<string, { label: string; build: (ref: string | null) => string | null }> = {
  goal_gap: { label: "目标缺口 / 任务", build: (ref) => (ref ? "/flywheel/tasks/" + ref : null) },
  verification: { label: "知识验证候选", build: (ref) => (ref ? "/cognitive/knowledge/detail?id=" + ref : null) },
  discussion: { label: "讨论发言", build: () => "/agents-live" },
  agent_proposal: { label: "智能体提案", build: () => "/agents-live" },
  review: { label: "平台审查", build: () => "/flywheel/audit" },
  human: { label: "人工创建", build: () => null },
  system: { label: "系统生成", build: () => null },
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  const empty = { asOf: asOf(), id, found: false, todo: null, relatedTasks: [], timeline: [], source: null };
  if (!id) return NextResponse.json({ ...empty, error: "缺少 id" });

  const mind = openMind();
  if (!mind) return NextResponse.json({ ...empty, error: "mind 库不可用" });

  const row = await one(mind, "SELECT * FROM Todo WHERE id = ? LIMIT 1", id);
  if (!row) {
    safeClose(mind);
    return NextResponse.json({ ...empty, error: "未找到该待办" });
  }

  const meta = (() => {
    try { return row.meta ? JSON.parse(String(row.meta)) : null; } catch { return null; }
  })();

  // ---- 关联任务摘要 (meta.taskIds) ----
  const taskIds: string[] = Array.isArray(meta?.taskIds) ? meta.taskIds.filter((x: any) => typeof x === "string") : [];
  let relatedTasks: any[] = [];
  if (taskIds.length) {
    const ph = taskIds.map(() => "?").join(",");
    relatedTasks = await q(
      mind,
      `SELECT id, title, status, priority, COALESCE(assignedAgent,'未指派') assignedAgent, improvementType, theme, updatedAt, completedAt FROM Task WHERE id IN (${ph})`,
      ...taskIds
    );
    // 保持 meta.taskIds 的顺序 (人工排列的优先级更可信)
    relatedTasks.sort((a, b) => taskIds.indexOf(a.id) - taskIds.indexOf(b.id));
    relatedTasks = relatedTasks.map((t) => ({ ...t, updatedAt: num(t.updatedAt), completedAt: t.completedAt ? num(t.completedAt) : null }));
  }

  // ---- 处理时间线 ----
  const events = await q(
    mind,
    "SELECT stage, sourceType, substr(sourceTitle,1,300) sourceTitle, targetStage, createdAt FROM FlywheelEvent " +
      "WHERE sourceId = ? AND stage IN ('TODO_STATUS','TODO_CREATED') ORDER BY createdAt ASC LIMIT 100",
    id
  );
  type TL = { at: number; kind: string; actor: string; text: string };
  const timeline: TL[] = [];
  timeline.push({
    at: num(row.createdAt),
    kind: "created",
    actor: row.createdBy || "-",
    text: `创建待办（来源 ${row.source || "-"}${row.sourceRefId ? " · " + String(row.sourceRefId).slice(0, 14) + "…" : ""}）`,
  });
  let hasDoneEvent = false;
  for (const e of events) {
    const title = String(e.sourceTitle || "");
    // sourceTitle 形如 "旧状态 -> 新状态 by 谁" (TODO_STATUS) 或 "human 标题" (TODO_CREATED)
    const stMatch = /^(\S+)\s*->\s*(\S+)\s*(?:by\s*(.+))?$/.exec(title);
    let actor = e.sourceType || "-";
    let text = title;
    if (stMatch) {
      actor = (stMatch[3] || actor).trim();
      text = `状态变更 ${stMatch[1]} → ${stMatch[2]}`;
      if (/->\s*DONE/.test(title)) hasDoneEvent = true;
    } else if (e.stage === "TODO_CREATED") {
      actor = title.split(" ")[0] || actor;
      text = "创建待办" + (title.split(" ").slice(1).join(" ").trim() ? "：" + title.split(" ").slice(1).join(" ").slice(0, 80) : "");
    }
    timeline.push({ at: num(e.createdAt), kind: e.stage === "TODO_CREATED" ? "created" : "status", actor, text });
  }
  if (row.doneAt && !hasDoneEvent) {
    timeline.push({ at: num(row.doneAt), kind: "done", actor: row.doneBy || "-", text: `标记完成${row.doneBy ? " (由 " + row.doneBy + ")" : ""}` });
  }
  timeline.sort((a, b) => a.at - b.at);
  // 若事件里已有创建事件, 去掉与首条重复的"创建待办"
  const dedup = timeline.filter((t, i) => !(i > 0 && t.kind === "created" && timeline[0].kind === "created" && t.at - timeline[0].at < 5000));

  // ---- 来源回溯 ----
  const srcKey = String(row.source || "");
  const srcDef = SOURCE_LABEL[srcKey] || { label: srcKey || "未标注", build: () => null };
  const refId = row.sourceRefId ? String(row.sourceRefId) : null;
  let sourceResolved: any = null;
  if (refId && srcKey === "goal_gap") {
    const t = await one(mind, "SELECT id, title, status FROM Task WHERE id = ? LIMIT 1", refId);
    if (t) sourceResolved = { kind: "task", id: t.id, title: t.title, status: t.status };
  } else if (refId && srcKey === "verification") {
    const k = await one(mind, "SELECT id, title, verification FROM Knowledge WHERE id = ? LIMIT 1", refId);
    if (k) sourceResolved = { kind: "knowledge", id: k.id, title: k.title, status: k.verification };
  }

  safeClose(mind);
  return NextResponse.json({
    asOf: asOf(),
    id,
    found: true,
    todo: { ...row, meta, dueAt: row.dueAt ? num(row.dueAt) : null, createdAt: num(row.createdAt), updatedAt: num(row.updatedAt), doneAt: row.doneAt ? num(row.doneAt) : null },
    relatedTasks,
    timeline: dedup,
    source: {
      source: srcKey || null,
      sourceRefId: refId,
      label: srcDef.label,
      href: srcDef.build(refId),
      resolved: sourceResolved,
    },
    counts: { relatedTasks: relatedTasks.length, timeline: dedup.length },
  });
}
