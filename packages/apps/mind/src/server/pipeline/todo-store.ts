import { todoRepo } from "@/server/lib/todo-repo";

/**
 * 2026-09-10 TODO 独立实体存储层 (被 todos 路由 / tasks.submit 自动生成 共用)
 * 表结构改动只在这里改一处。
 */
const TABLE = "Todo";

export const TODO_DDL =
  "CREATE TABLE IF NOT EXISTS " + TABLE + " (" +
  "id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT, source TEXT NOT NULL, sourceRefId TEXT, " +
  "ownerType TEXT NOT NULL, ownerId TEXT, status TEXT NOT NULL, priority TEXT NOT NULL, " +
  "dueAt INTEGER, evidence TEXT, note TEXT, createdBy TEXT, createdAt INTEGER NOT NULL, " +
  "updatedAt INTEGER NOT NULL, doneAt INTEGER, doneBy TEXT, meta TEXT)";

/** 2026-10-26 SQLite 退役(P3): Todo 表已在 PG，DDL/句柄不再是运行时职责。 */
export async function openTodoDb() {
  return null;
}

export type TodoInput = {
  id?: string; title: string; detail?: string | null; source?: string; sourceRefId?: string | null;
  ownerType?: "human" | "agent"; ownerId?: string | null; status?: string; priority?: string;
  dueAt?: number | null; evidence?: string | null; createdBy?: string;
  /** 结构化元数据(如 needsTools/fromFinding/findingKey); 字符串原样落库, 对象序列化后落库 */
  meta?: string | Record<string, any> | null;
};

export async function createTodo(input: TodoInput): Promise<{ id: string } | null> {
  try {
    const now = Date.now();
    const id = input.id || ("todo_" + Math.random().toString(36).slice(2, 12) + now.toString(36).slice(-6));
    const meta = input.meta == null ? null : (typeof input.meta === "string" ? input.meta : JSON.stringify(input.meta));
    // 2026-10-23 P1: 写路径改走 todo-repo（sqlite/dual/pg 三模式，秒级回退）。
    //   INSERT OR REPLACE 在 PG 是语法错(42601) —— 改成两端都支持的 upsert。
    //   SQLite >= 3.24 与 PG >= 9.5 同语法(已实测 sqlite 3.45.1 通过)。
    await todoRepo.run(
      "INSERT INTO " + TABLE +
      " (id,title,detail,source,sourceRefId,ownerType,ownerId,status,priority,dueAt,evidence,note,createdBy,createdAt,updatedAt,doneAt,doneBy,meta)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)" +
      " ON CONFLICT (id) DO UPDATE SET title=excluded.title, detail=excluded.detail, source=excluded.source," +
      " sourceRefId=excluded.sourceRefId, ownerType=excluded.ownerType, ownerId=excluded.ownerId, status=excluded.status," +
      " priority=excluded.priority, dueAt=excluded.dueAt, evidence=excluded.evidence, note=excluded.note," +
      " createdBy=excluded.createdBy, createdAt=excluded.createdAt, updatedAt=excluded.updatedAt," +
      " doneAt=excluded.doneAt, doneBy=excluded.doneBy, meta=excluded.meta",
      id, String(input.title).slice(0, 300), input.detail ? String(input.detail).slice(0, 4000) : null,
      String(input.source || "system").slice(0, 40), input.sourceRefId ? String(input.sourceRefId).slice(0, 120) : null,
      input.ownerType === "agent" ? "agent" : "human", input.ownerId ? String(input.ownerId).slice(0, 80) : null,
      ["OPEN", "DOING", "BLOCKED", "DONE", "DROPPED"].includes(String(input.status)) ? String(input.status) : "OPEN",
      ["P0", "P1", "P2"].includes(String(input.priority)) ? String(input.priority) : "P2",
      input.dueAt ?? null, input.evidence ? String(input.evidence).slice(0, 2000) : null, null,
      String(input.createdBy || "system").slice(0, 80), now, now, null, null, meta
    );
    return { id };
  } catch { return null; }
}

/**
 * 人类决策标记识别 — 2026-09-14 **死循环根因修复**
 *
 * 旧实现: `if (!/\[需要人类决策\]|需要人类决策/.test(output)) return null;`
 *   是**子串匹配**: 它把否定结论里的 `需要人类决策`(如 `不需要人类决策`)也当成正命中。
 *   实测链路(本次 8 维审视的对象):
 *     task cmu10mq4t0397ki4av923py86(DISCUSSION_QUESTION 答复, 结论「这个任务不需要你做任何事…
 *       平台已自动判定"不需要人类决策"」)于 2026-09-14T16:41:26Z 提交
 *     -> 误派生人类决策待办 todo_task_97ki4av923py86
 *     -> 39 分钟后 auto-decide 又开 8 维审视任务 cmu1idcgq056uki4akaljk8aa(本任务)。
 *   若不修: 本任务提交的报告里同样出现「不需要人类决策」, 会再派生新待办 -> 30 分钟超时 -> 再开审视任务, 无限自转。
 *
 * 新规则(两条, 均排除否定语境):
 *   A. 显式方括号标记 `[需要人类决策]` —— 平台协议(goal-gap 明确要求"请在输出中标注")的强标记 -> 命中;
 *   B. 裸词 `需要人类决策` —— 仅在**指令位**(行首 / `-` `*` `>` `•` 列表符后 / `:` 冒号后)出现才算命中,
 *      避免散文、复盘、引述里的同名字样误命中。
 *   两者都排除紧邻的否定词(不/无/毋/免/否/别 以及 不是/并非/绝非/拒绝/避免/反对/无需/毋需)。
 */
const NEG_BEFORE_RE = /(?:不|无|毋|免|否|别)\s*$/;
const NEG_PHRASE_RE = /(?:不是|并非|绝非|拒绝|避免|反对|无需|毋需)\s*$/;
const DIRECTIVE_PUNCT = new Set(["*", "-", ">", "•", ":", "："]);

function isNegatedContext(s: string, index: number): boolean {
  const before = s.slice(Math.max(0, index - 8), index);
  return NEG_BEFORE_RE.test(before) || NEG_PHRASE_RE.test(before);
}

/** 判断文本是否真的在"要求人类决策"(否定语境不算)。纯函数, 便于回归测试。 */
export function needsHumanDecision(text: string): boolean {
  const s = String(text || "");
  let m: RegExpExecArray | null;
  // A. 显式方括号标记: 强命中(仍排除被否定的引述)
  const tagRe = /\[需要人类决策\]/g;
  while ((m = tagRe.exec(s)) !== null) {
    if (!isNegatedContext(s, m.index)) return true;
  }
  // B. 裸词: 仅"指令位"命中
  const bareRe = /需要人类决策/g;
  while ((m = bareRe.exec(s)) !== null) {
    if (isNegatedContext(s, m.index)) continue;
    const before = s.slice(0, m.index).replace(/\s+$/, "");
    if (before.length === 0) return true;
    if (DIRECTIVE_PUNCT.has(before[before.length - 1])) return true;
  }
  return false;
}

/** 从任务产出里识别 [需要人类决策] 并转成人类待办 */
export async function createHumanTodoFromTaskOutput(opts: { taskId: string; taskTitle: string; agentId: string; output: string }) {
  if (!needsHumanDecision(opts.output)) return null;
  const lines = opts.output.split("\n").filter((l) => needsHumanDecision(l) || /授权|采购|业务决策|审批/.test(l)).join("\n").slice(0, 1500);
  // 2026-10-22 旧格式根因修复(清理批次 verification/legacy-human-todos-cleanup-2026-10-22):
  //   旧实现写裸标题 "[人类决策] <任务标题>"、meta 为 NULL —— 决策卡 UI 依赖 meta.kind=HUMAN_DECISION_CARD 渲染,
  //   meta 为空就退化成"技术黑话待办"。历史几轮修的都是别的生产者(reconcile-findings / execute-improving-task),
  //   这条**共享存储入口**一直没动, 于是每调用一次就又落一条旧格式。
  //   现在: 标题/正文统一走决策卡语言层(business 语言 + ①~⑤), meta 带 HUMAN_DECISION_CARD 与来源任务。
  const { buildBusinessDecisionCard } = await import("./decision-card-language");
  const card = buildBusinessDecisionCard({
    sourceTitle: opts.taskTitle,
    decision: lines || opts.output.slice(0, 1500),
    sourceTodoId: opts.taskId,
  });
  const detail =
    card.businessText +
    "\n\n【技术细节(可跳过)】\n- 原始来源: agent " + opts.agentId + " 在任务 " + opts.taskId + " 中标注需要人类决策\n- 原文摘录:\n" +
    (lines || opts.output.slice(0, 800));
  return createTodo({
    id: "todo_task_" + opts.taskId.slice(-14),
    title: card.title,
    detail,
    // 2026-09-14 用户反馈: 人类待办必须指派到具体的人 —— ownerId=null 时它既不在任何人的清单里,
    //   也没人知道该谁做(实测 14 条 OPEN 全是"未指派")。运营者身份可用 HUMAN_OPERATOR 覆盖。
    source: "goal_gap", sourceRefId: opts.taskId, ownerType: "human",
    ownerId: process.env.HUMAN_OPERATOR || "operator",
    priority: "P1", evidence: "task:" + opts.taskId, createdBy: "agent:" + opts.agentId,
    meta: {
      kind: "HUMAN_DECISION_CARD",
      sla: "APPLY_P1",
      theme: opts.taskTitle.slice(0, 60),
      businessDomain: card.domain,
      cueKind: card.cueKind,
      sourceTaskId: opts.taskId,
      viaTask: opts.taskId,
      fromTaskOutput: true,
    },
  });
}

