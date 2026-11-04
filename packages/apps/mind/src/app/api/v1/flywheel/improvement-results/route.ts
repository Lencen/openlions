import { openMindDb } from "@/server/lib/open-mind-db";
import { todoRepo } from "@/server/lib/todo-repo";
import { runtimeRepo } from "@/server/lib/runtime-repo";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { rangeFromRequest } from "@/lib/range";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/flywheel/improvement-results?source=agent-x-feedback&limit=100
 *
 * 2026-09-24 [可见性缺口] todo_bdce470195d94307abff 缺口 A:
 *   此前没有任何地方能回答「某次反馈/某个来源的需求, 改进到什么程度」—— 只能一条条翻
 *   待办 -> 任务 -> TaskExecution -> 验收 ledger(跨 4 张表)。本接口按 Todo.source 聚合:
 *     Todo(状态) -> meta.taskIds -> Task(状态) + AcceptanceVerdict(验收结论)
 *
 * 口径(与 scripts/acceptance/lib/verdict-writeback.cjs 的 sourceView 完全一致, 单一事实源):
 *   overallState: 有升级任务 -> 任一 FAIL=FAIL / 全 PASS=PASS / 否则 PENDING;
 *                 无升级任务 -> 用待办自身验收判定; 全无 -> PENDING。
 *   ★ "DONE 不等于验收通过": todoStatus 与 overallState 分开返回, 前端必须并列展示。
 *
 * 只读: 不改任何表(台账由 scripts/acceptance/runner.cjs 写)。
 */
const DB_PATH = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");

function acceptanceJson(a: any) {
  if (!a) return { state: "PENDING", verdict: null, specType: null, checkedAt: null, fails: [] };
  let fails: any[] = []; try { fails = JSON.parse(String(a.failsJson || "[]")); } catch { fails = []; }
  return {
    state: a.verdict === "PASS" ? "PASS" : "FAIL",
    verdict: String(a.verdict), specType: a.specType == null ? null : String(a.specType),
    checkedAt: a.checkedAt == null ? null : new Date(Number(a.checkedAt)).toISOString(),
    fails: Array.isArray(fails) ? fails : [],
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const source = String(url.searchParams.get("source") || "").trim();
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  let db: any = null;
  try {

    db = openMindDb({ role: "readonly", dbPath: DB_PATH, caller: "route" });

    // 2026-10-13 round 76-CC: **opt-in** 时间窗(③) —— 只有显式传 ?range= 才按 Todo.createdAt 过滤。
    const rf = rangeFromRequest(req);
    const since = rf && rf.since > 0 ? rf.since : 0;
    let todos: any[];
    if (source && since) todos = await todoRepo.all("SELECT * FROM Todo WHERE source = ? AND createdAt >= ? ORDER BY createdAt DESC LIMIT ?", source, since, limit);
    else if (source) todos = await todoRepo.all("SELECT * FROM Todo WHERE source = ? ORDER BY createdAt DESC LIMIT ?", source, limit);
    else if (since) todos = await todoRepo.all("SELECT * FROM Todo WHERE createdAt >= ? ORDER BY createdAt DESC LIMIT ?", since, limit);
    else todos = await todoRepo.all("SELECT * FROM Todo ORDER BY createdAt DESC LIMIT ?", limit);

    const taskIdsAll: string[] = [];
    const rowTaskIds = new Map<string, string[]>();
    const todoMeta = new Map<string, any>();
    for (const t of todos) {
      let m: any = {}; try { m = t.meta ? JSON.parse(String(t.meta)) : {}; } catch { m = {}; }
      todoMeta.set(String(t.id), m);
      const ids = (Array.isArray(m?.taskIds) ? m.taskIds : []).map(String);
      rowTaskIds.set(String(t.id), ids);
      for (const id of ids) taskIdsAll.push(id);
    }
    const verdictRows = async (entityType: string, ids: string[]) => {
      const m = new Map<string, any>();
      if (!ids.length) return m;
      try {
        const ph = ids.map(() => "?").join(",");
        const rs = (await runtimeRepo.all("SELECT * FROM AcceptanceVerdict WHERE entityType=? AND entityId IN (" + ph + ")", entityType, ...ids)) as any[];
        for (const r of rs) m.set(String(r.entityId), r);
      } catch { /* 台账不存在 -> PENDING */ }
      return m;
    };
    const todoAcc = await verdictRows("Todo", todos.map((t) => String(t.id)));
    const taskAcc = await verdictRows("Task", taskIdsAll);

    const items = todos.map((t) => {
      const ids = rowTaskIds.get(String(t.id)) || [];
      let tasks: any[] = [];
      if (ids.length) {
        const ph = ids.map(() => "?").join(",");
        const rs = db.prepare("SELECT id,title,status,improvementType FROM Task WHERE id IN (" + ph + ")").all(...ids) as any[];
        tasks = rs.map((r) => ({ id: String(r.id), title: r.title, status: r.status, improvementType: r.improvementType,
          acceptance: acceptanceJson(taskAcc.get(String(r.id))) }));
      }
      const own = acceptanceJson(todoAcc.get(String(t.id)));
      let overallState: string;
      if (tasks.length) {
        if (tasks.some((x) => x.acceptance.state === "FAIL")) overallState = "FAIL";
        else if (tasks.every((x) => x.acceptance.state === "PASS")) overallState = "PASS";
        else overallState = "PENDING";
      } else overallState = own.state;
      return {
        todoId: String(t.id), todoTitle: t.title, todoStatus: t.status, source: t.source,
        taskIds: ids, tasks, acceptance: own, overallState,
        // 证据锚点: 便于用户/复核者按 id 直接复算, 不用再去猜查哪张表
        evidenceAnchors: [
          "sql: SELECT * FROM Todo WHERE id='" + t.id + "'",
          ...ids.map((id) => "sql: SELECT * FROM AcceptanceVerdict WHERE entityType='Task' AND entityId='" + id + "'"),
        ],
      };
    });
    const summary = {
      PASS: items.filter((i) => i.overallState === "PASS").length,
      FAIL: items.filter((i) => i.overallState === "FAIL").length,
      PENDING: items.filter((i) => i.overallState === "PENDING").length,
    };
    return NextResponse.json({ ok: true, source: source || "(all)", count: items.length, summary, items, asOf: new Date().toISOString(), ...(rf ? { range: rf.key, rangeLabel: rf.label } : {}) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  } finally {
    try { db?.close(); } catch { /* 忽略 */ }
  }
}
