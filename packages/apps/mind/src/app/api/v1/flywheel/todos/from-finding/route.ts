import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseFinding, planFindingTodo, createTodoFromFinding, REQUIRED_FINDING_FIELDS } from "@/server/pipeline/agent-finding";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/flywheel/todos/from-finding
 *   一线 agent 巡检发现 -> 结构化待办 的**唯一入口**。
 *
 * 为什么存在(待办 todo_0d03a211800248b29143): agent 的巡检发现此前只能作为对话消息发给某个 agent,
 *   要变成平台待办只能靠 leader 人肉转写(2026-09-14 一次转写 4 条)。这是"平台靠人转"的残留。
 *
 * Body(四要素必填, 缺一即 400):
 *   { symptom: "现象", evidence: "证据", suggestedAction: "建议动作", sourceAgent: "agent-i",
 *     needsTools?: true|false,   // 显式优先; 不传则由平台按关键词推断并写入 meta.needsTools
 *     needsHuman?: true,         // 需人类决策(授权/采购/签字) -> 不进 agent 可领队列
 *     priority?: "P0"|"P1"|"P2", title?, detail?, sourceRefId?, dedupKey?, dryRun? }
 *
 * 平台行为:
 *   1. 校验四要素 -> 400 MISSING_FINDING_FIELDS(附字段名), 不写半截数据;
 *   2. 解析 needsTools(显式优先, 否则关键词推断), 写进 meta.needsTools —— 这是升级通道的权威标记:
 *      todo_worker 认领后按它决定"直接给结论"还是"升级为任务交给执行体";
 *   3. 落一条待办: source="agent:<agent> 巡检反馈", createdBy="agent:<agent>",
 *      ownerType=agent(公开可领) / human(needsHuman), status=OPEN;
 *   4. 幂等: 同 agent 同现象+建议动作, 在办(OPEN/DOING/BLOCKED)时复用旧待办, 不重复刷屏。
 *
 * 返回: { ok, todoId, deduped, needsTools, needsHuman, ownerType, source, todo }
 * GET: 自描述(字段名/示例), 便于 agent 首次接入时自发现契约。
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "POST /api/v1/flywheel/todos/from-finding",
    purpose: "agent 巡检发现 -> 结构化待办(平台按 needsTools 走升级通道)",
    required: REQUIRED_FINDING_FIELDS.map((f) => ({ field: f.key, label: f.label, alias: f.alias ?? null })),
    optional: ["needsTools", "needsHuman", "priority", "title", "detail", "sourceRefId", "dedupKey", "dryRun", "meta"],
    example: {
      symptom: "探针把服务变慢误报成 offline(console 30s 仍返回 200)",
      evidence: "11 次采样 3004: 0.69~30.66s 全部 200; GET /api/portal/daily-report 却标 offline",
      suggestedAction: "健康判定把超时与离线分开: 超时 > N 秒记 degraded, 只有连接失败才记 offline",
      sourceAgent: "agent-i",
      needsTools: true,
      priority: "P1",
    },
    seeAlso: "docs/platform-logic/agent-finding-to-todo-entry-2026-09-15.md",
  });
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }

  const parsed = parseFinding(body);
  if (!parsed.ok) {
    return NextResponse.json({
      ok: false,
      error: "MISSING_FINDING_FIELDS",
      missing: parsed.missing,
      required: REQUIRED_FINDING_FIELDS.map((f) => f.label),
      howto: "四要素(现象/证据/建议动作/来源 agent)缺一不可: 没有证据的发现不是发现, 没有建议动作的待办无法被承接。",
      contract: "GET 本接口返回完整字段说明与示例。",
    }, { status: 400 });
  }
  const finding = parsed.finding;
  const plan = planFindingTodo(finding);

  if (body.dryRun === true) {
    return NextResponse.json({
      ok: true, dryRun: true, deduped: false,
      wouldCreate: {
        title: plan.title, source: plan.source, ownerType: plan.ownerType, ownerId: plan.ownerId,
        priority: plan.priority, needsTools: plan.needsTools, needsHuman: plan.needsHuman,
        meta: plan.meta,
      },
      routing: plan.needsHuman
        ? "human 待办(不进 agent 队列): 由人类决策后触发落地"
        : (plan.needsTools
          ? "agent 公开队列; todo_worker 认领后按 meta.needsTools=true 升级为任务(带 fromTodo)交给执行体"
          : "agent 公开队列; 由文本通道 agent 认领后直接给结论"),
    });
  }

  const res = await createTodoFromFinding(finding);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 500 });
  }
  if (!res.deduped) {
    await prisma.flywheelEvent.create({
      data: {
        stage: "AGENT_FINDING_TODO_CREATED",
        sourceType: res.source,
        sourceId: res.todoId,
        sourceTitle: ("by=" + finding.sourceAgent + " needsTools=" + res.needsTools + " " + plan.title).slice(0, 250),
        targetStage: "OK",
      },
    }).catch(() => null);
  }
  return NextResponse.json({
    ok: true,
    todoId: res.todoId,
    deduped: res.deduped,
    needsTools: res.needsTools,
    needsHuman: res.needsHuman,
    ownerType: res.ownerType,
    source: res.source,
    priority: plan.priority,
    routing: res.needsTools
      ? "待办进 agent 可领队列; todo_worker 按 meta.needsTools=true 升级为执行任务交执行体"
      : "待办进 agent 可领队列; 由文本通道 agent 认领后直接给结论",
  }, { status: res.deduped ? 200 : 201 });
}
