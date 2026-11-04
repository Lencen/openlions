import { NextResponse } from "next/server";
import { IMPROVEMENT_TYPES, TASK_SCOPES, scopeDef, scopeOfType } from "@/config/taskScopes";
import { openMind, q, resolveRange, safeClose, asOf } from "@/lib/server/lions-db";

// 2026-09-09 看板: 列表(状态/类型/主题过滤 + 全局计数) 或 ?detail=<taskId> 单条详情(结构化+执行链+产物流向)
// 2026-09-10 任务语义分层: 新增 ?scope=ALL|MECHANISM|VERIFY|DISCUSSION|OTHER
//   scope = 一组 improvementType 的并集 (mind 侧 API 只支持单类型, 这里按 scope 逐个拉取后合并),
//   返回还带 scopeCounts (按全局 counts.byType 归并), 供列表页显示每个 scope 的任务数。
const MIND_API = "http://localhost:3000/api/v1/flywheel/improving-tasks";

async function fetchTasks(params: URLSearchParams) {
  try {
    const res = await fetch(MIND_API + "?" + params.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function shapeItem(t: any) {
  const type = t?.improvementType ?? t?.type ?? "";
  return {
    id: t?.id,
    title: t?.title,
    type: type || "UNKNOWN",
    scope: scopeOfType(type),
    status: t?.status,
    description: t?.description,
    theme: t?.theme ?? null,
    priority: t?.priority ?? null,
    completedBy: t?.completedBy ?? null,
    assignedAgent: t?.assignedAgent ?? null, // 2026-09-15: 列表要能看出"这个任务是哪个执行体做的"
    createdAt: t?.createdAt ?? t?.startedAt ?? null,
    updatedAt: t?.updatedAt ?? null,
    completedAt: t?.completedAt ?? null,
  };
}

function tsOf(v: any): number {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  const d = new Date(v).getTime();
  return Number.isFinite(d) ? d : 0;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const detailId = url.searchParams.get("detail");
  if (detailId) {
    const dr = await fetch(MIND_API + "/" + encodeURIComponent(detailId), { cache: "no-store" });
    if (!dr.ok) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const dd = await dr.json();
    // 2026-09-21: 反向关联的来源待办(含完整 detail) —— 任务详情页内联显示"由哪个待办升级而来/关联了哪些待办"
    //   (task.sourceTaskId 为空, 待办→任务链接存在 Todo.meta.taskIds / Todo.sourceRefId, 反查)
    let sourceTodos: any[] = [];
    try {
      const mind = openMind();
      if (mind) {
        sourceTodos = ((await q(
          mind,
          "SELECT id, title, status, priority, ownerType, ownerId, source, sourceRefId, createdAt, updatedAt, doneAt, doneBy, detail, meta " +
          "FROM Todo WHERE sourceRefId = ? OR meta LIKE ? " +
          "ORDER BY (CASE WHEN status IN ('DONE','DROPPED') THEN 1 ELSE 0 END), createdAt DESC LIMIT 20",
          detailId, "%" + detailId + "%"
        )) || []).map((t: any) => {
          let metaObj: any = null;
          try { metaObj = t.meta ? JSON.parse(String(t.meta)) : null; } catch { metaObj = null; }
          return { ...t, meta: metaObj, taskIds: Array.isArray(metaObj?.taskIds) ? metaObj.taskIds : [] };
        });
        safeClose(mind);
      }
    } catch { sourceTodos = []; }
    return NextResponse.json({ success: true, ...dd, sourceTodos });
  }

  const status = url.searchParams.get("status") || "ALL";
  const type = url.searchParams.get("type") || "";
  const scopeKey = url.searchParams.get("scope") || "ALL";
  const theme = url.searchParams.get("theme") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 500);
  const scope = scopeDef(scopeKey);

  // 具体类型优先于 scope; 否则用 scope 的类型集合 (ALL → 无类型过滤)
  const types: string[] = type ? [type] : scope.types;
  const base = new URLSearchParams({ status, limit: String(limit) });
  if (theme) base.set("theme", theme);

  let items: any[] = [];
  let counts: any = { byStatus: {}, byType: {}, total: 0 };
  let byType: Record<string, number> = {};
  let ok = true;

  if (types.length === 0) {
    const data = await fetchTasks(base);
    if (!data) ok = false;
    items = (data?.tasks ?? []).map(shapeItem);
    counts = data?.counts ?? counts;
    byType = data?.byType ?? {};
  } else {
    // 多类型并集: 逐个拉取 (每个类型上限 = limit), 合并去重后按更新时间排序截断
    const results = await Promise.all(
      types.map((t) => {
        const p = new URLSearchParams(base);
        p.set("improvementType", t);
        return fetchTasks(p);
      })
    );
    const seen = new Set<string>();
    for (const data of results) {
      if (!data) { ok = false; continue; }
      counts = data?.counts ?? counts;
      byType = { ...byType, ...(data?.byType ?? {}) };
      for (const t of data?.tasks ?? []) {
        const item = shapeItem(t);
        if (!item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    items.sort((a, b) => tsOf(b.updatedAt ?? b.createdAt) - tsOf(a.updatedAt ?? a.createdAt));
    items = items.slice(0, limit);
  }

  // 2026-10-13 round 76-BG: 接入全局时间范围(用户决策③「把 range 接进其余页面」)。
  //   mind 的 improving-tasks **不支持 range**(实测 range=1h 与 all 响应字节数相同), 故在**列表侧**按时间窗过滤
  //   (取 updatedAt ?? createdAt)。range=all -> since=0 -> 不过滤(保持原行为)。
  const r = resolveRange(url.searchParams.get("range"));
  // 2026-10-13 round 76-BK(用户把队列语义交给我定): **业务场景决定** ——
  //   /flywheel/tasks 是**工作队列**(待做/进行中/失败), 时间范围只应作用于**终态(已完成)**的历史;
  //   未完成/失败的任务**永远保留**, 否则顶栏默认 24h 会让"待办"看起来凭空消失(= 丢活)。
  //   /flywheel/executions 走 status=DONE, 全是终态 -> 等价于"按时间范围看执行记录", 语义正确。
  const TERMINAL = new Set(["DONE", "DROPPED", "CANCELLED", "ARCHIVED"]);
  if (r.since > 0) {
    items = items.filter((it) => {
      const st = String(it.status || "").toUpperCase();
      if (!TERMINAL.has(st)) return true;
      return tsOf(it.updatedAt ?? it.createdAt) >= r.since;
    });
    items = items.slice(0, limit);
  }

  // scope 计数: 用全局 counts.byType 归并
  // (注意: mind 返回的 byType 只统计"本次列表", 全库计数在 counts.byType, 两者不能混用)
  const globalByType: Record<string, any> = counts?.byType ?? {};
  const scopeCounts: Record<string, { key: string; label: string; color: string; count: number; desc: string }> = {};
  for (const s of TASK_SCOPES) {
    const count = s.types.length === 0
      ? Object.values(globalByType).reduce((a: number, b: any) => a + Number(b || 0), 0)
      : s.types.reduce((a, t) => a + Number(globalByType[t] || 0), 0);
    scopeCounts[s.key] = { key: s.key, label: s.label, color: s.color, count, desc: s.desc };
  }

  // 2026-10-16 round 77-AD（决策③逐源 + 77-M 机检清单）:
  //   /flywheel/executions 有 2 个源（本接口的任务列表 + /api/flywheel-stats 的 KPI）, 而该页**没有**时刻 ✗。
  //   本接口原先无时刻字段, 这里补**顶层** asOf; 纯增量(3 个消费者都读 success/items/scopeCounts 等)。
  const payload = {
    success: ok,
    scope: scope.key,
    scopeTypes: scope.types,
    scopeCounts,
    improvementTypes: IMPROVEMENT_TYPES,
    range: r.key,
    total: items.length,
    counts,
    items,
    byType,
  };
  return NextResponse.json({ ...payload, asOf: asOf() });
}
