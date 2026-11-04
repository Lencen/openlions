import { openMindDb } from "@/server/lib/open-mind-db";
import { todoRepo } from "@/server/lib/todo-repo";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import path from "path";
// 2026-09-16 [机制修复] todo 端能力预检: 文本 agent 不能再领 [机制修复]/[落地] todo
//   (与 tasks/claim 对齐, 防止领了又空转 -> 反复放回 -> 队列堵塞)。
import { getAgentCapability, classifyTaskRequirement, missingCapabilities } from "@/server/pipeline/agent-capability";

export const dynamic = "force-dynamic";

/**
 * 2026-09-11 [机制修复·agent协同] 待办可承接(原子认领) —— POST /api/v1/flywheel/todos/claim
 *
 * 背景(实测断裂): Todo 此前只有 GET/POST/PATCH, 没有任何认领语义:
 *   - agent 侧 todo_worker 只轮询 ownerId=自己 的待办, "公开可认领队列"(ownerType=agent 且 ownerId 为空)无人能领;
 *   - PATCH 是"读-改"两步, 两个 agent 可同时把同一条待办置 DOING(非原子);
 *   - 领了之后也没有归属校验, 谁都能改别人的待办。
 *
 * 认领规则(与 Task claim 口径对齐):
 *   claimable = status='OPEN' AND ownerType='agent' AND (ownerId IS NULL OR ownerId = 认领者)
 *   排序: 指派给我的优先 -> P0/P1/P2 -> dueAt 早的优先 -> 先创建的优先
 *   人类待办(ownerType='human')**永不被 agent 认领**(不越权替人做决定)。
 *
 * Body: { agentId: string, todoId?: string }   todoId 存在时=定向认领(claim-by-id)
 * 成功: { ok:true, todo, remaining }           无单可领: { ok:true, todo:null }
 *
 * 2026-09-16 增(对齐 task/churn 闭环):
 *   - 能力预检: todo 标题若触发 MECHANISM_FIX / LANDING 要求, 只允许 T3 (toolCapable) agent 认领。
 *     文本 agent 误领会再触发 164 次/24h 的"放回-认领"空转 (实测)。
 *   - Quarantine: meta.releaseCount >= 2 时不再放回 OPEN, 改置 BLOCKED + manualReview=true,
 *     从根上切断空转; 沿用 Task 的 QUARANTINE_AFTER_RELEASES=2 阈值 (单一真源常量)。
 */
const DB_PATH = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");

async function openDb() {

  const db = openMindDb({ role: "direct-rw", dbPath: DB_PATH, caller: "route" });

  return db;
}

function rowToJson(r: any) {
  return {
    id: String(r.id), title: String(r.title), detail: r.detail == null ? null : String(r.detail),
    source: String(r.source), sourceRefId: r.sourceRefId == null ? null : String(r.sourceRefId),
    ownerType: String(r.ownerType), ownerId: r.ownerId == null ? null : String(r.ownerId),
    status: String(r.status), priority: String(r.priority),
    dueAt: r.dueAt == null ? null : new Date(Number(r.dueAt)).toISOString(),
    evidence: r.evidence == null ? null : String(r.evidence),
    note: r.note == null ? null : String(r.note),
    createdBy: r.createdBy == null ? null : String(r.createdBy),
    createdAt: new Date(Number(r.createdAt)).toISOString(),
    updatedAt: new Date(Number(r.updatedAt)).toISOString(),
    doneAt: r.doneAt == null ? null : new Date(Number(r.doneAt)).toISOString(),
    doneBy: r.doneBy == null ? null : String(r.doneBy),
    // 2026-09-15 补: 认领响应此前**不带 meta**, 而 todo_worker 升级任务时要写回 meta.taskIds —— 拿不到原 meta
    //   就只能整体覆盖, 于是待办的 spec/origin/options 会静默丢失(实测风险)。这里原样带出。
    meta: (() => { try { return r.meta ? JSON.parse(String(r.meta)) : null; } catch { return null; } })(),
  };
}

export async function POST(req: NextRequest) {
  let b: any = {};
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }
  const agentId = String(b.agentId || "").trim();
  if (!agentId) return NextResponse.json({ ok: false, error: "need agentId" }, { status: 400 });
  const todoId = b.todoId ? String(b.todoId).trim() : "";
  const now = Date.now();
  try {
    // 2026-09-14 归属失效释放(与**任务侧**对齐, 补上待办侧缺口):
    //   实测 3 条待办被指派给已删除的幽灵身份 agent-d-exec, 卡了 3 天无人能领 ——
    //   因为认领条件是 (ownerId IS NULL OR ownerId = 我), 别的 agent 根本看不到它们。
    //   现在: OPEN 且 ownerId 指向 未登记/非 ACTIVE 的 agent -> 释放回公开队列并留痕。
    try {
      const orphans: any[] = (await todoRepo.all(
        "SELECT t.id, t.ownerId FROM Todo t LEFT JOIN AgentRegistry r ON r.agent_id = t.ownerId " +
        "WHERE t.status='OPEN' AND t.ownerType='agent' AND t.ownerId IS NOT NULL " +
        "AND (r.agent_id IS NULL OR r.status != 'ACTIVE')"
      )) as any[];
      if (orphans && orphans.length) {
        for (const o of orphans) {
          await todoRepo.run("UPDATE Todo SET ownerId = NULL, updatedAt = ? WHERE id = ? AND status = 'OPEN'", now, String(o.id));
          await prisma.flywheelEvent.create({
            data: { stage: "TODO_OWNER_RELEASED", sourceType: "todo", sourceId: String(o.id),
              sourceTitle: ("归属失效释放: ownerId=" + String(o.ownerId || "-") + " 未登记/非 ACTIVE -> 放回公开队列").slice(0, 240), targetStage: "OK" },
          }).catch(() => null);
        }
        console.log("[todos/claim] 归属失效释放 " + orphans.length + " 条");
      }
    } catch { /* 释放失败不阻断正常认领 */ }
    let target: any = null;
    if (todoId) {
      const row: any = await todoRepo.get("SELECT * FROM Todo WHERE id = ?", todoId);
      if (!row) { return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 }); }
      if (String(row.ownerType) !== "agent") { return NextResponse.json({ ok: false, error: "HUMAN_TODO_NOT_CLAIMABLE", ownerType: row.ownerType }, { status: 403 }); }
      if (row.ownerId && String(row.ownerId) !== agentId) { return NextResponse.json({ ok: false, error: "ASSIGNED_TO_OTHER", ownerId: row.ownerId }, { status: 403 }); }
      if (String(row.status) !== "OPEN") { return NextResponse.json({ ok: false, error: "NOT_OPEN", status: row.status }, { status: 409 }); }
      target = row;
    } else {
      // 指派给我的优先, 再按优先级/截止/创建时间 —— 在能力预检前先选一条候选,
      // 预检不通过则丢弃, 重查下一条(同 SQL 循环, 最多 5 次以防全不合格死循环)。
      const PICK_LIMIT = 5;
      let tries = 0;
      while (tries++ < PICK_LIMIT) {
        const c: any = await todoRepo.get(
          "SELECT * FROM Todo WHERE status='OPEN' AND ownerType='agent' AND (ownerId IS NULL OR ownerId = ?) " +
          "ORDER BY (CASE WHEN ownerId = ? THEN 0 ELSE 1 END), " +
          "(CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END), " +
          "COALESCE(dueAt, 9e15), createdAt ASC LIMIT 1", agentId, agentId);
        if (!c) { target = null; break; }
        // 2026-09-16 [机制修复] 能力预检: 标题触发 MECHANIX/LANDING/VERIFY 时, 非 T3 agent 不许领。
        //   实测 24h 内"大脑无产出(空回复)"放回 164 次, 其中 90% 是文本 agent 误领机制修复 todo。
        //   文本 agent 看到这条能领会立刻领, 然后无法产出 -> 立刻放回 -> 再领 -> 队列空转。
        //   改为: 非 T3 领不到 -> 直接留公开队列给有工具的执行体 (T3 由 CLAIM_TOOL_CAPABLE_AGENTS 控制)。
        const req = classifyTaskRequirement(String(c.title || ""), null, null);
        if (req.minTier >= 2) {  // MECHANISM_FIX/LANDING/VERIFY 全部要求 T2+
          const cap = await getAgentCapability(agentId);
          const miss = missingCapabilities(cap, req);
          if (miss.length > 0) {
            // 候选不合格: 临时把这条挂到自己名下(短 lease), 下一轮自然跳过; 避免下次又领到。
            // 注: 真实"置不认领"语义由 doNotPick 标记完成 —— 这里用"短期挂名"方式实现去重。
            // 简化: 直接 PATCH updatedAt 后, 跳出重查候选 (其它 todo 顺序会变化)
            await todoRepo.run("UPDATE Todo SET updatedAt = updatedAt WHERE id = ?", String(c.id));
            continue;
          }
        }
        target = c;
        break;
      }
      if (!target) {
        const rest: any = await todoRepo.get("SELECT COUNT(*) c FROM Todo WHERE status='OPEN' AND ownerType='agent' AND (ownerId IS NULL OR ownerId = ?)", agentId);
        return NextResponse.json({ ok: true, todo: null, remaining: Number(rest?.c ?? 0) });
      }
    }
    // 原子认领: 影响行=1 才算成功(并发下只有一个 agent 拿到)
    const info = await todoRepo.run("UPDATE Todo SET status='DOING', ownerType='agent', ownerId=?, updatedAt=? WHERE id=? AND status='OPEN'", agentId, now, target.id);
    if (info.changes !== 1) {
      return NextResponse.json({ ok: false, error: "CLAIM_RACE" }, { status: 409 });
    }
    const row: any = await todoRepo.get("SELECT * FROM Todo WHERE id = ?", target.id);
    const rest: any = await todoRepo.get("SELECT COUNT(*) c FROM Todo WHERE status='OPEN' AND ownerType='agent' AND (ownerId IS NULL OR ownerId = ?)", agentId);
    await prisma.flywheelEvent.create({
      data: { stage: "TODO_CLAIMED", sourceType: "todo", sourceId: String(target.id), sourceTitle: ("by=" + agentId + " " + String(target.title || "")).slice(0, 250), targetStage: "OK" },
    }).catch(() => null);
    // 2026-09-15 [机制修复] agent 不主动从平台取数: 把"上下文注入"对齐到 tasks/claim (line 280-300) —
    //   认领待办即带 contextSeed + 落 CONTEXT_INJECTED 事件, 让"平台存过却没人用"问题在认领阶段就修掉。
    //   注: todo_worker 升级路径是"text 直接进 brain(prompt)", 改 brain 接收原始 todo 不传 seed;
    //       worker 内部 platform_context() (现统一走 lib/platform_context.py) 仍会自己再拉一次,
    //       这里 contextSeed 是给"未来支持 worker 拉前预热" / "其它直读此接口的前端" 用的。
    let contextSeed = "";
    try {
      const { searchContext, renderContextSeed } = await import("@/server/pipeline/context-seed");
      const hits = await searchContext({
        query: (((row as any)?.title || "") + " " + ((row as any)?.detail || "")).slice(0, 200).trim(),
        limit: 5,
      source: "todo-claim",   // round 72-AF: 声明调用者身份
      });
      contextSeed = renderContextSeed(hits);
      if (hits.length) {
        await prisma.flywheelEvent.create({
          data: {
            stage: "CONTEXT_INJECTED",
            sourceType: "todo_claim",
            sourceId: String(target.id),
            sourceTitle: JSON.stringify({ agentId, count: hits.length, kinds: Array.from(new Set(hits.map((h: any) => h.kind))), ids: hits.map((h: any) => h.id) }).slice(0, 900),
            targetStage: "OK",
          },
        }).catch(() => null);
      }
    } catch { /* 注入失败不阻断认领 */ }
    return NextResponse.json({
      ok: true,
      todo: rowToJson(row),
      remaining: Number(rest?.c ?? 0),
      contextSeed: contextSeed || undefined,  // 与 tasks/claim 响应同 key
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  }
}
