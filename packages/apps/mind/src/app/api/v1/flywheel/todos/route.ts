import { todoRepo } from "@/server/lib/todo-repo";
import { runtimeRepo } from "@/server/lib/runtime-repo";
import { verifyCommitSha } from "@/server/lib/commit-sha";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";
import { resolveActor } from "@/server/pipeline/actor";
import { shouldRejectAssignment } from "@/server/pipeline/todo-consumer";
import { checkTodoCloseEvidence, TODO_EVIDENCE_MIN_LEN } from "@/server/pipeline/todo-evidence-gate";
import { canCloseTodo } from "@/server/pipeline/guard-todo-close-gate";
import path from "path";

export const dynamic = "force-dynamic";

/**
 * 2026-09-10 TODO 独立实体 (用户决策: 把"待办/行动项"从飞轮改进任务里独立出来)
 *
 * 为什么要独立: 飞轮改进任务 = 机制性改进 + 复测证据(认知复利);
 *   TODO = 具体行动项(含只有人能做的事: 授权/采购/决策/签字), 不要求机制改动, 也不进飞轮认知指标。
 *   混在一个队列里会造成"改进任务看起来像 todo"(用户实测反馈), 也让 agent 把 todo 当改进任务交方案。
 *
 * 字段语义:
 *   ownerType: human | agent        (谁负责; human 的 todo 出现在人的待办清单里)
 *   status:    OPEN | DOING | BLOCKED | DONE | DROPPED
 *   source:    goal_gap | review | discussion | agent_proposal | verification | human | system
 *   sourceRefId: 来源对象 id(任务/知识候选/讨论发言/审查), 支持"从哪来"的可回溯
 *
 * 接口:
 *   GET   /api/v1/flywheel/todos?status=&ownerType=&ownerId=&source=&limit=100
 *   POST  /api/v1/flywheel/todos { title, detail?, source?, sourceRefId?, ownerType?, ownerId?, priority?, dueAt?, evidence?, createdBy? }
 *   PATCH /api/v1/flywheel/todos { id, status?, ownerId?, priority?, dueAt?, note?, doneBy? }
 *   人类操作(status 变更 by human:*) 会记 HUMAN_INTERVENTION, 保证自主率指标诚实。
 */
const TABLE = "Todo";
const DB_PATH = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");
const STATUS = ["OPEN", "DOING", "BLOCKED", "DONE", "DROPPED"];

/**
 * 2026-10-26 SQLite 退役(P3): Todo / AcceptanceVerdict 已在 PG，运行期不再有 SQLite DDL。
 * 保留 openDb() 形状(调用方仍会 db.close())，但不再有任何句柄/文件被打开。
 */
async function openDb() {
  return { close() {} } as any;
}

/** 台账行 -> 前端友好结构; 缺失时为 PENDING(不是 PASS —— DONE 不等于验收通过) */
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

function rowToJson(r: any) {
  return {
    id: String(r.id), title: String(r.title), detail: r.detail == null ? null : String(r.detail),
    source: String(r.source), sourceRefId: r.sourceRefId == null ? null : String(r.sourceRefId),
    ownerType: String(r.ownerType), ownerId: r.ownerId == null ? null : String(r.ownerId),
    status: String(r.status), priority: String(r.priority),
    dueAt: r.dueAt == null ? null : new Date(Number(r.dueAt)).toISOString(),
    evidence: r.evidence == null ? null : String(r.evidence), note: r.note == null ? null : String(r.note),
    createdBy: r.createdBy == null ? null : String(r.createdBy),
    createdAt: new Date(Number(r.createdAt)).toISOString(),
    updatedAt: new Date(Number(r.updatedAt)).toISOString(),
    doneAt: r.doneAt == null ? null : new Date(Number(r.doneAt)).toISOString(),
    doneBy: r.doneBy == null ? null : String(r.doneBy),
    // 2026-09-11 agent协同(待办详情/工作安排视图需要): 负责人与"能否被 agent 认领"直接可见, 而不是让前端再拼。
    ownerLabel: r.ownerId ? (String(r.ownerType) + ":" + String(r.ownerId)) : String(r.ownerType) + ":未指派",
    claimable: String(r.status) === "OPEN" && String(r.ownerType) === "agent" && !r.ownerId,
    meta: (() => { try { return r.meta ? JSON.parse(String(r.meta)) : null; } catch { return null; } })(),
    // 2026-09-11 第 40 轮(采纳评审建议"待办详情补负责人/当前状态/依赖与阻塞"): 补上依赖与阻塞。
    //   依赖: 从 meta.dependsOn(数组) 读取 —— 字段此前**根本不存在**, 前端无处可显示。
    //   阻塞: 用 status=BLOCKED 时写入的 note(见 todos/submit 路由约定: "BLOCKED 记 note(阻塞原因)")。
    //   两者都显式给 null 而不是省略, 便于调用方区分"无依赖"与"字段缺失"。
    dependsOn: (() => { try { const m = r.meta ? JSON.parse(String(r.meta)) : null; return Array.isArray(m?.dependsOn) ? m.dependsOn : []; } catch { return []; } })(),
    blockedReason: String(r.status) === "BLOCKED" ? (r.note == null ? null : String(r.note)) : null,
    // 2026-10-12 round 72-CT: **Todo 被"丢"掉的理由**必须能被直接读到, 而不是让每个调用方自己去解 meta。
    //   实测背景: 全库 3563 条 DROPPED, 其中 **3244(91%)带 meta.dedupReason**, 理由很具体
    //   (如 "同类问题(问题类型 generic)已在 7 天内问过并已裁决(todo_X)"), 但**全仓库 dedupReason 被写 3 处、被读 0 处**
    //   —— console 0 处、本 API 原本也是 0 处。数据在、理由清楚, 却没有任何平台界面/接口能回答"这条为什么被丢"。
    //   与 dependsOn / blockedReason 同口径: **显式给 null 而不是省略**, 便于调用方区分"无理由"与"字段缺失"。
    //   只对 DROPPED 给值 —— 非 DROPPED 行即使 meta 里残留 dedupReason 也不是"丢弃理由", 给了会误导。
    dropReason: String(r.status) === "DROPPED"
      ? (() => { try { const m = r.meta ? JSON.parse(String(r.meta)) : null; return m?.dedupReason ? String(m.dedupReason) : null; } catch { return null; } })()
      : null,
    isDecision: /^\s*(\[决策\]|\[需要人类决策\]|\[人类决策\])/.test(String(r.title)),
    // 2026-09-24(可见性缺口修复): 验收结论随行返回, 不再需要跨 4 张表人工拼。
    //   acceptance    = 该待办自身的验收判定(TODO spec);
    //   taskAcceptance = meta.taskIds 指向的升级任务的验收结论聚合(任一 FAIL -> FAIL; 全 PASS -> PASS; 否则 PENDING);
    //   acceptanceState = 整体可见结论(有升级任务看 taskAcceptance, 否则看自身) —— 「DONE != 校验通过」一眼可见。
    acceptance: acceptanceJson((r as any).__acceptance),
    taskAcceptance: (r as any).__taskAcceptance || { state: "PENDING", total: 0, pass: 0, fail: 0, failTaskIds: [] },
    acceptanceState: (r as any).__acceptanceState || "PENDING",
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
  const status = url.searchParams.get("status");
  const ownerType = url.searchParams.get("ownerType");
  const ownerId = url.searchParams.get("ownerId");
  const source = url.searchParams.get("source");
  const where: string[] = [];
  const args: any[] = [];
  if (status && status !== "ALL") { where.push("status = ?"); args.push(status); } else if (!status) { where.push("status NOT IN ('DONE','DROPPED')"); }
  if (ownerType) { where.push("ownerType = ?"); args.push(ownerType); }
  if (ownerId) { where.push("ownerId = ?"); args.push(ownerId); }
  if (source) { where.push("source = ?"); args.push(source); }
  // 2026-09-11 agent协同: 公开可认领队列(status=OPEN 且 ownerType=agent 且未指派) —— 待办此前没有任何"可领"视图
  if (url.searchParams.get("claimable") === "1") { where.push("status = 'OPEN'"); where.push("ownerType = 'agent'"); where.push("ownerId IS NULL"); }
  const assignedTo = url.searchParams.get("assignedTo");
  if (assignedTo) { where.push("ownerType = 'agent'"); where.push("ownerId = ?"); args.push(assignedTo); }
  const sql = "SELECT * FROM " + TABLE + (where.length ? " WHERE " + where.join(" AND ") : "") +
    // 2026-09-11 第 40 轮(采纳评审建议"把决策项前置"): 决策类待办排最前 —— 标题以 [决策]/[需要人类决策]/
    //   [人类决策] 开头者优先, 其次才按 P0/P1/P2。理由: 决策项是**人类才能推进**的阻塞源, 排在 P2 事务之后
    //   会被长期忽略(实测: 我的两条 [决策] 待办一直沉在列表底部无人处理)。
    " ORDER BY (CASE WHEN title LIKE '[决策]%' OR title LIKE '[需要人类决策]%' OR title LIKE '[人类决策]%' THEN 0 ELSE 1 END), " +
    "(CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END), COALESCE(dueAt, 9e15), createdAt DESC LIMIT ?";
  try {
    const db = await openDb();
    const acceptanceParam = url.searchParams.get("acceptance"); // PASS | FAIL | PENDING
    // 带验收过滤时多取一些行再筛(避免 LIMIT 先把目标行截掉); 无过滤时保持原语义。
    const fetchLimit = acceptanceParam ? Math.min(2000, limit * 20) : limit;
    const rows: any[] = (await todoRepo.all(sql, ...args, fetchLimit)) as any[];
    const counts: any[] = (await todoRepo.all("SELECT status, COUNT(*) c FROM " + TABLE + " GROUP BY status")) as any[];
    const humanOpen: any = await todoRepo.get("SELECT COUNT(*) c FROM " + TABLE + " WHERE ownerType='human' AND status IN ('OPEN','DOING','BLOCKED')");
    // 可供 agent 领取的公开队列长度(工作安排视图/健康巡检直接读这个数)
    const claimable: any = await todoRepo.get("SELECT COUNT(*) c FROM " + TABLE + " WHERE status='OPEN' AND ownerType='agent' AND ownerId IS NULL");
    // ── 2026-09-24(可见性缺口修复): 行级验收结论 + 升级任务聚合 ─────────────────────────
    // 台账读取口径与 scripts/acceptance/lib/verdict-writeback.cjs 一致(entityType/entityId/verdict)。
    // 2026-10-23 修正: AcceptanceVerdict 的**写入方仍在 SQLite**（scripts/acceptance/runner.cjs 用 better-sqlite3），
    //   读侧也必须留在 SQLite，否则徽标永远 PENDING。等验收台账随其它运行期表一起迁 PG 时再同步切。
    const accRows = async (entityType: string, ids: string[]) => {
      const m = new Map<string, any>();
      if (!ids.length) return m;
      try {
        const ph = ids.map(() => "?").join(",");
        const rs = (await runtimeRepo.all("SELECT * FROM AcceptanceVerdict WHERE entityType=? AND entityId IN (" + ph + ")", entityType, ...ids)) as any[];
        for (const r of rs) m.set(String(r.entityId), r);
      } catch { /* 台账缺失按 PENDING 处理 */ }
      return m;
    };
    const rowTaskIds = new Map<string, string[]>();
    const taskIdsAll: string[] = [];
    for (const r of rows) {
      let m: any = {}; try { m = r.meta ? JSON.parse(String(r.meta)) : {}; } catch { m = {}; }
      const ids = (Array.isArray(m?.taskIds) ? m.taskIds : []).map(String);
      rowTaskIds.set(String(r.id), ids);
      for (const id of ids) taskIdsAll.push(id);
    }
    const todoAcc = await accRows("Todo", rows.map((r) => String(r.id)));
    const taskAcc = await accRows("Task", taskIdsAll);
    for (const r of rows) {
      const own = todoAcc.get(String(r.id)) || null;
      const ids = rowTaskIds.get(String(r.id)) || [];
      let pass = 0, fail = 0; const failTaskIds: string[] = [];
      for (const tid of ids) {
        const v = taskAcc.get(String(tid));
        if (!v) continue;
        if (String(v.verdict) === "PASS") pass++; else { fail++; failTaskIds.push(String(tid)); }
      }
      const taskAgg = ids.length
        ? { state: fail > 0 ? "FAIL" : (pass === ids.length ? "PASS" : "PENDING"), total: ids.length, pass, fail, failTaskIds }
        : { state: "PENDING", total: 0, pass: 0, fail: 0, failTaskIds: [] };
      (r as any).__acceptance = own;
      (r as any).__taskAcceptance = taskAgg;
      (r as any).__acceptanceState = taskAgg.total ? taskAgg.state : acceptanceJson(own).state;
    }
    // 可见性指标: DONE 待办中, 升级任务被验收判 FAIL 的条数(用户问"改进到什么程度"的直接读数)。
    //   JSON1 提取 meta.taskIds 与 AcceptanceVerdict 关联; 台账/JSON1 不可用时兜底 0(不阻断列表)。
    let doneWithFailedTask = 0;
    try {
      // 2026-10-23: PG 没有 json_each(实测 42883 function json_each(text) does not exist)。
      //   原来这条被 catch 吞掉 ⇒ 切 PG 后指标会**静默变 0**。按驱动分支保留两端语义。
      const q: any = await todoRepo.get((process.env.MIND_DB_DRIVER || "").toLowerCase() === "pg"
        ? 'SELECT COUNT(DISTINCT t.id) c FROM "Todo" t, jsonb_array_elements_text(t.meta::jsonb->\'taskIds\') je ' +
          'JOIN "AcceptanceVerdict" v ON v."entityType"=\'Task\' AND v."entityId"=je.value AND v.verdict=\'FAIL\' ' +
          "WHERE t.status='DONE'"
        : "SELECT COUNT(DISTINCT t.id) c FROM " + TABLE + " t, json_each(json_extract(t.meta,'$.taskIds')) je " +
          "JOIN AcceptanceVerdict v ON v.entityType='Task' AND v.entityId=je.value AND v.verdict='FAIL' " +
          "WHERE t.status='DONE'");
      doneWithFailedTask = Number(q?.c ?? 0);
    } catch { doneWithFailedTask = 0; }
    db.close();
    // 按验收结论过滤(前端筛"DONE 但验收 FAIL/PENDING"的可见性缺口)
    let outRows = rows;
    if (acceptanceParam) outRows = rows.filter((r) => String((r as any).__acceptanceState) === String(acceptanceParam).toUpperCase());
    outRows = outRows.slice(0, limit);
    const acceptanceCounts = { PASS: 0, FAIL: 0, PENDING: 0 } as Record<string, number>;
    for (const r of outRows) { const s = String((r as any).__acceptanceState); acceptanceCounts[s] = (acceptanceCounts[s] || 0) + 1; }
    // 2026-09-11: 待办详情需要"关联任务"可见(任务详情页有来源与关联区块, 待办侧此前只有一个计数徽标)
    let relatedTasks: any[] = [];
    try {
      const ids: string[] = [];
      for (const r of rows) {
        const m = (() => { try { return r.meta ? JSON.parse(String(r.meta)) : null; } catch { return null; } })();
        for (const id of (m?.taskIds || [])) if (typeof id === "string") ids.push(id);
      }
      if (ids.length) {
        relatedTasks = await prisma.$queryRawUnsafe<any[]>((
          "SELECT id, title, status, priority, COALESCE(assignedAgent, '未指派') assignedAgent, improvementType, updatedAt " +
          "FROM Task WHERE id IN (" + ids.map(() => "?").join(",") + ")"
        ), ...ids);
        relatedTasks = relatedTasks.map((t) => ({ ...t, updatedAt: t.updatedAt ? new Date(Number(t.updatedAt)).toISOString() : null }));
      }
    } catch { relatedTasks = []; }
    return NextResponse.json({
      ok: true, count: outRows.length,
      counts: counts.map((c) => ({ status: c.status, c: Number(c.c) })),
      humanOpen: Number(humanOpen?.c ?? 0),
      claimableCount: Number(claimable?.c ?? 0),
      // 2026-09-24 验收可见性: 行级 acceptance/taskAcceptance/acceptanceState + 汇总
      acceptanceCounts,
      doneWithFailedTask,
      rows: outRows.map(rowToJson), relatedTasks, asOf: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let b: any = {};
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }
  const title = String(b.title || "").trim();
  if (!title) return NextResponse.json({ ok: false, error: "need title" }, { status: 400 });
  const id = "todo_" + randomUUID().replace(/-/g, "").slice(0, 20);
  const now = Date.now();
  const rec = {
    id, title: title.slice(0, 300),
    detail: b.detail ? String(b.detail).slice(0, 4000) : null,
    source: String(b.source || "human").slice(0, 40),
    sourceRefId: b.sourceRefId ? String(b.sourceRefId).slice(0, 120) : null,
    ownerType: ["human", "agent"].includes(String(b.ownerType)) ? String(b.ownerType) : "human",
    ownerId: b.ownerId ? String(b.ownerId).slice(0, 80) : null,
    status: STATUS.includes(String(b.status)) ? String(b.status) : "OPEN",
    priority: ["P0", "P1", "P2"].includes(String(b.priority)) ? String(b.priority) : "P2",
    dueAt: b.dueAt ? Number(new Date(String(b.dueAt))) : null,
    evidence: b.evidence ? String(b.evidence).slice(0, 2000) : null,
    // 2026-09-24: 显式 string|null —— 瞬态资源告警闸门会在 INSERT 前把 note 写成存档说明(否则被推断为 null 型)
    note: null as string | null,
    // 2026-09-11: 默认作者由 human:operator 改为 system:api —— 未声明身份的程序化调用不再默认"人类"
    createdBy: String(b.createdBy || (String(b.authorType) === "human" ? "human:operator" : "system:api")).slice(0, 80),
    // 2026-09-11: meta 落库(控制台反馈: 后台新建的待办缺 meta.options/taskIds, 只有行内 detail)
    meta: b.meta ? (typeof b.meta === "string" ? b.meta : JSON.stringify(b.meta)) : null,
    createdAt: now, updatedAt: now, doneAt: null, doneBy: null,
  };

  // ===== 2026-09-22 [机制修复] Todo source 白名单(单一入口堵漏) =====
  // 背景(agent-x-feedback 教训): 本 API 接受调用方自定义 source(rec.source = b.source),
  //   于是任意 agent 脚本都能造出 source='agent-x-feedback' 并直接灌 Todo —— 而
  //   agent-x 反馈这类"agent 使用反馈"**不属于** Todo 的合法来源:
  //   合法来源只有「飞轮反思遗留与改进任务」+ 系统巡检 + 人类需求 + agent 收件箱。
  //   反馈类内容应先经飞轮反思沉淀(→ Reflection → Task), 再以 goal_gap /
  //   platform:improving-tasks 等来源产生改进任务, 而非被 agent 直接灌成 Todo。
  // 设计: 白名单按前缀匹配; 未命中直接 400, 并把"正确路径"写进错误提示。
  {
    const ALLOWED_SOURCE_PREFIXES = [
      // ── 飞轮反思遗留与改进(正确来源) ──
      "goal_gap",
      "platform:improving-tasks",
      "platform:integrate-agent-branches",
      "platform:agent-x-lead-scan",
      "platform:",
      "system:findings",
      "system:probe",
      "system:service-check-5h",
      "system:acceptance",
      "system:todo-consumer-guard",
      "system:",
      // ── 人类需求 / 决策 ──
      "human:operator",
      "human:",
      "human-decision:",
      "human",
      "admin:",
      // ── agent 收件箱 / 协作 ──
      "agent-message:",
      "agent:",
      "agent_proposal",
      // ── 巡检 / 告警 / 守门 ──
      "alert:",
      "pl_trust_guard",
      "fw_quality_guard",
      "macs_offline",
      "auto-review:",
      "review",
      "verification",
      "discussion",
      "discussion:question",
      // ── 其它既有白名单项(保留向后兼容) ──
      "manual",
      "token-plan",
      "ui-refactor",
      "optimization",
      "finding:",
      "proposal-f003",
      "arch-single-writer",
      "self:",
      "proposal-",
      "landing-",
      "macs-bridge",
    ];
    const src = String(rec.source || "").trim();
    const allowed = src && ALLOWED_SOURCE_PREFIXES.some((p) => src.startsWith(p));
    if (!allowed) {
      return NextResponse.json({
        ok: false, error: "SOURCE_NOT_ALLOWED", source: src,
        detail: "source 不在白名单。反馈/需求类内容应先经飞轮反思沉淀为 Reflection → Task(来源 goal_gap / platform:improving-tasks), 不要直接灌 Todo。合法前缀见 ALLOWED_SOURCE_PREFIXES",
      }, { status: 400 });
    }
  }
  // ===== 2026-09-24 [机制修复] 上游额度/限流「瞬态资源告警」不再作为人类决策上报 =====
  // 人类决定(human:operator, 源卡 todo_token429_1790055363894, 落地待办 todo_land_aior0ov1hrqf):
  //   「为什么还有旧格式，minimax的额度每5小时会自动恢复，不需要再报这个问题」。
  // 根因(机制): ① 上游额度/限流(HTTP 402/429 / "Token Plan 用量上限" / rate limit)是**按 5h 窗口滚动恢复的
  //   瞬态资源事件**, 到点自愈, 不需要人做任何事; ② 但告警生产方把它当成"要不要升级套餐/买积分"的人类决策,
  //   以**旧格式**(自拟标题 `[需您拍板][P1]…` + 自由文本 detail + **无 meta**)直接 POST 进本单一入口 ——
  //   因为没有 meta.kind, 结构化冷却去重(human-card-dedup)与回写守卫(todo-writeback-guard)对它**全部失明**,
  //   于是同一个到点自愈的问题可反复开卡打扰人类。这同时就是人类问的"为什么还有旧格式"。
  // 修法(治本, 与调用方格式无关): 在单一入口按**内容**判类; 命中则落 DROPPED 存档(信息不丢)而非人类待办,
  //   并写事件便于复算。判据抽成纯函数 @/server/pipeline/transient-resource-alert,
  //   单测 scripts/test-transient-resource-alert.ts(13 用例)。
  let transientArchived: any = null;
  try {
    const { classifyTransientResourceAlert } = await import("@/server/pipeline/transient-resource-alert");
    const cls = classifyTransientResourceAlert({ title: rec.title, detail: rec.detail, source: rec.source, ownerType: rec.ownerType, meta: rec.meta });
    if (cls.transient) {
      let bm: any = {};
      try { bm = rec.meta ? JSON.parse(String(rec.meta)) : {}; } catch { bm = {}; }
      bm.kind = "TRANSIENT_RESOURCE_ALERT";
      bm.transientResource = { matched: cls.matched, selfHealWindowHours: cls.selfHealWindowHours, classifiedAt: new Date(now).toISOString() };
      bm.originalOwnerType = rec.ownerType;
      bm.originalPriority = rec.priority;
      bm.originalTitle = rec.title;
      rec.meta = JSON.stringify(bm);
      rec.status = "DROPPED";
      rec.note = ("[2026-09-24 机制修复] 上游额度/限流属 " + cls.selfHealWindowHours + "h 自愈的瞬态资源事件(MiniMax 配额自动恢复), "
        + "按 human:operator 决定不再作为人类决策上报; 本卡仅存档可追溯。判据: " + cls.matched.join(", ")).slice(0, 2000);
      transientArchived = { suppressed: true, reason: cls.reason, matched: cls.matched, selfHealWindowHours: cls.selfHealWindowHours };
    }
  } catch (taErr: any) {
    // fail-open: 分类异常不阻断建单(只留痕), 与其它守卫一致
    await prisma.flywheelEvent.create({ data: { stage: "TRANSIENT_ALERT_CLASSIFY_ERROR", sourceType: "todo", sourceId: id,
      sourceTitle: ("瞬态资源告警分类异常(已放行): " + String(taErr?.message || taErr)).slice(0, 200), targetStage: "OK" } }).catch(() => null);
  }

  try {
    const db = await openDb();
    // 2026-09-15【机制修复】指派前校验「消费者」:
    //   问题(实测): 待办指派给一个 ACTIVE 但**没有 todo_worker 的身份** = 静默死掉 —— 归属约束让别的 agent
    //   领不走(ownerId 非空), 它自己又不认领待办(执行体只认 Task)。实测 agent-d 名下 49 条未结、
    //   最久 20.1 小时。修法: 没有消费通道就不落 ownerId, 留空走公开队列(让有消费者的 agent 领取并升级);
    //   拒绝原因写入 response.assignRejected + FlywheelEvent 留痕。判据见 @/server/pipeline/todo-consumer。
    let assignRejected: any = null;
    if (rec.status === "OPEN" && rec.ownerType === "agent" && rec.ownerId) {
      const gate = await shouldRejectAssignment(db, rec.ownerId, now);
      if (gate.reject) {
        assignRejected = { code: gate.code, ownerId: rec.ownerId, reason: gate.reason, fallback: "ownerId 置空 -> 公开队列" };
        console.warn("[todos] 指派拒绝(" + gate.code + "): " + gate.reason + " -> 留空走公开队列");
        rec.ownerId = null;
      }
    }
    // ===== 2026-09-18 [P1] 决策卡「同类问题冷却」装在**服务端建单入口**(单一入口原则) =====
    // 为什么在这里而不是各调用方: 本 API **接受调用方自定义 source**(见 rec.source = b.source), 于是任何调用者
    //   (任意 agent 脚本 / 子进程 / 外部进程)都能造出 source='human-decision:card' 的卡 —— 逐个追写入方追不完
    //   (实测: reconcile-findings 在全仓库搜不到 INSERT 点, 但它开的卡 5 张一组地出现, 且 cueKind 早有已裁决卡)。
    //   在入口统一判重, 才能覆盖**所有来源**; 判据与开卡路径共用同一个纯函数(decideCueCooldown), 不写第二份。
    //   命中时: 不建新卡; 若既有卡未结则并入其 meta.alsoFrom(一卡多源); 记 FlywheelEvent(DECISION_CARD_COOLDOWN) 便于复算。
    try {
      let bm: any = null;
      try { bm = rec.meta ? JSON.parse(String(rec.meta)) : null; } catch { bm = null; }
      if (bm && String(bm.kind || "") === "HUMAN_DECISION_CARD" && String(bm.cueKind || "").trim()) {
        // 2026-09-28 条件合并(收件箱待办 todo_18b7e59cb88144c2a6a2): 谓词/窗口/上限引 human-card-dedup 单一来源。
        const { decideCueCooldown, recentDecisionCardsSql, CARD_COOLDOWN_MS } = await import("@/server/pipeline/human-card-dedup");
        const recent: any[] = (await todoRepo.all(
          recentDecisionCardsSql({ table: TABLE }), now - CARD_COOLDOWN_MS)) || [];
        const dec = decideCueCooldown({ cueKind: String(bm.cueKind), domain: String(bm.businessDomain || bm.domain || ""), recentCards: recent, windowDays: 7 });
        if (dec.hit) {
          if (!dec.terminal) {
            const row: any = recent.find((r) => String(r.id) === dec.existingTodoId);
            if (row) {
              let cm: any = {}; try { cm = JSON.parse(String(row.meta || "{}")); } catch { cm = {}; }
              cm.alsoFrom = Array.isArray(cm.alsoFrom) ? cm.alsoFrom : [];
              cm.alsoFrom.push({ via: "server-entry-cooldown", at: new Date(now).toISOString(), source: rec.source, title: rec.title });
              await todoRepo.run("UPDATE " + TABLE + " SET meta=?, updatedAt=? WHERE id=?", JSON.stringify(cm), now, String(row.id));
            }
          }
          await prisma.flywheelEvent.create({ data: { stage: "DECISION_CARD_COOLDOWN", sourceType: "todo", sourceId: dec.existingTodoId,
            sourceTitle: ("服务端入口冷却: cueKind=" + bm.cueKind + " 已在 7 天内问过(" + dec.existingStatus + "), 本次不建卡 [" + rec.source + "] " + rec.title).slice(0, 300), targetStage: "OK" } }).catch(() => null);
          return NextResponse.json({ ok: true, deduped: true, into: dec.existingTodoId, reason: dec.reason });
        }
      }
    } catch (coolErr: any) {
      // fail-open: 冷却检查异常不阻断人类决策通道(只留痕)
      await prisma.flywheelEvent.create({ data: { stage: "DECISION_CARD_COOLDOWN_ERROR", sourceType: "todo", sourceId: id,
        sourceTitle: ("冷却检查异常(已放行): " + String(coolErr?.message || coolErr)).slice(0, 200), targetStage: "OK" } }).catch(() => null);
    }
    await todoRepo.run("INSERT INTO " + TABLE + " (id,title,detail,meta,source,sourceRefId,ownerType,ownerId,status,priority,dueAt,evidence,note,createdBy,createdAt,updatedAt,doneAt,doneBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      rec.id, rec.title, rec.detail, rec.meta, rec.source, rec.sourceRefId, rec.ownerType, rec.ownerId, rec.status, rec.priority, rec.dueAt, rec.evidence, rec.note, rec.createdBy, rec.createdAt, rec.updatedAt, rec.doneAt, rec.doneBy);
    if (assignRejected) {
      await prisma.flywheelEvent.create({
        data: { stage: "TODO_ASSIGN_REJECTED_NO_CONSUMER", sourceType: "todo", sourceId: id,
          sourceTitle: ("指派给 " + assignRejected.ownerId + " 被拒(" + assignRejected.code + "): " + assignRejected.reason).slice(0, 240), targetStage: "OK" },
      }).catch(() => null);
    }
    await prisma.flywheelEvent.create({
      data: { stage: "TODO_CREATED", sourceType: rec.source, sourceId: id, sourceTitle: (rec.ownerType + " " + rec.title).slice(0, 250), targetStage: "OK" },
    }).catch(() => null);
    // 2026-09-24: 瞬态资源告警被抑制的事件留痕(便于复算"拦截了多少次重复上报")
    if (transientArchived) {
      await prisma.flywheelEvent.create({
        data: { stage: "TRANSIENT_RESOURCE_ALERT_SUPPRESSED", sourceType: rec.source, sourceId: id,
          sourceTitle: ("[瞬态资源告警已存档] " + rec.title).slice(0, 250), targetStage: "OK" },
      }).catch(() => null);
    }
    return NextResponse.json({ ok: true, todo: rowToJson({ ...rec, dueAt: rec.dueAt }), assignRejected, transientArchived });
  } catch (e: any) {
    // 2026-09-22: 白名单等业务校验错误带 e.status(400), 其余仍 500
    const code = Number(e?.status || 500);
    return NextResponse.json({ ok: false, error: (e?.message || String(e)).slice(0, 300) }, { status: code });
  }
}

export async function PATCH(req: NextRequest) {
  let b: any = {};
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }
  const id = String(b.id || "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "need id" }, { status: 400 });
  const actor = resolveActor(req, b.by ?? b.doneBy ?? null);
  // ── 2026-09-17 新增: 结单证据预检(与任务侧的 SUBMIT_EVIDENCE_REJECTED 对齐) ────────────
  // 背景(验收 FAIL 归因实测): 近 24h 74 条验收 FAIL **全是 spec=TODO**, 其中结单 evidence 字段
  //   长度普遍是 0 或 24 字符(空/占位) —— 任务提交侧早有证据预检(无锚点直接拒收), 而**待办结单侧
  //   没有同等门槛**, 于是"口头完成"畅通无阻, 到验收环节才集中爆 FAIL。
  // 规则: agent 把待办置 DONE 时, 证据(本次提交的 evidence 或库里已存的)必须 >=120 字且至少含一个
  //   可复算锚点(file:/cmd:/sql:/commit/仓库路径); 人类(actor.kind=human)不受限; TODO_EVIDENCE_GATE=0 可关。
  // 2026-09-18: 判据抽到 @/server/pipeline/todo-evidence-gate(与 submit 入口共用, 防两处漂移)。
  if (String(b.status) === "DONE") {
    // 2026-10-27（商业化线批准）: 守门来源的待办只允许守门自身或人类结单。
    //   agent 以「旧数据已被最新数据取代」为由结掉红单是真实发生过的事（todo_plautonomy_mvkhv3in，
    //   结单时 autonomy_proxy=0.929 仍低于 0.95）。证据门只管"有没有证据"，挡不住这种结单理由。
    {
      const srcRow: any = await todoRepo.get("SELECT source FROM " + TABLE + " WHERE id = ?", id).catch(() => null);
      const src = String((srcRow && srcRow.source) || b.source || "");
      const verdict = canCloseTodo(src, actor);
      if (!verdict.allowed) {
        await prisma.flywheelEvent.create({ data: {
          stage: "GUARD_TODO_CLOSE_FORBIDDEN", sourceType: "todo", sourceId: id,
          sourceTitle: ("path=todos.patch by=" + actor.actor + " 结单被拒: " + verdict.reason).slice(0, 240), targetStage: "OK",
        } }).catch(() => null);
        return NextResponse.json({
          ok: false, error: "GUARD_TODO_CLOSE_FORBIDDEN",
          detail: verdict.reason + "（该待办来源: " + src + "）",
        }, { status: 409 });
      }
    }
    const GATE = String(process.env.TODO_EVIDENCE_GATE ?? "1") !== "0";
    const isHuman = String(actor.kind || "").toLowerCase() === "human";
    if (GATE && !isHuman) {
      let ev = String(b.evidence ?? "").trim();
      if (!ev) {
        try {
          const db0 = await openDb();
          const row: any = db0.prepare("SELECT evidence FROM " + TABLE + " WHERE id = ?").get(id);
          ev = String((row && row.evidence) || "").trim();
        } catch { /* 读不到则按空证据处理 */ }
      }
      // 2026-10-23: 逐单证据强度（与 submit 入口同口径）—— requireEvidenceKind=commit-sha 时，
      //   本次提交的 evidence 必须含仓库中真实存在的 commit sha。实测：PATCH 侧只查">=120 字 + 锚点"，
      //   而 "commit SHA" 字样本身就命中 commit 锚点，于是"不能结单/未提交"的留言也能把待办置 DONE。
      {
        const rowMeta: any = await todoRepo.get("SELECT meta, ownerId FROM " + TABLE + " WHERE id = ?", id).catch(() => null);
        let mm: any = {};
        try { mm = rowMeta && rowMeta.meta ? JSON.parse(String(rowMeta.meta)) : {}; } catch { mm = {}; }
        if (mm && mm.requireEvidenceKind === "commit-sha") {
          const provided = String(b.evidence ?? "").trim();
          const verdict = verifyCommitSha(provided, (rowMeta && rowMeta.ownerId) || b.ownerId || null);
          if (!verdict.ok) {
            await prisma.flywheelEvent.create({ data: {
              stage: "TODO_EVIDENCE_SHA_REQUIRED", sourceType: "todo", sourceId: id,
              sourceTitle: ("by=" + actor.actor + " PATCH 结单被拒: " + verdict.reason).slice(0, 240), targetStage: "OK",
            } }).catch(() => null);
            return NextResponse.json({ ok: false, error: "TODO_EVIDENCE_SHA_REQUIRED",
              detail: "该待办要求本次请求的 evidence 里给出属于你（分支或署名）的 git commit sha：" + verdict.reason }, { status: 400 });
          }
        }
      }
      const chk = checkTodoCloseEvidence(ev);
      if (!chk.ok) {
        try {
          await prisma.flywheelEvent.create({ data: {
            stage: "TODO_CLOSE_EVIDENCE_REJECTED", sourceType: "todo", sourceId: id,
            sourceTitle: ("by=" + actor.actor + " 无证据结单被拒: " + chk.missing.join("; ")).slice(0, 240), targetStage: "OK",
          } });
        } catch { /* 留痕失败不改变拒绝结果 */ }
        return NextResponse.json({
          ok: false, error: "TODO_CLOSE_EVIDENCE_REJECTED", missing: chk.missing,
          detail: "结单需要可复算证据(>=" + TODO_EVIDENCE_MIN_LEN + " 字 + 至少一个 file:/cmd:/sql:/commit/仓库路径 锚点)。请把命令/查询/提交号与输出写进 evidence 字段后重试; 人类结单不受此限。",
        }, { status: 400 });
      }
    }
  }
  const sets: string[] = ["updatedAt = ?"];
  const args: any[] = [Date.now()];
  if (b.status && STATUS.includes(String(b.status))) {
    sets.push("status = ?"); args.push(String(b.status));
    if (String(b.status) === "DONE") { sets.push("doneAt = ?", "doneBy = ?"); args.push(Date.now(), String(b.doneBy || b.by || "unknown")); }
    // 2026-10-27（商业化线数据卫生）: 状态离开 DONE 时**必须清掉 doneAt/doneBy**。
    //   否则重开后的行仍带着上一次结单的 doneBy，任何"看 doneBy 判断是否被结"的查询都会误判
    //   （实测：红单 12:40 重开为 OPEN，doneBy 仍显示 11:36:32 的 agent-operator，靠它判断会得出"仍是 DONE"）。
    else { sets.push("doneAt = NULL", "doneBy = NULL"); }
  }
  let ownerIdArgIdx = -1;
  if (b.ownerId !== undefined) { sets.push("ownerId = ?"); ownerIdArgIdx = args.length; args.push(b.ownerId ? String(b.ownerId) : null); }
  if (b.ownerType && ["human", "agent"].includes(String(b.ownerType))) { sets.push("ownerType = ?"); args.push(String(b.ownerType)); }
  if (b.priority && ["P0", "P1", "P2"].includes(String(b.priority))) { sets.push("priority = ?"); args.push(String(b.priority)); }
  if (b.dueAt !== undefined) { sets.push("dueAt = ?"); args.push(b.dueAt ? Number(new Date(String(b.dueAt))) : null); }
  if (b.note !== undefined) { sets.push("note = ?"); args.push(b.note ? String(b.note).slice(0, 2000) : null); }
  // 2026-09-14: 补 evidence 字段 —— 人类提交决定时必须能留档为依据(此前 PATCH 白名单里没有它,
  //   于是"完成"只能记 note, 平台按"有证据"口径统计时人类决策永远是"无证据")。
  if (b.evidence !== undefined) { sets.push("evidence = ?"); args.push(b.evidence ? String(b.evidence).slice(0, 4000) : null); }
  // 2026-09-11: 允许改标题/正文(实测需要修"正文里含否定式工具词导致 agent 误判"这类措辞问题;
  //   看板侧也需要就地纠错), 仍然只走白名单字段。
  if (b.title !== undefined) { sets.push("title = ?"); args.push(String(b.title).slice(0, 300)); }
  if (b.detail !== undefined) { sets.push("detail = ?"); args.push(b.detail ? String(b.detail).slice(0, 4000) : null); }
  if (b.meta !== undefined) { sets.push("meta = ?"); args.push(b.meta ? (typeof b.meta === "string" ? b.meta : JSON.stringify(b.meta)) : null); }
  try {
    // 2026-10-23 P4: 主写路径改 todoRepo（读 PG）；db 仅用于消费者心跳表(仍在 SQLite)
    const db = await openDb();
    const prev: any = await todoRepo.get("SELECT status, ownerType, ownerId, meta, doneBy, doneAt FROM " + TABLE + " WHERE id = ?", id).catch(() => null);
    const prevStatus = prev ? prev.status ?? null : null;
    // 2026-09-16 [机制修复] Quarantine 隔离(对齐 task-lease 体系): DOING -> OPEN 视为一次"放回" (release),
    //   累计到 meta.releaseCount; 达到 2 次后不再放回公开队列, 改置 status=BLOCKED + note 写"被隔离", 留人工决策。
    //   根因: 实测 24h 内"领了-放回"反复 200+ 次 (task 端 164 次, todo 端未统计但同因), 文本 agent 误领
    //   [机制修复] 后无产出 -> 立刻放回 -> 下一轮又领 -> 队列空转。改用 meta (无 schema 变更) 计数, 阈值常量化。
    const TODO_QUARANTINE_AFTER_RELEASES = Math.max(1, Number(process.env.TODO_QUARANTINE_AFTER_RELEASES ?? 2));
    if (prevStatus === "DOING" && b.status === "OPEN") {
      let m: any = {};
      try { m = prev?.meta ? JSON.parse(String(prev.meta)) : {}; } catch { m = {}; }
      const releaseCount = Number(m.releaseCount || 0) + 1;
      m.releaseCount = releaseCount;
      m.lastReleasedAt = Date.now();
      m.lastReleasedBy = b.by || b.doneBy || "unknown";
      if (releaseCount >= TODO_QUARANTINE_AFTER_RELEASES) {
        // 强制覆盖: 不放回 OPEN, 改置 BLOCKED + 隔离 note
        b.status = "BLOCKED";
        b.note = ("[quarantine] 第" + releaseCount + "次放回达隔离阈值(" + TODO_QUARANTINE_AFTER_RELEASES + "), 留待人工复核").slice(0, 2000);
        m.quarantined = true;
        m.quarantinedAt = Date.now();
        console.warn("[todos] quarantine: " + id + " 第" + releaseCount + "次放回 -> BLOCKED");
      }
      // 把更新过的 meta 写回 args (PATCH 接受 b.meta)
      b.meta = JSON.stringify(m);
    }
    // 2026-09-15【机制修复】改派闸门(与 POST 同判据, 见 @/server/pipeline/todo-consumer):
    //   把一条 OPEN 待办改派给"活但没有待办消费者"的身份, 与新建时指派一样会静默死掉 -> ownerId 落空走公开队列。
    //   仅当结果态是 OPEN 且结果 ownerType=agent 时生效; DOING(认领/升级中)不拦, 否则会打断在做的活。
    //
    //   2026-09-15 独立复核驳回重做(RK2 两步 PATCH 绕过, 复核 agent 实测):
    //   原实现只在"本次请求体带 ownerId"时才校验 -> 可以两步造出 OPEN + agent + 无消费者 ownerId:
    //     ① POST {ownerType:'human', ownerId:'agent-i'} ② PATCH {ownerType:'agent'} (不带 ownerId); 或
    //     ① POST {status:'DOING', ownerType:'agent', ownerId:'agent-i'} ② PATCH {status:'OPEN'}。
    //   根因: 闸门触发条件错挂在"请求是否携带 ownerId", 而不是"更新后的**有效归属**"。
    //   修法: 一律按更新后的有效值(请求值优先, 否则沿用库里现值)重算 ownerId 并校验; 被拒时若请求没带
    //   ownerId, 追加 SET ownerId=NULL(R2 守卫虽然兜底, 但 R1 必须自身封闭)。
    let assignRejected: any = null;
    {
      const finalStatus = (b.status && STATUS.includes(String(b.status))) ? String(b.status) : String(prevStatus || "");
      const finalOwnerType = (b.ownerType && ["human", "agent"].includes(String(b.ownerType))) ? String(b.ownerType) : String(prev?.ownerType || "");
      const effectiveOwner = ownerIdArgIdx >= 0
        ? (args[ownerIdArgIdx] ? String(args[ownerIdArgIdx]) : null)
        : (prev?.ownerId == null ? null : String(prev.ownerId));
      if (effectiveOwner && finalOwnerType === "agent" && finalStatus === "OPEN") {
        const gate = await shouldRejectAssignment(db, effectiveOwner, Number(args[0]));
        if (gate.reject) {
          assignRejected = { code: gate.code, ownerId: effectiveOwner, reason: gate.reason, fallback: "ownerId 置空 -> 公开队列" };
          console.warn("[todos] 改派/更新拒绝(" + gate.code + "): " + gate.reason + " -> 留空走公开队列");
          if (ownerIdArgIdx >= 0) { args[ownerIdArgIdx] = null; }
          else { sets.push("ownerId = ?"); args.push(null); }
        }
      }
    }
    const info = await todoRepo.run("UPDATE " + TABLE + " SET " + sets.join(", ") + " WHERE id = ?", ...args, id);
    const row: any = await todoRepo.get("SELECT * FROM " + TABLE + " WHERE id = ?", id);
    db.close();
    if (!info.changes) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    // 2026-09-11: 状态变更落事件, 供待办详情渲染"处理时间线"(任务详情有执行链, 待办此前无历史)
  try {
    await prisma.flywheelEvent.create({ data: { stage: "TODO_STATUS", sourceType: "todo", sourceId: id, sourceTitle: ((prevStatus || "?") + " -> " + String(b.status || "(update)") + " by " + String(b.by || b.doneBy || "unknown")).slice(0, 200), targetStage: "OK" } });
    // 2026-10-27（平台数据线）: 清 doneAt/doneBy **之前先留证** —— 否则"重开"会把"原来是谁结的"抹掉，
    //   事后无法回答"这张单上一次是被谁、以什么完成的"。只在本行原本是 DONE 且要转出 DONE 时写。
    if (prev && prev.doneBy && String(prevStatus) === "DONE" && String(b.status || "") !== "DONE") {
      await prisma.flywheelEvent.create({ data: {
        stage: "TODO_REOPEN_AUDIT", sourceType: "todo", sourceId: id,
        sourceTitle: ("was doneBy=" + String(prev.doneBy) + " doneAt=" + (prev.doneAt ? new Date(Number(prev.doneAt)).toISOString() : "-") +
          " reopened by=" + String(b.by || b.doneBy || "unknown")).slice(0, 240),
        targetStage: "OK",
      } }).catch(() => null);
    }
  } catch { /* 事件失败不影响更新 */ }
  if (assignRejected) {
    await prisma.flywheelEvent.create({ data: { stage: "TODO_ASSIGN_REJECTED_NO_CONSUMER", sourceType: "todo", sourceId: id, sourceTitle: ("改派给 " + assignRejected.ownerId + " 被拒(" + assignRejected.code + "): " + assignRejected.reason).slice(0, 240), targetStage: "OK" } }).catch(() => null);
  }
  // 2026-09-11 (任务 cmtw9qgcq00jg1j7603hr98ed): 人类干预必须同时满足"显式声明 x-actor-kind: human" +
  //   "by 以 human 开头"。只自称 human 的(脚本/代理默认值)不再计入指标, 改记 ACTOR_MISLABELED 供审计。
  if (actor.isHuman) {
      await prisma.flywheelEvent.create({ data: { stage: "HUMAN_INTERVENTION", sourceType: "todo", sourceId: id, sourceTitle: ("todo " + (b.status || "update") + " by " + actor.actor).slice(0, 200), targetStage: "OK" } }).catch(() => null);
    } else if (actor.mislabeled) {
      await prisma.flywheelEvent.create({ data: { stage: "ACTOR_MISLABELED", sourceType: "todo", sourceId: id, sourceTitle: ("自称人类但未声明 x-actor-kind: human -> 按 " + actor.kind + " 计: " + actor.actor + " " + (b.status || "update")).slice(0, 240), targetStage: "OK" } }).catch(() => null);
    }
    // 2026-09-14 补上"决定之后谁接手"这一跳(用户问: 我更新决策后, 这个任务后面由谁继续处理?):
    //   实测当时**没有任何人** —— 人类决定只写 TODO_STATUS/HUMAN_INTERVENTION 两条事件, 落地动作从未被创建。
    //   现在: 人类以决定内容结单的待办 -> 自动开一条 [落地] 任务(交给执行体), 来自讨论串的还会回写讨论串。
    //   幂等由 meta.followUpTaskId 保证; 失败不阻断待办本身的更新(只记日志)。
    let followUp: any = null;
    try {
      const after: any = row;
      if (String(after?.status) === "DONE" && String(after?.ownerType) === "human" && /^human/i.test(String(after?.doneBy || ""))) {
        const { consumeHumanDecision } = await import("@/server/pipeline/human-decision-consumer");
        followUp = await consumeHumanDecision(String(id));
      }
    } catch (e: any) {
      console.warn("[todos] 人类决策落地失败(非致命): " + String(e?.message || e).slice(0, 120));
    }
    return NextResponse.json({ ok: true, todo: rowToJson(row), followUp, assignRejected });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  }
}

