/**
 * todo-writeback-guard.ts — 「任务完成 -> 待办自动结单」的守卫 (2026-09-18)
 *
 * 事故(待办 todo_land_xwpvc44dq7rw / 任务 cmu5m3mc1000tgfvbjyohakqt, 人类决定 B):
 *   源卡 todo_ioxibuijq150454c(主题「自动处理对话的流水线」) 被人类在 2026-09-17T13:09 答复后,
 *   reconcile-findings 又在 16:30 开出重复卡 todo_bf3yge70a95qwmjk(同 businessDomain/cueKind)。
 *   2026-09-17T19:19:10, 与这张卡毫不相干的落地任务 cmu5m1oa100078xd9ojf3zbip(主题=Memory 容量)
 *   提交完成 —— 它的 materials 里只是**作为证据原文**提到了 todo_bf3yge70a95qwmjk / todo_wfkvmykek25qwmid
 *   两个 id, 于是这两张**仍在等人类拍板**的决策卡被 `system:todo-task-writeback` 静默置 DONE:
 *
 *     平台库只读复算(sqlite3 -readonly …/dev.db):
 *       SELECT id,source,doneBy,datetime(doneAt/1000,'unixepoch') FROM Todo
 *        WHERE json_extract(meta,'$.kind')='HUMAN_DECISION_CARD'
 *          AND doneBy='system:todo-task-writeback';
 *       -> todo_wfkvmykek25qwmid|human-decision:card|system:todo-task-writeback|2026-09-17 19:19:10
 *       -> todo_bf3yge70a95qwmjk|human-decision:card|system:todo-task-writeback|2026-09-17 19:19:10
 *       SELECT stage,sourceId,taskId FROM FlywheelEvent WHERE stage='TODO_CLOSED_BY_TASK' … 同 taskId
 *
 * 根因(机制, 非一次特判):
 *   submit/route.ts 的承接待办回写从 materials **自由文本**里正则捞 `todo_xxx`(route.ts:266),
 *   更新时只按 `status IN ('OPEN','DOING','BLOCKED')` 过滤, **不看这条待办是不是"等人拍板的人类决策卡"**。
 *   任务完成 ≠ 人类已决策。任何一份提到某张待办 id 的报告, 都能把那张待办"顺手结掉"。
 *
 * 修法:
 *   回写前逐条读取候选待办的 source/meta, 命中「人类决策卡」一律**不结单**(不改 status/doneAt/doneBy),
 *   只写一条 note 说明"需人类自行拍板", 并记 SKIPPED_CLOSE_HUMAN_CARD 事件; 其余待办照常结单。
 *   判据抽成本模块的纯函数, 可单测(scripts/test-todo-writeback-guard.ts)。
 *
 * 诚实边界:
 *   - 只拦「人类决策卡」这一类(meta.kind=HUMAN_DECISION_CARD 或 source ∈ 人类卡来源)。
 *     承接待办本身是 `human-decision:landing`(kind=HUMAN_DECISION_LANDING) —— 那是"人类决策的落地单",
 *     完成任务就该结, **不拦**, 否则本机制的闭环会断。
 *   - 不改正则捞 id 的兼容逻辑(历史任务依赖它); 只加"这一类不许自动结单"的语义闸。
 */

/** 人类卡来源: reconcile-findings 开的卡 + 自动审视的人审卡。 */
export const HUMAN_CARD_SOURCES = new Set(["human-decision:card", "auto-review:human-only"]);
export const HUMAN_DECISION_CARD_KIND = "HUMAN_DECISION_CARD";

export interface WritebackTodoRow {
  id: string;
  status?: string | null;
  source?: string | null;
  /** Todo.meta: JSON 字符串或已解析对象(生产库读出来是字符串; 单测可直接给对象)。 */
  meta?: unknown;
}

function parseMeta(meta: unknown): any {
  if (meta == null) return {};
  if (typeof meta === "object") return meta;
  try { return JSON.parse(String(meta)); } catch { return {}; }
}

/**
 * 这张待办是不是「仍在等人类拍板的人类决策卡」。
 * 判据只用**结构化**字段(source + meta.kind), 不做标题/正文语义猜测。
 */
export function isPendingHumanDecisionCard(row: WritebackTodoRow | null | undefined): boolean {
  if (!row) return false;
  if (row.source && HUMAN_CARD_SOURCES.has(String(row.source))) return true;
  const m = parseMeta(row.meta);
  return String(m?.kind || "") === HUMAN_DECISION_CARD_KIND;
}

export type WritebackVerdictCode = "CLOSE" | "SKIP_HUMAN_CARD";

export interface WritebackVerdict {
  code: WritebackVerdictCode;
  reason: string;
}

/**
 * 纯判据: 任务完成回写时, 这条待办该不该自动置 DONE。
 * 只有「人类决策卡」不结单; 其余(含 human-decision:landing 落地单)照常结单。
 */
export function writebackCloseVerdict(row: WritebackTodoRow | null | undefined): WritebackVerdict {
  if (isPendingHumanDecisionCard(row)) {
    const m = parseMeta((row as WritebackTodoRow)?.meta);
    return {
      code: "SKIP_HUMAN_CARD",
      reason: "该待办是等人拍板的人类决策卡(source=" + String((row as any)?.source || "")
        + ", kind=" + String(m?.kind || "") + "): 任务完成不等于人类已决策, 拒绝自动结单(需人类自行回复或由决策卡回收机制处置)",
    };
  }
  return { code: "CLOSE", reason: "非人类决策卡, 按承接待办回写规则结单" };
}
