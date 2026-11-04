import { openMindDb } from "@/server/lib/open-mind-db";
import { todoRepo } from "@/server/lib/todo-repo";
import { runtimeRepo } from "@/server/lib/runtime-repo";
import { prisma } from "@/lib/prisma";
import path from "path";
import { isHumanOnlyDecision } from "./human-only-classifier";
import { isNonDecisionText } from "./auto-decision";
import { buildBusinessDecisionCard } from "./decision-card-language";
import { isNoActionDecision } from "./no-action-decision";
import { parseDecisionOptions, resolveDecisionOption } from "./decision-option-routing";

/**
 * human-decision-consumer.ts — 2026-09-14
 *
 * 用户问: "我这边更新决策后, 这个任务后面会由谁继续处理?"
 * 实测答案(当时): **没有任何人** —— 人类提交决定后平台只写两条事件
 *    (TODO_STATUS + HUMAN_INTERVENTION), 然后链路就断了:
 *      待办 -> DONE, 但它对应的"照这个决定去做"的动作**从未被创建**。
 *      于是出现用户描述的那一幕: 我(人类)把决定交回去, 却没有任何人接手。
 *
 * 本模块补上这一跳: 人类决策类待办一旦以**决定内容**结单, 就自动
 *   1) 生成一条可认领的落地任务([落地] 按人类决策执行: ...), 决定原文进描述与凭据;
 *   2) 若该待办来自讨论串, 把"决定 + 落地任务"回写到讨论串(发起人能看到后续);
 *   3) 写 FlywheelEvent(HUMAN_DECISION_CONSUMED) 与待办 meta.followUpTaskId 作为幂等标记。
 *
 * 幂等: 以 meta.followUpTaskId 为标记 —— 同一条待办重复结单(或人类改主意再交一次)不会重复建单;
 *   但若人类**更新了决定内容**(note/evidence 变了), 会建一条新单并在描述里标注"决定已更新"。
 */

export const DECISION_TITLE_RE = /^\s*\[\s*(决策|人类决策|需要人类决策)\s*\]/;
/** 决定落地任务交给谁: 执行体(需要真动作: 授权/采购/改代码/部署)。可用环境变量覆盖。 */
export const DECISION_EXECUTOR = process.env.HUMAN_DECISION_EXECUTOR || "agent-d";

/**
 * 决策落地任务的**路由**(2026-09-14 user 反馈): "任务是谁创建给我的, 我决策提交后应该由那个 agent 接手"
 *
 * 数据(实测 16 条人类待办的发起人):
 *   agent:proposal-loop  7 条 ← **平台自动化流程**, 不是真 agent
 *   reconcile-findings   5 条 ← 同样是平台批处理
 *   human:operator       2 条 ← 用户自己在讨论区发的
 *   agent:agent-d 1 条 ← 真 agent(且 T3)
 *   platform:agent-d 1 条
 * 而能力分级实测: 只有 agent-d 是 T3, 其余 agent 都是 T1/T0(文本通道, 只能判断不能执行)。
 *
 * 所以"一律回到发起人"在平台上行不通(文本通道接不了执行活 -> 又变成我们刚治过的空转),
 * "一律给执行体"又丢掉了发起人的上下文。正确做法是**两级路由**:
 *   1) 发起人是真 agent 且有执行能力(T>=3) -> **指派回它**(闭环回原发起人, 它最懂上下文);
 *   2) 发起人是真 agent 但能力不足     -> 执行体接手, 但**明确标注 raisedBy** 并回执发起人;
 *   3) 发起人是平台流程/人类           -> 执行体接手(没有"那个 agent"可回)。
 */
export interface DecisionRouting {
  assignedAgent: string;
  raisedBy: string | null;
  reason: string;
  kind: "BACK_TO_RAISER" | "RAISER_INCAPABLE" | "PLATFORM_RAISED" | "UNKNOWN_RAISED";
}

export function routeDecisionTask(opts: { createdBy: string | null; raiserTier: number | null; executor: string }): DecisionRouting {
  const raw = String(opts.createdBy || "").trim();
  const raiser = /^agent:/i.test(raw) ? raw.slice(6).trim() : (/^platform:/i.test(raw) ? raw.slice(9).trim() : "");
  if (!raiser) {
    return { assignedAgent: opts.executor, raisedBy: null, kind: "PLATFORM_RAISED",
      reason: "发起人是平台流程/人类(" + (raw || "未知") + ") -> 由执行体接手" };
  }
  if (opts.raiserTier === null) {
    return { assignedAgent: opts.executor, raisedBy: raiser, kind: "UNKNOWN_RAISED",
      reason: "发起人 " + raiser + " 未在注册表(可能已注销) -> 由执行体接手" };
  }
  if (opts.raiserTier >= 3) {
    return { assignedAgent: raiser, raisedBy: raiser, kind: "BACK_TO_RAISER",
      reason: "回到原发起人 " + raiser + "(T" + opts.raiserTier + ", 具备执行能力) —— 它最清楚上下文" };
  }
  return { assignedAgent: opts.executor, raisedBy: raiser, kind: "RAISER_INCAPABLE",
    reason: "原发起人 " + raiser + " 是 T" + opts.raiserTier + " 文本通道(无执行能力) -> 执行体接手, 并回执发起人" };
}

/**
 * "决定=关掉"类文本: 这类结单**不需要有人去做任何事**, 不该再开落地任务。
 * 实测来历: 用户在讨论区写"这个任务已经优化了, 可以标记为完成了" —— 若照旧开单, 平台会凭空生成
 *   一条无意义的 [落地] 任务(而它又会占配额、进队列、被 agent 领走)。故识别为"直接关闭"。
 *
 * 2026-09-17 机制修复(实测假阴性, 升级任务 cmu5lyhgw001lfvjp787t8wx0 / 落地待办 todo_land_jchhhfj25hgs):
 *   原内联正则 /(无需处理|不用处理|不需要处理|...)/ 要求「不需要」与「处理」逐字相邻, 而真实回复是
 *   "确认信息，应该不需要我处理什么吧"(中间多了主语「我」)-> 漏判 -> 平台凭空开了【落地】待办并升级为任务,
 *   执行体无活可干、反复空转。判据已抽到 no-action-decision.ts 的 isNoActionDecision()(可选主语 + 规范动作词),
 *   并保留 NO_ACTION_RE 导出以兼容外部引用。回归见 packages/apps/mind/scripts/test-no-action-decision.ts。
 */
export { NO_ACTION_RE } from "./no-action-decision";

export interface ConsumeResult {
  ok: boolean;
  reason?: string;
  todoId: string;
  followUpTaskId?: string;
  wroteBackToDiscussion?: boolean;
  /** 决定是"直接关闭/无需处理"类 -> 不开落地任务 */
  closedWithoutAction?: boolean;
  /** 决定是"先补充信息再决定"类(B 选项) -> 不开执行落地任务, 只记录挂起 */
  deferredForInfo?: boolean;
  /** 本次决定命中了跨来源去重 -> 复用已有落地待办, 未新建 */
  dedupedToExistingLanding?: boolean;
}

function parseMeta(raw: unknown): any {
  try { return raw ? JSON.parse(String(raw)) : {}; } catch { return {}; }
}

/**
 * Todo 是**运行期自建表**: Prisma 的 $queryRawUnsafe 读它会报
 *   "Raw query failed. Code: N/A"(实测, 与讨论表同一个坑), 因此这里统一走 better-sqlite3;
 *   Task / FlywheelEvent 仍用 prisma(模型表)。
 */
async function openTodoDb() {

  const db = openMindDb({ role: "direct-rw", dbPath: process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db"), caller: "human-decision-consumer" });

  return db;
}

/**
 * 2026-09-18 机制修复(落地待办 todo_land_jvijaydsfs4s / 人类决策「重复内容需要清理」):
 *   读取既有的【落地】待办(未被去重作废的), 供建单前做**跨来源**去重。
 *   原来只有"同一源待办重复结单"的幂等(meta.followUpTaskId), 治不了**多张孪生决策卡**
 *   (同一句人类决定 + 同一来源问题)各自派生一张落地单 —— 实测 jvijay/zkrie 就是这样多出来的。
 */
async function loadExistingLandingTodos(): Promise<Array<{ id: string; status: string; decisionText: string; sourceTitle: string }>> {
  {
    const rows = (await todoRepo.all(
      "SELECT id,status,title,meta FROM Todo WHERE source='human-decision:landing' AND status<>'DROPPED'"
    )) as any[];
    return rows.map((r) => {
      let m: any = {};
      try { m = JSON.parse(String(r.meta || "{}")); } catch { m = {}; }
      const title = String(r.title || "");
      const src = String(m.sourceQuestion || "")
        || title.replace(/^【?落地】?\s*按人类决策执行\s*[:：]\s*/, "");
      return { id: String(r.id), status: String(r.status), decisionText: String(m.decisionText || ""), sourceTitle: src };
    });
  }
}

export async function consumeHumanDecision(todoId: string): Promise<ConsumeResult> {
  let t: any = null;
  t = (await todoRepo.get("SELECT * FROM Todo WHERE id = ?", todoId)) || null;
  if (!t) return { ok: false, reason: "TODO_NOT_FOUND", todoId };
  if (String(t.ownerType) !== "human") return { ok: false, reason: "NOT_HUMAN_TODO", todoId };
  if (String(t.status) !== "DONE") return { ok: false, reason: "NOT_DONE", todoId };
  const doneBy = String(t.doneBy || "");
  // 2026-09-14: 除人类结单外, 也要接受**平台自动 8 维审视结单**(doneBy=system:auto-decision-8d) ——
  //   用户要求"人类超时未决就按审视建议自动处理"; 否则自动决策永远生成不了落地任务(实测踩到)。
  //   两类来源在证据链上必须可分辨, 故一律把 decidedByKind 记进材料。
  const isHumanDecided = /^human/i.test(doneBy);
  const isAutoDecided = /^system:auto-decision/i.test(doneBy);
  if (!isHumanDecided && !isAutoDecided) return { ok: false, reason: "NOT_DECIDED_BY_HUMAN_OR_AUTO", todoId };
  const decidedByKind = isHumanDecided ? "human" : "auto-8d";

  const decision = String(t.note || t.evidence || "").trim();
  if (decision.length < 5) return { ok: false, reason: "NO_DECISION_TEXT", todoId };

  // 2026-09-18 第二道防御(第一道在 tasks/submit: 无 AUTO_DECISION 行就不结单):
  //   实测 todo_land_cpq1bwkv4731 的【人类决定】是材料 JSON 回显 `{"decisionTodoId":...}`,
  //   todo_land_1eclqh4e8eqk 是 JSON 残片 —— 这是"把材料当决定"的产物, 不能再生成落地单。
  if (isNonDecisionText(decision)) {
    await todoRepo.run("UPDATE Todo SET status='BLOCKED', note=COALESCE(note,'')||?, updatedAt=? WHERE id=?",
      " [2026-09-18 机制修复: 本条 note/evidence 是材料 JSON/上下文回显而非人类决策, 拒绝生成落地单]",
      Date.now(), String(t.id));
    await prisma.flywheelEvent.create({
      data: { stage: "AUTO_DECISION_MISSING", sourceType: "todo", sourceId: String(t.id),
        sourceTitle: "决策文本是材料回显(非决策), 拒绝生成落地单", targetStage: "FAIL" },
    }).catch(() => null);
    return { ok: false, reason: "NON_DECISION_TEXT", todoId };
  }

  // 2026-09-14 实测修正: 自动 8 维审视里, 有 7/21 条写了 DEFER_TO_HUMAN/需人拍板 —— 等于把球原样踢回给人,
  //   用户反馈"那些数据我处理不了"。现在: 判定为"只能人拍板"的, 不再生成落地待办, 而是产出一张**决策卡**
  //   (选项 + 推荐 + 后果), 并给原待办打 humanOnly 标记 —— auto-decide 会跳过这类, 避免"自动→推回→再自动"死循环。
  // 2026-09-15 实测修正(判据抽到 human-only-classifier.ts): 原内联正则不识别否定,
  //   "不需人拍板。已执行..." 会因子串 "需人拍板" 误判 -> 误生成"【需您拍板】"卡(踢球回人, todo_tfe7uhzvoj20y3ol 实测)。
  //   现改用 isHumanOnlyDecision(), 对中文短语加否定前缀负向断言; 回归见
  //   packages/apps/mind/scripts/test-human-only-classifier.ts。
  if (isHumanOnlyDecision(decision)) {
    const cardId = "todo_card_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    const reviewTaskRef = String(parseMeta(t.meta).autoReviewTaskId || "manual");   // 产出该决定的审视任务(可追溯)
    const optsMatch = decision.match(/选项\s*[:：]\s*(.+?)(?:\|\s*推荐|$)/);
    const recMatch = decision.match(/推荐\s*[:：]\s*([^|]+)/);
    const optionsText = optsMatch ? optsMatch[1].trim().slice(0, 800) : "";
    const recommended = recMatch ? recMatch[1].trim().slice(0, 200) : "";
    const why = decision.replace(/^.*?HUMAN_ONLY\s*[:：]?/, "").split("|")[0].trim().slice(0, 300) || decision.slice(0, 300);
    // 2026-09-15【机制修复】决策卡文案业务化(用户实测: 待办 todo_953ed4cd92294a5d8a0d):
    //   旧实现把源 finding 标题原样拼在"【需您拍板】"后, 用户看到
    //     "【需您拍板】[人审] 主题「HERMES落库」finding f-002: Memory [4x11za] 声称 35 个候选全部落库失败..."
    //   明确反馈"看不懂、处理不了"。现统一由 decision-card-language 生成:
    //   标题由【业务域 + 事件类型】拼装(不使用原文 -> 结构上不泄漏技术词), 正文 ①~⑤,
    //   原文与内部 ID 只放末尾【技术细节(可跳过)】段。回归见 scripts/test-decision-card-language.ts。
    const card = buildBusinessDecisionCard({
      sourceTitle: String(t.title || ""),
      decision,
      optionsText,
      recommended,
      reviewRef: reviewTaskRef,
      sourceTodoId: String(t.id),
    });
    {
      await todoRepo.run("INSERT INTO Todo (id,title,detail,source,sourceRefId,ownerType,ownerId,status,priority,evidence,note,createdBy,createdAt,updatedAt,meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        cardId,
             card.title.slice(0, 300),
             card.detail,
             "auto-review:human-only", String(t.id), "human", process.env.HUMAN_OPERATOR || "operator", "OPEN", "P1",
             "review:" + reviewTaskRef, null, "system:auto-decision-8d", Date.now(), Date.now(),
             JSON.stringify({ kind: "HUMAN_DECISION_CARD", optionsText, recommended, sourceDecisionTodoId: t.id, viaTask: reviewTaskRef, humanOnly: true,
                              businessLanguage: true, businessDomain: card.domain, cueKind: card.cueKind, decisionWhy: why }));
      // 原待办标记 humanOnly -> auto-decide 跳过, 防循环
      const meta1 = parseMeta(t.meta);
      meta1.humanOnly = true;
      meta1.humanOnlyAt = new Date().toISOString();
      await todoRepo.run("UPDATE Todo SET meta = ?, updatedAt = ? WHERE id = ?", JSON.stringify(meta1), Date.now(), String(t.id));
    }
    await prisma.flywheelEvent.create({
      data: { stage: "HUMAN_DECISION_CARD_CREATED", sourceType: "todo", sourceId: String(t.id),
        sourceTitle: ("auto-8d 判定只能人拍板 -> 决策卡 " + cardId + "(业务语言): " + card.title.slice(0, 100)).slice(0, 300), targetStage: "OK" },
    }).catch(() => null);
    return { ok: true, todoId: t.id, followUpTaskId: cardId, reason: "HUMAN_ONLY_CARD" };
  }

  /**
   * 把源待办标记为"无需落地"并写事件 —— 「no-action 文本判据」与「选项 C=无需处理」共用。
   * (只改 meta + 写 FlywheelEvent, 不生成任何落地待办/任务)
   */
  async function closeWithoutAction(reasonTag: string, why: string): Promise<ConsumeResult> {
    const meta0 = parseMeta(t.meta);
    meta0.closedWithoutAction = true;
    meta0.closedReason = why.slice(0, 200);
    meta0.closedAt = new Date().toISOString();
    await todoRepo.run("UPDATE Todo SET meta = ?, updatedAt = ? WHERE id = ?", JSON.stringify(meta0), Date.now(), String(t.id));
    await prisma.flywheelEvent.create({
      data: { stage: "HUMAN_DECISION_CLOSED_NO_ACTION", sourceType: "todo", sourceId: t.id,
        sourceTitle: ("decision by " + doneBy + ": 直接关闭, 不落地(" + reasonTag + ") — " + why.slice(0, 110)).slice(0, 300), targetStage: "OK" },
    }).catch(() => null);
    return { ok: true, todoId: t.id, closedWithoutAction: true, reason: "CLOSED_NO_ACTION" };
  }

  if (isNoActionDecision(decision)) {
    return closeWithoutAction("no-action 文本判据", decision);
  }

  // 2026-09-18 机制修复(本单来源: 落地待办 todo_land_l2r2wzspprcj / 源卡 todo_e1s1g0217r5didag
  //   / 升级任务 cmu5z3r0k0007jlosqh360ydq):
  //   决策卡正文给出了 A/B/C 选项, 但消费者此前**从不读人类选了哪个字母** —— 人类回
  //   "B，这个是不是之前已经处理过了，已处理过的为什么还是会出任务让我决策？"
  //   (B=先补充信息再决定, 明确*不是*执行), 平台仍按"按人类决策执行"建了【落地】待办并升级成执行体任务,
  //   执行体领到后无活可干。判据抽到 decision-option-routing.ts(用**卡片自己的选项文本**, 不硬编码 A/B/C)。
  //   行为: CLOSE -> 关单; DEFER -> 记录挂起且**不建执行落地单**; EXECUTE/UNKNOWN -> 维持原落地流程(保守)。
  const cardMeta = parseMeta(t.meta);
  const choice = resolveDecisionOption(decision, parseDecisionOptions(t.detail, cardMeta.optionsText));
  if (choice && choice.klass === "CLOSE_NO_ACTION") {
    return closeWithoutAction("选项 " + (choice.label || "?") + "=无需处理", decision);
  }
  if (choice && choice.klass === "DEFER_INFO") {
    cardMeta.deferredForInfo = true;
    cardMeta.deferredOption = choice.label || null;
    cardMeta.deferredReason = choice.text.slice(0, 300);
    cardMeta.deferredVia = choice.via;
    cardMeta.deferredAt = new Date().toISOString();
    await todoRepo.run("UPDATE Todo SET meta = ?, updatedAt = ? WHERE id = ?", JSON.stringify(cardMeta), Date.now(), String(t.id));
    await prisma.flywheelEvent.create({
      data: { stage: "HUMAN_DECISION_DEFERRED_INFO", sourceType: "todo", sourceId: t.id,
        sourceTitle: ("decision by " + doneBy + ": 选择" + (choice.label || "补信息") + "=先补充信息再决定 -> 不建执行落地单 — " + decision.slice(0, 100)).slice(0, 300), targetStage: "OK" },
    }).catch(() => null);
    return { ok: true, todoId: t.id, deferredForInfo: true, reason: "DEFERRED_FOR_INFO" };
  }

  const meta = parseMeta(t.meta);
  const prevTaskId = meta.followUpTaskId ? String(meta.followUpTaskId) : "";
  if (prevTaskId && String(meta.followUpDecision || "") === decision) {
    return { ok: false, reason: "ALREADY_CONSUMED", todoId, followUpTaskId: prevTaskId };
  }

  // 只有"决策类"待办才自动落地; 普通人类待办(如采购/授权清单里的琐事)也走同一条路 ——
  //   因为它们同样是"只有人能拍板、拍完需要有人去做"。这里不做标题过滤, 但把类型写进描述便于分辨。
  const isDecisionTitle = DECISION_TITLE_RE.test(String(t.title || ""));

  // 路由: 优先闭环回原发起人(若它有执行能力)
  let raiserTier: number | null = null;
  const rawCreatedBy = String(t.createdBy || "");
  const raiserId = /^agent:/i.test(rawCreatedBy) ? rawCreatedBy.slice(6).trim() : (/^platform:/i.test(rawCreatedBy) ? rawCreatedBy.slice(9).trim() : "");
  if (raiserId) {
    try {
      const reg: any[] = await prisma.$queryRawUnsafe("SELECT profile, status FROM AgentRegistry WHERE agent_id=? LIMIT 1", raiserId);
      if (reg && reg.length && String(reg[0].status) === "ACTIVE") {
        let tier: any = null;
        try { tier = JSON.parse(String(reg[0].profile || "{}")).capabilityTier; } catch { tier = null; }
        raiserTier = typeof tier === "number" ? tier : 0;
      }
    } catch { raiserTier = null; }
  }
  const routing = routeDecisionTask({ createdBy: rawCreatedBy, raiserTier, executor: DECISION_EXECUTOR });
  const title = ("[落地] 按人类决策执行: " + String(t.title || "")).replace(/^\[落地\] 按人类决策执行: \[\s*(决策|人类决策|需要人类决策)\s*\]\s*/, "[落地] ").slice(0, 180);

  // 2026-09-14 **定位迁移(阶段5)**: 用户规则"只要不是飞轮中发现的都不是改进任务" ——
  //   人类决策的落地来自**人的决定**, 因此由**待办**承载(原先是改进任务)。
  //   待办需要真执行 -> 由 todo_worker 的 needs_tools 判定自动升级为任务(带 fromTodo 标记)交给执行体,
  //   这正是平台设计的"待办是需求入口, 任务是执行出口"。
  // 2026-09-17 修复(实测: 18 条【落地】待办的"人类决定"内容竟是 402 报错文本):
  //   额度耗尽/限流/连接失败等**错误响应**被采集成了"人类决策", 进而生成落地单 -> 执行体领到的是
  //   一条报错, 既做不了也看不出要干什么(用户实测投诉)。错误/限流/超时文本不是决策: 不生成落地单,
  //   改为把源待办标 BLOCKED 并留痕, 交由人工判断。
  const DECISION_ERROR_RE = /(402|429|Token Plan|用量上限|rate ?limit|quota|Connection refused|ECONNREFUSED|ETIMEDOUT|timed? ?out|空回复|NO_REPLY)/i;
  const decisionText = String(decision || "").trim();
  if (!decisionText || DECISION_ERROR_RE.test(decisionText)) {
    try {
      await todoRepo.run("UPDATE Todo SET status=?, note=COALESCE(note,'')||?, updatedAt=? WHERE id=?",
        "BLOCKED",
        " [2026-09-17 拦截: 决策内容被识别为错误响应(报错/限流/超时), 不是人类决策, 未生成落地单] " + decisionText.slice(0, 120),
        Date.now(), String(t.id));
    } catch { /* 留痕失败不阻塞 */ }
    // 不生成落地单: 返回显式结果(而非 null) 以便调用方与统计能区分"被拦截"与"无数据"
    return { ok: false, reason: "DECISION_TEXT_IS_ERROR_RESPONSE", todoId: t.id };
  }

  // 2026-09-18 机制修复(落地待办 todo_land_jvijaydsfs4s): 建落地单前做**跨来源**去重 ——
  //   同一句人类决定 + 同一来源问题已有落地待办时, 复用而不是再建一张。
  //   实测: 三张孪生决策卡(tzmz8ljjvqai/tzmzhlx6f3kf/tzmzyh0ba9v6, 同一句「重复内容需要清理」)
  //   各自派生了一张【落地】待办(uvit/jvijay/zkrie) —— 平台自己成了重复内容产源。
  {
    const { shouldReuseLandingTodo } = await import("./dup-content-guard");
    const reuse = shouldReuseLandingTodo({ decisionText: decision, sourceTitle: t.title, existing: await loadExistingLandingTodos() });
    if (reuse.reuse) {
      const meta0 = parseMeta(t.meta);
      meta0.followUpTaskId = reuse.existingId;
      meta0.followUpTodoId = reuse.existingId;
      meta0.followUpDecision = decision;
      meta0.followUpAt = new Date().toISOString();
      meta0.landingDedupedTo = reuse.existingId;
      meta0.landingDedupReason = reuse.reason;
      await todoRepo.run("UPDATE Todo SET meta = ?, updatedAt = ? WHERE id = ?", JSON.stringify(meta0), Date.now(), String(t.id));
      await prisma.flywheelEvent.create({
        data: { stage: "HUMAN_DECISION_LANDING_DEDUPED", sourceType: "todo", sourceId: String(t.id),
          sourceTitle: ("decision by " + doneBy + " -> 复用已有落地待办 " + reuse.existingId + ": " + reuse.reason).slice(0, 300), targetStage: "OK" },
      }).catch(() => null);
      return { ok: true, todoId: t.id, followUpTaskId: reuse.existingId, dedupedToExistingLanding: true, reason: "DEDUPED_TO_EXISTING_LANDING" };
    }
  }

  const landingTodoId = "todo_land_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const landingDetail = [
    "【人类决定】" + decision,
    "【决定人】" + doneBy + (decidedByKind === "auto-8d" ? " (人类超时未决, 平台按 8 维审视自动决策; 人类可随时覆盖)" : "")
      + (t.doneAt ? " @ " + new Date(Number(t.doneAt)).toISOString() : ""),
    "【原待办】" + String(t.title || "") + " (todo " + t.id + ")",
    t.detail ? "【待办详情】" + String(t.detail).slice(0, 1200) : "",
    "【要做什么】按上述决定执行到底, 并给出**可复现证据**(命令/查询/commit/文件行号); 决定里若包含选项, 以决定为准, 不要自行改选。",
    "【做不到就明说】需要人再拍板的部分写清卡点, 不要用'建议'充数。",
    "【路由说明】" + routing.reason,
    "",
    "本待办需要工具能力(改代码/改配置/部署/执行命令): 需要真实落地动作, 不是给建议。",
  ].filter(Boolean).join("\n").slice(0, 6000);
  {
      await todoRepo.run("INSERT INTO Todo (id,title,detail,source,sourceRefId,ownerType,ownerId,status,priority,evidence,note,createdBy,createdAt,updatedAt,meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        landingTodoId, title.replace("[落地]", "【落地】"), landingDetail,
             "human-decision:landing", String(t.id), "agent", routing.assignedAgent, "OPEN", "P1",
             "decision-todo:" + t.id, null, "system:human-decision-consumer", Date.now(), Date.now(),
             JSON.stringify({ kind: "HUMAN_DECISION_LANDING", decisionTodoId: t.id, decisionBy: doneBy, decidedByKind,
                              raisedBy: routing.raisedBy, routingKind: routing.kind, routingReason: routing.reason,
                              needsTools: true, decisionText: decision.slice(0, 1200), sourceQuestion: String(t.title || "") }));
  }
  const task = { id: landingTodoId };   // 兼容下方既有引用(落地载体现为**待办**)
  void isDecisionTitle; void raiserTier;

  meta.followUpTaskId = task.id;   // 字段名沿用(历史数据兼容); 语义现为"落地**待办** id"
  meta.followUpTodoId = task.id;
  meta.followUpDecision = decision;
  meta.followUpAt = new Date().toISOString();
  {
    await todoRepo.run("UPDATE Todo SET meta = ?, updatedAt = ? WHERE id = ?", JSON.stringify(meta), Date.now(), String(t.id));
  }

  await prisma.flywheelEvent.create({
    data: {
      stage: "HUMAN_DECISION_CONSUMED",
      sourceType: "todo", sourceId: t.id,
      sourceTitle: ("decision by " + doneBy + " -> 待办落地 " + task.id + " [" + routing.kind + " -> " + routing.assignedAgent + "]: " + decision.slice(0, 100)).slice(0, 300),
      targetStage: "OK",
    },
  }).catch(() => null);

  // 发起人能感知: 把"决定 + 落地任务 + 谁接手"写回**讨论串**。
  //   - 来自讨论的待办 -> 回写该讨论串;
  //   - 来自任务的待办(sourceRefId 是 taskId) -> 回写**原任务的讨论串**, 发起人/后来者都能在原帖看到结果。
  //   这样即使发起人是 T0/T1 文本通道(接不了执行活), 它也能在自己的上下文里看到"决定已下、由谁落地"。
  let wroteBack = false;
  try {
    if (String(t.source || "") === "discussion" && t.sourceRefId) {
      // 2026-10-23 P5: 讨论表走 runtime-repo（跟随 sqlite/dual/pg 模式）
      const desc: any = await runtimeRepo.get("SELECT entityType, entityId FROM Discussion WHERE id = ?", String(t.sourceRefId));
      if (desc) {
        const entityType = desc.entityType, entityId = desc.entityId;
        await runtimeRepo.run("INSERT INTO Discussion (id, entityType, entityId, authorType, authorId, kind, body, replyToId, taskId, meta, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          "dsc_hd_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          String(entityType), String(entityId), "platform", "platform", "event",
          "【人类已决定】" + decision + "\n【已生成落地**待办**】" + task.id + " (接手: " + routing.assignedAgent + " · " + routing.reason + ")",
          String(t.sourceRefId), task.id, JSON.stringify({ decisionTodoId: t.id, followUpTaskId: task.id }), Date.now());
        wroteBack = true;
      }
    }
    else if (String(t.sourceRefId || "").trim()) {
      const src = String(t.sourceRefId).trim();
      await runtimeRepo.run("INSERT INTO Discussion (id, entityType, entityId, authorType, authorId, kind, body, replyToId, taskId, meta, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        "dsc_hd_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        "task", src, "platform", "platform", "event",
        "【人类已决定】" + decision + "\n【落地任务】" + task.id + " · 接手方 " + routing.assignedAgent + "(" + routing.reason + ")",
        null, task.id,
        JSON.stringify({ decisionTodoId: t.id, followUpTaskId: task.id, raisedBy: routing.raisedBy, routingKind: routing.kind }),
        Date.now());
      wroteBack = true;
    }
  } catch { /* 讨论回写失败不影响建单 */ }

  return { ok: true, todoId: t.id, followUpTaskId: task.id, wroteBackToDiscussion: wroteBack };
}
