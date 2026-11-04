import { openMindDb } from "@/server/lib/open-mind-db";
import { todoRepo } from "@/server/lib/todo-repo";
import { runtimeRepo } from "@/server/lib/runtime-repo";
import { NextRequest, NextResponse } from "next/server";
import { resolveActor } from "@/server/pipeline/actor";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";
import path from "path";

export const dynamic = "force-dynamic";

/**
 * 2026-09-10 通用"讨论/沟通"模块 (用户需求: 任务详情独立页 + 所有详情页挂 AI 沟通记录)
 *   GET  /api/v1/flywheel/discussions?entityType=task&entityId=<id>
 *        -> { rows: 人工/agent 发言, timeline: 平台自动合成的协作时间线 }
 *   POST /api/v1/flywheel/discussions { entityType, entityId, body, authorType?, authorId?, askAgentId? }
 *        askAgentId -> 生成可被该 agent 认领的提问任务(GOAL_GAP + improvementPayload.kind=DISCUSSION_QUESTION),
 *        agent 提交时由 submit 路由把回答回写本讨论串。
 *   entityType: task | memory | knowledge | skill | practice | reflection | finding | agent | session
 *
 * 实现说明: Discussion 表用 better-sqlite3 直连 mind dev.db (与 console 口径一致)。
 *   Prisma $queryRawUnsafe 读这张运行期自建表会报 "Raw query failed. Code: N/A"(实测), 同一连接 INSERT 却正常,
 *   因此讨论表走 better-sqlite3; prisma 继续负责 Task / FlywheelEvent 等模型表。
 */
const TABLE = "Discussion";
const DB_PATH = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");

async function openDb() {

  const db = openMindDb({ role: "direct-rw", dbPath: DB_PATH, caller: "route" });

  db.exec(
    "CREATE TABLE IF NOT EXISTS " + TABLE + " (" +
      "id TEXT PRIMARY KEY, entityType TEXT NOT NULL, entityId TEXT NOT NULL, " +
      "authorType TEXT NOT NULL, authorId TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, " +
      "replyToId TEXT, taskId TEXT, meta TEXT, createdAt INTEGER NOT NULL)"
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_discussion_entity ON " + TABLE + "(entityType, entityId, createdAt)");
  return db;
}

/** 平台自动时间线: 谁在什么时候对这个实体做了什么 -> 可读对话 */
async function buildTimeline(entityType: string, entityId: string) {
  const out: Array<{ at: string; actor: string; kind: string; text: string; ref?: string }> = [];
  try {
    if (entityType === "task") {
      const t: any = await prisma.task.findUnique({ where: { id: entityId } });
      if (!t) return out;
      out.push({ at: new Date(t.createdAt).toISOString(), actor: "platform", kind: "publish", text: "[平台发布] " + (t.title || ""), ref: t.id });
      const trs = await prisma.taskStateTransition.findMany({ where: { taskId: entityId }, orderBy: { createdAt: "asc" }, take: 40 });
      for (const tr of trs) out.push({ at: new Date(tr.createdAt).toISOString(), actor: tr.actor || "unknown", kind: "transition", text: "[" + tr.fromStatus + " -> " + tr.toStatus + "] " + (tr.reason || ""), ref: tr.id });
      const exs = await prisma.taskExecution.findMany({ where: { taskId: entityId }, orderBy: { createdAt: "asc" }, take: 20 });
      for (const ex of exs) out.push({ at: new Date(ex.createdAt).toISOString(), actor: ex.agentId || "agent", kind: "submit", text: String(ex.output || "").slice(0, 4000), ref: ex.id });
    } else {
      const evs: any[] = await prisma.flywheelEvent.findMany({ where: { sourceId: entityId }, orderBy: { createdAt: "asc" }, take: 40 }).catch(() => [] as any[]);
      for (const ev of evs) out.push({ at: new Date(ev.createdAt).toISOString(), actor: "platform", kind: ev.stage, text: "[" + ev.stage + "] " + (ev.sourceTitle || ""), ref: ev.id });
    }
  } catch { /* 时间线是增强能力, 失败不影响讨论列表 */ }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const entityType = (url.searchParams.get("entityType") || "task").trim();
  const entityId = (url.searchParams.get("entityId") || "").trim();
  const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  if (!entityId) return NextResponse.json({ ok: false, error: "need entityId" }, { status: 400 });
  let rows: any[] = [];
  try {
    rows = (await runtimeRepo.all("SELECT * FROM " + TABLE + " WHERE entityType = ? AND entityId = ? ORDER BY createdAt ASC LIMIT ?", entityType, entityId, limit)) as any[];
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "rows: " + (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  }
  const timeline = await buildTimeline(entityType, entityId);
  const safe = rows.map((r) => ({
    id: String(r.id), entityType: String(r.entityType), entityId: String(r.entityId),
    authorType: String(r.authorType), authorId: r.authorId == null ? null : String(r.authorId),
    kind: String(r.kind), body: String(r.body), taskId: r.taskId == null ? null : String(r.taskId),
    createdAt: new Date(Number(r.createdAt)).toISOString(),
  }));
  return NextResponse.json({ ok: true, entityType, entityId, count: safe.length, rows: safe, timeline, asOf: new Date().toISOString() });
}

export async function POST(req: NextRequest) {
  let b: any = {};
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }
  const entityType = String(b.entityType || "task").trim();
  const entityId = String(b.entityId || "").trim();
  const body = String(b.body || "").trim();
  const authorType = String(b.authorType || "unknown").trim();
  const authorId = b.authorId ? String(b.authorId) : (authorType === "human" ? "human:operator" : null);
  // 2026-09-14 用户反馈: "在任务讨论里 @ 了 agent, 这个渠道 agent 能收到并回复吗?"
  //   实测答案: **收不到** —— 只有走界面上的 agent 选择器(askAgentId)才会生成"可认领提问任务",
  //   agent 提交后由 submit 路由把回答回写本讨论串; 正文里写 @agent-x 原本只是纯文本, 没有任何投递。
  //   现在补齐: 正文里出现 @<已注册且 ACTIVE 的 agent id> 即**等同于**选择器向它提问(同一投递路径,
  //   因此同样能收到回答并回写)。提及了不存在/未启用的 id 时明确回报, 不静默忽略。
  let askAgentId = b.askAgentId ? String(b.askAgentId).trim() : null;
  let mentionAutoDetected = false;
  let mentionIgnored = "";
  if (!askAgentId) {
    const m = body.match(/@((?:agent-)[a-z0-9][a-z0-9_-]*)/i);
    if (m) {
      const cand = m[1].toLowerCase();
      const reg = await prisma.agentRegistry.findFirst({ where: { agent_id: cand }, select: { status: true } }).catch(() => null);
      if (reg && String(reg.status) === "ACTIVE") { askAgentId = cand; mentionAutoDetected = true; }
      else mentionIgnored = cand;
    }
  }
  if (!entityId || !body) return NextResponse.json({ ok: false, error: "need entityId + body" }, { status: 400 });
  // 讨论记录 id 提前生成(2026-09-14 迁移: 提问改由**待办**承载, 待办的 meta/sourceRefId 要引用它)
  const id = "dsc_" + randomUUID().replace(/-/g, "").slice(0, 20);

  let taskId: string | null = null;
  if (askAgentId) {
    try {
      // 2026-09-14 修两处实测缺陷(用户反馈):
      //  A. **抢答**: 提问任务原先没有 assignedAgent -> 落进公开队列, 谁先轮询谁答。实测用户在"@agent 提问"里
      //     选了 agent-d, 37 秒后**agent-e 抢答**。现在指派给被问的人(认领接口只允许指派对象领走)。
      //  B. **答非所问**: 材料里只有 entityType/entityId, **没有任何对象上下文**; 文本通道又拿不到数据,
      //     于是它只能回"必查接口: GET /api/... 拿标题/描述", 也就是让提问人自己去查。现在把上下文打包进任务。
      const { buildEntityContext } = await import("@/server/pipeline/discussion-context");
      const ctx = await buildEntityContext(entityType, entityId);
      // 2026-09-14 **定位迁移(阶段4)**: 用户两次明确"只要不是飞轮中发现的都不是改进任务" ——
      //   讨论提问来自**人的沟通**, 因此由**待办**承载(原先是改进任务)。
      //   待办的好处: 进需求池、可指派给被问的人(ownerId=askAgentId, 别人抢不走)、
      //   回答由 /todos/submit 回写讨论串(见该路由的 DISCUSSION_QUESTION 分支)。
      {
        const todoId = "todo_dsc_" + randomUUID().replace(/-/g, "").slice(0, 12);
        const detailText = [
          "【针对对象的 AI 沟通】实体类型 " + entityType + " / 实体 id " + entityId,
          "【提问】" + body,
          "【要求】直接回答问题本身 —— 上下文已随本条下发, **不要再让提问人去查接口**。"
            + "若确实还缺关键信息, 明确写出'缺哪一项、为什么它必须由人提供', 并给出你能给的判断。"
            + "若问题是要人在选项间做选择, 请把选项讲清楚(每个选项的后果/成本/风险)。",
          ctx.text,
        ].filter(Boolean).join("\n").slice(0, 6000);
        // 2026-10-23 P1: Todo 写走 todo-repo（sqlite/dual/pg 三模式）
        await todoRepo.run(
          "INSERT INTO Todo (id,title,detail,source,sourceRefId,ownerType,ownerId,status,priority,evidence,note,createdBy,createdAt,updatedAt,meta) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          todoId,
          ("[讨论提问·" + entityType + "] " + body).slice(0, 300),
          detailText,
          "discussion:question", id, "agent", askAgentId, "OPEN", "P2",
          null, null, String(authorId || authorType || "human"), Date.now(), Date.now(),
          JSON.stringify({ kind: "DISCUSSION_QUESTION", entityType, entityId, discussionId: id, askAgentId, contextFacts: ctx.facts,
                           askedBy: authorId || authorType || null, needsTools: false })
        );
        taskId = todoId;
      }
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: "todo create: " + (e?.message || String(e)).slice(0, 300) }, { status: 500 });
    }
  }

  try {
    await runtimeRepo.run("INSERT INTO " + TABLE + " (id, entityType, entityId, authorType, authorId, kind, body, replyToId, taskId, meta, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      id, entityType, entityId, authorType, authorId, askAgentId ? "question" : "comment", body, null, taskId, JSON.stringify({ askAgentId: askAgentId || null }), Date.now());
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "insert: " + (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  }
  // 2026-09-11: 人类发言同样要求显式声明 x-actor-kind: human(否则程序化调用可自称人类拉低自主率)
  // 2026-09-14: 避免**双重前缀** —— 调用方可能已经传了 "human:xxx"(console 代理的旧默认值),
  //   再拼一次就会得到 "human:human:xxx"(实测讨论区作者名显示成这样)。已带前缀则原样使用。
  const rawActor = String(authorId || "unknown");
  const alreadyPrefixed = /^(human|agent|platform|system):/i.test(rawActor);
  const actor = resolveActor(
    req,
    alreadyPrefixed ? rawActor : (authorType === "human" ? "human:" + rawActor : "agent:" + rawActor)
  );
  if (authorType === "human" && actor.isHuman) {
    await prisma.flywheelEvent.create({ data: { stage: "HUMAN_INTERVENTION", sourceType: "discussion", sourceId: entityId, sourceTitle: ("human comment on " + entityType + ": " + body.slice(0, 120)).slice(0, 250), targetStage: "OK" } }).catch(() => null);
  } else if (authorType === "human" && actor.mislabeled) {
    await prisma.flywheelEvent.create({ data: { stage: "ACTOR_MISLABELED", sourceType: "discussion", sourceId: entityId, sourceTitle: ("自称人类但未声明 x-actor-kind: human -> 不计干预: " + String(authorId || "-")).slice(0, 240), targetStage: "OK" } }).catch(() => null);
  }
  return NextResponse.json({
    ok: true, id, taskId, entityType, entityId, asked: askAgentId,
    mentionAutoDetected,
    mentionIgnored: mentionIgnored || undefined,
    note: askAgentId
      ? "已向 " + askAgentId + " 提问: 平台已生成了指派给它的**待办**(不是改进任务), 它回答后会自动回写本讨论串" + (mentionAutoDetected ? "(由正文中的 @ 提及识别)" : "")
      : (mentionIgnored ? "正文里 @ 的 '" + mentionIgnored + "' 不是已注册且 ACTIVE 的 agent, 未投递" : "仅记录发言(未指定 agent, 不会投递给任何 agent)"),
  });
}

