import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runtimeRepo } from "@/server/lib/runtime-repo";
import { getAgentCapability, canClaimTask, isClaimableImprovementType, CLAIMABLE_IMPROVEMENT_TYPES } from "@/server/pipeline/agent-capability";

export const dynamic = "force-dynamic";

/**
 * 2026-09-10 任务创建入口 (用户要求: "有优化空间的都可以创建任务做")
 *   POST /api/v1/flywheel/tasks  —— 任何有权限的主体(平台/agent/人)都能登记任务
 *   GET  /api/v1/flywheel/tasks?assignedAgent=&status=&improvementType=&limit=
 *
 * 与既有生成器的关系: goal-check(目标差距) / 反思(主题改进) / verify-tasks(独立复核) 仍是自动生成器,
 *   本接口用于"人或其他 agent 主动登记工作", 二者共用同一 Task 表与认领/提交流程。
 *
 * 认领规则(见 tasks/claim): PENDING + manualReview!=true + (assignedAgent IS NULL OR assignedAgent=认领者)。
 *   因此 assignedAgent 用于"定向派单": 设了就只有该 agent 能领。
 *   assignedAgent 建议取值: 具体 agent id(如 agent-operator) 或执行体身份(如 agent-d)。
 */
const REQUIRED = ["title", "description", "requirements", "acceptanceCriteria", "qualityStandards"];

/**
 * 2026-09-24(可见性缺口 todo_bdce470195d94307abff): 任务的验收结论随行返回。
 * 口径与 scripts/acceptance/lib/verdict-writeback.cjs 一致; 台账缺失 = PENDING(DONE 不等于验收通过)。
 */
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

export async function POST(req: NextRequest) {
  let b: any = {};
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }
  const missing = REQUIRED.filter((k) => !String(b[k] || "").trim());
  if (missing.length) return NextResponse.json({ ok: false, error: "缺少必填字段: " + missing.join(","), required: REQUIRED }, { status: 400 });

  // ===== 2026-09-14 定位硬约束(用户两次明确) =====
  //   规则: **只有飞轮中发现的才是改进任务**; 其余一切(人的要求 / agent 反馈 / 平台质检流程 / 决策落地 …)
  //   都必须建成**待办**。判据 = 是否带飞轮来源(指标缺口 sourceProblemId / 反思 findings sourceReflectionIds /
  //   反思汇总 sourceSummaryId), 或显式声明由待办升级(fromTodo)。
  //   为什么加硬约束: 实测在办任务 35 条里**飞轮来源 0 条**(100% 错位) —— 全是"不是飞轮发现的东西"穿着
  //   改进任务的外衣, 直接污染"改进任务完成率"这个业务指标。软提示(先说再犯)已被证明无效。
  //   逃生口: 显式传 fromTodo=true(由待办升级而来) 或 sourceProblemId/sourceReflectionIds/sourceSummaryId。
  //
  // 2026-09-14 (f-005 人类决定A 落地时实测到的回归): 提案闭环 close-proposal-loop.cjs **消费的是飞轮产出的
  //   提案**(Knowledge.sourceType='AGENT_OUTPUT'), 它属于"飞轮中发现的"工作; 但它走本 HTTP 接口建单,
  //   被硬约束误伤 -> 提案的 [复核]/[补证] 链路整条 409, 提案永久停在 PROPOSAL_VERIFYING。
  //   补一个**受校验的**飞轮来源: sourceProposalId 必须命中一条真实 AGENT_OUTPUT 提案才豁免; 传错/伪造
  //   仍然 409。边界文档的"阶段6 产出验证->待办"迁移仍保留, 本豁免只覆盖飞轮提案闭环, 不扩大。
  const sourceProposalId = String(b.sourceProposalId || "").trim();
  let proposalSourced = false;
  if (sourceProposalId) {
    try {
      const k = await prisma.knowledge.findFirst({ where: { id: sourceProposalId, sourceType: "AGENT_OUTPUT" }, select: { id: true } });
      proposalSourced = Boolean(k);
    } catch { proposalSourced = false; }
  }
  const hasFlywheelSource = Boolean(
    String(b.sourceProblemId || "").trim() ||
    (String(b.sourceReflectionIds || "").trim() && String(b.sourceReflectionIds || "").trim() !== "[]") ||
    String(b.sourceSummaryId || "").trim() ||
    proposalSourced
  );
  const fromTodo = b.fromTodo === true || String(b.createdBy || "").startsWith("todo:");
  if (!hasFlywheelSource && !fromTodo) {
    return NextResponse.json({
      ok: false,
      error: "POSITION_VIOLATION: 非飞轮来源的工作请建成**待办**(Todo), 不要建改进任务(Task)",
      detail: "规则: 只有飞轮自省(指标缺口/反思 findings)发现的问题才是改进任务; 人的要求、agent 反馈、平台质检流程、决策落地等都属于待办。",
      howto: "改成 POST /api/v1/flywheel/todos { title, detail, ownerType:'agent', priority, source, createdBy };" +
             "待办需要真执行能力时会由 todo_worker 自动升级为任务(带 fromTodo 标记)交给执行体。",
      seeAlso: "docs/platform-logic/task-vs-todo-boundary-2026-09-14.md",
    }, { status: 409 });
  }
  try {
    // 2026-09-15 派单路由(任务 cmu24ffju084dki4a5khu22g8): 取证必需型任务(机制修复/落地/复核/补证)不得在**建单时**
    //   指派给缺能力的 agent —— 否则文本通道领不走(被 claim 守卫挡下)、T3 又因 assignedAgent 约束看不到, 任务卡死。
    //   处理: 若请求的 assignedAgent 能力不足, 落库为未指派(回公开队列由 T3 认领), 并在响应/事件里如实说明未被采纳。
    const improvementPayloadStr = b.improvementPayload
      ? (typeof b.improvementPayload === "string" ? b.improvementPayload : JSON.stringify(b.improvementPayload))
      : null;
    const improvementTypeStr = b.improvementType ? String(b.improvementType) : "GOAL_GAP";
    // ===== 2026-09-17 生成侧闸门(待办 todo_d563d97665df49428c45) =====
    //   与认领侧(tasks/claim)同一口径、同一白名单常量: 一条任务要可被认领, 必须满足
    //     sourceReflectionIds 非空(反思衍生) 或 improvementType ∈ CLAIMABLE_IMPROVEMENT_TYPES。
    //   生成侧若允许落一条两者都不满足的任务, 它就对**所有** agent 不可认领 —— 队列里看得见、没人接,
    //   且不会有任何报错(实测事故: improvementType='VERIFY' 不在白名单)。所以在**建单时**直接 422 +
    //   missing, 把"漏配"拦在源头上, 而不是等 auditUnclaimable 事后体检。
    const hasReflectionSource = (() => {
      const raw = String(b.sourceReflectionIds || "").trim();
      return raw !== "" && raw !== "[]";
    })();
    if (!isClaimableImprovementType(improvementTypeStr) && !hasReflectionSource) {
      return NextResponse.json({
        ok: false,
        error: "IMPROVEMENT_TYPE_NOT_CLAIMABLE",
        detail: `improvementType='${improvementTypeStr}' 不在认领白名单, 且未提供 sourceReflectionIds —— 建成后该任务对所有人都不可认领(认领接口会静默跳过)。`,
        missing: [
          `improvementType '${improvementTypeStr}' 不在认领白名单`,
          "sourceReflectionIds 为空(非反思衍生任务)",
        ],
        claimableImprovementTypes: CLAIMABLE_IMPROVEMENT_TYPES,
        howto: "改用白名单内的类型, 或提供真实的 sourceReflectionIds(反思 findings)。白名单单一来源: packages/apps/mind/src/server/pipeline/claimable-task-types.json",
      }, { status: 422 });
    }
    let assignedAgent = b.assignedAgent ? String(b.assignedAgent).slice(0, 80) : null;
    let assignmentRerouted: { requested: string; reason: string } | null = null;
    if (assignedAgent) {
      const cap = await getAgentCapability(assignedAgent);
      const chk = canClaimTask(cap, { title: String(b.title), improvementType: improvementTypeStr, improvementPayload: improvementPayloadStr });
      if (!chk.ok) {
        assignmentRerouted = {
          requested: assignedAgent,
          reason: `任务属「${chk.requirement.label}」需取证; ${assignedAgent} 为 T${cap.tier}(${cap.source}) 缺 ${chk.missing.join("、")} -> 不改派给它, 落库为未指派, 由有工具的执行体认领`,
        };
        assignedAgent = null;
      }
    }
    const task = await prisma.task.create({
      data: {
        title: String(b.title).slice(0, 200),
        description: String(b.description),
        background: String(b.background || "由任务创建接口登记 (" + new Date().toISOString() + ")"),
        requirements: String(b.requirements),
        // 2026-09-11 修复(实测两次): agent 认领时只读 materials, 而调用方常把证据写在 description
        //   -> 复核任务显示"素材为空 {}"
        materials: (() => {
          const raw = b.materials;
          if (raw && typeof raw === "object" && Object.keys(raw).length) return JSON.stringify(raw);
          if (typeof raw === "string" && raw.trim() && raw.trim() !== "{}") return raw;
          return JSON.stringify({ evidence: String(b.description || "").slice(0, 3000), note: "由 description 自动补齐(agent 只读 materials)" });
        })(),
        acceptanceCriteria: String(b.acceptanceCriteria),
        qualityStandards: String(b.qualityStandards),
        status: "PENDING",
        priority: ["P0", "P1", "P2"].includes(String(b.priority)) ? String(b.priority) : "P2",
        theme: b.theme ? String(b.theme).slice(0, 60) : "平台演进",
        improvementType: improvementTypeStr,
        assignedAgent,
        manualReview: b.manualReview === true,
        // 2026-09-18 [机制修复·实测缺陷] 来源字段此前**只读不写**: 上面第 49-51 行用 sourceProblemId /
        //   sourceReflectionIds / sourceSummaryId 判"是不是飞轮来源"(定位硬闸), 但 create 的 data 里一个都没落库 ——
        //   于是带来源建的任务丢了来源链, 审计里"哪来的活"看不见(实测: 我新建的重做任务 sourceTaskId 落库为 NULL,
        //   关联只留在描述文本里)。这里补齐四个来源字段(含 sourceTaskId: 重做/关联场景)。
        //   只写有值的: 空串/NULL 保持 NULL(不要造"空来源", 否则审计分不清"无来源"和"来源丢了")。
        ...(String(b.sourceTaskId || "").trim() ? { sourceTaskId: String(b.sourceTaskId).trim() } : {}),
        ...(String(b.sourceProblemId || "").trim() ? { sourceProblemId: String(b.sourceProblemId).trim() } : {}),
        ...(String(b.sourceSummaryId || "").trim() ? { sourceSummaryId: String(b.sourceSummaryId).trim() } : {}),
        ...(String(b.sourceReflectionIds || "").trim() ? { sourceReflectionIds: String(b.sourceReflectionIds).trim() } : {}),
        structuredContext: JSON.stringify({ sourceChain: { type: fromTodo ? "TodoUpgrade" : "FlywheelSource", by: String(b.createdBy || "unknown") }, fromTodo, note: b.note ?? null }),
        // 2026-09-11 修复: 调用方若已传 JSON 字符串, 原先会再 stringify 一次 -> 落库成双重编码,
        //   读取方 JSON.parse 得到字符串而不是对象(提案闭环 C 段因此拿不到 proposalId, 静默不生效)。
        improvementPayload: improvementPayloadStr,
      },
      select: { id: true, title: true, assignedAgent: true, improvementType: true, priority: true },
    });
    await prisma.flywheelEvent.create({
      data: { stage: "TASK_CREATED", sourceType: "manual-task", sourceId: task.id, sourceTitle: (String(b.createdBy || "unknown") + " | " + task.title).slice(0, 250), targetStage: "OK" },
    }).catch(() => null);
    if (assignmentRerouted) {
      await prisma.flywheelEvent.create({
        data: { stage: "TASK_ASSIGNMENT_REROUTED", sourceType: "manual-task", sourceId: task.id, taskId: task.id,
          sourceTitle: (assignmentRerouted.requested + " -> (未指派) | " + assignmentRerouted.reason).slice(0, 300), targetStage: "OK" },
      }).catch(() => null);
    }
    return NextResponse.json({ ok: true, task, ...(assignmentRerouted ? { assignmentRerouted } : {}) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const where: any = {};
  const assignedAgent = url.searchParams.get("assignedAgent");
  const status = url.searchParams.get("status");
  const ty = url.searchParams.get("improvementType");
  if (assignedAgent) where.assignedAgent = assignedAgent;
  if (status && status !== "ALL") where.status = status;
  if (ty) where.improvementType = ty;
  const rows = await prisma.task.findMany({ where, orderBy: { createdAt: "desc" }, take: limit,
    select: { id: true, title: true, status: true, priority: true, theme: true, improvementType: true, assignedAgent: true, createdAt: true, updatedAt: true, completedBy: true } });
  const counts = await prisma.task.groupBy({ by: ["status"], where: assignedAgent ? { assignedAgent } : {}, _count: { _all: true } });
  // 2026-09-24: 附上验收结论(台账 AcceptanceVerdict); 台账不可用时按 PENDING —— 绝不默认 PASS。
  let accMap = new Map<string, any>();
  try {
    const ids = rows.map((r) => String(r.id));
    if (ids.length) {
      // 2026-10-23 P5: 与其它 AcceptanceVerdict 读写统一走 runtime-repo（跟随 sqlite/dual/pg 模式）
      const vs: any[] = await runtimeRepo.all(
        "SELECT entityId, verdict, specType, failsJson, checkedAt FROM AcceptanceVerdict WHERE entityType='Task' AND entityId IN (" + ids.map(() => "?").join(",") + ")",
        ...ids);
      for (const v of vs) accMap.set(String(v.entityId), v);
    }
  } catch { accMap = new Map<string, any>(); }
  const outRows = rows.map((r) => ({ ...r, acceptance: acceptanceJson(accMap.get(String(r.id))) }));
  const acceptanceCounts = { PASS: 0, FAIL: 0, PENDING: 0 } as Record<string, number>;
  for (const r of outRows) { const s = r.acceptance.state; acceptanceCounts[s] = (acceptanceCounts[s] || 0) + 1; }
  return NextResponse.json({ ok: true, count: outRows.length, counts: counts.map((c) => ({ status: c.status, c: c._count._all })), acceptanceCounts, rows: outRows, asOf: new Date().toISOString() });
}

