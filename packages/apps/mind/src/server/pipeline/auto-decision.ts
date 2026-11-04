/**
 * auto-decision.ts — 「8 维审视」产出里 AUTO_DECISION 行的解析、判定与写回 (2026-09-18)
 *
 * 背景(实测缺陷, 原待办 todo_9d970d7bb32e4a13909a -> 落地待办 todo_land_cpq1bwkv4731):
 *   `tasks/submit` 在任务 kind=HUMAN_DECISION_REVIEW 时, 原来这样取"人类决定":
 *     const m = output.match(/AUTO_DECISION\s*[:：]\s*(.+?)(?:\n|$)/);
 *     const decision = (m ? m[1] : output.slice(0, 300)).trim();
 *   —— 没有 AUTO_DECISION 行时**用 output 前 300 字兜底当决策**。实测后果:
 *     · todo_land_cpq1bwkv4731 的【人类决定】= `{"decisionTodoId":"todo_...","waitedMinutes":77,...}`(材料 JSON 回显);
 *     · todo_land_1eclqh4e8eqk 的【人类决定】= `"todo_d635...\",\"waitedMinutes\":77,...`(JSON 残片);
 *     · todo_land_ib3dyd692eq1 的【人类决定】= `dsh: RATE_LIMIT: 429: {"code":"AccountQuotaExceeded"...}`(报错原文)。
 *   这些"伪决策"把人类待办结单(doneBy=system:auto-decision-8d), 再经 human-decision-consumer 生成伪落地待办,
 *   落地待办又被升级成任务 -> 重复劳动(用户原话: "已处理过的为什么还是会出任务让我决策?")。
 *
 * 修法: 只有**显式 AUTO_DECISION 行**才算决策。解析不出该行(或其内容是材料 JSON / 上下文回显)时,
 *   applyAutoDecisionToTodo() 把源待办标 BLOCKED 并留痕(AUTO_DECISION_MISSING), **不结单、不生成落地单**。
 *
 * 可测: 纯函数见 scripts/test-auto-decision-parse.ts; 写回逻辑(真库快照)见 scripts/test-auto-decision-apply.ts。
 */
import { openMindDb } from "@/server/lib/open-mind-db";
import { todoRepo } from "@/server/lib/todo-repo";

/** 匹配 `AUTO_DECISION: <一句话>`; 行尾兼容真实换行与字面量 `\n`(agent 回显材料时常见)。 */
const AUTO_DECISION_RE = /AUTO_DECISION\s*[:：]\s*([\s\S]*?)(?:\r?\n|\\n|$)/g;

/**
 * 提示词模板占位符(复核 C3/C4 后收窄): 模板原话只有**出现在尖括号里**才算占位,
 * 否则会误伤 "讨论了 平台可立即执行的动作 的语义" 这类正常决策。
 */
const TEMPLATE_PLACEHOLDER_RE = /[<＜][^>＞]*(平台可立即执行的动作|一句话说明要人拍板什么|一句话理由)[^>＞]*[>＞]/;
/** 整条决策就是一个尖括号占位(如 `<平台可立即执行的动作, 一句话>`); "关单; <已完成>" 不命中。 */
const WHOLE_PLACEHOLDER_RE = /^\s*[<＜][^>＞]{1,200}[>＞]\s*$/;

/** 材料 JSON / 上下文回显的特征键(出现在"决策"里即说明这是回显, 不是决策)。 */
const MATERIALS_KEY_RE = /(decisionTodoId|waitedMinutes|timeoutMin|autoReviewTaskId)/;
/** human-decision-consumer 注入上下文的固定分隔串。 */
const CONTEXT_ECHO_RE = /(平台记忆注入|本条决策的上下文|本次注入记忆)/;

export type AutoDecisionParse =
  | { ok: true; decision: string; reason: "OK" }
  | { ok: false; decision: ""; reason: "NO_AUTO_DECISION_LINE" | "EMPTY_DECISION" | "NON_DECISION_TEXT"; detail: string };

/**
 * 判定一段文本是否是"材料 JSON / 上下文回显 / prompt 模板占位"而非真正的人类决定。
 * 例: `{"decisionTodoId":"todo_x","waitedMinutes":77,...}`、
 *     `"todo_x\",\"waitedMinutes\":77,...`、`...=== 平台记忆注入 ...`、
 *     `<平台可立即执行的动作, 一句话>`(任务提示词模板)。
 */
export function isNonDecisionText(text: string | null | undefined): boolean {
  const d = String(text ?? "").trim();
  if (!d) return true;
  if (CONTEXT_ECHO_RE.test(d)) return true;
  // 整条就是一个尖括号占位 / 尖括号里是提示词模板原话 -> 不是决策(普通 <已完成> 之类不误伤)
  if (WHOLE_PLACEHOLDER_RE.test(d)) return true;
  if (TEMPLATE_PLACEHOLDER_RE.test(d)) return true;
  // JSON 感(以 { " [ 或转义引号开头/结尾) 且含材料键 -> 材料回显
  const jsonish = /^[{[\]"\\]/.test(d) || /\\"/.test(d) || /^"\s*todo_/.test(d);
  if (jsonish && MATERIALS_KEY_RE.test(d)) return true;
  return false;
}

/**
 * 从 8 维审视任务的 output 里解析 AUTO_DECISION。
 * 规则: 取**最后一条** AUTO_DECISION 行(硬性输出格式要求"最后必须单独一行"; 取最后一条可跳过 agent 回显的
 *   提示词模板行); 无该行 -> NO_AUTO_DECISION_LINE; 该行为空 -> EMPTY_DECISION;
 *   该行内容是材料回显/模板占位 -> NON_DECISION_TEXT。三种失败情况都**不是**可执行决策。
 */
export function extractAutoDecision(output: string | null | undefined): AutoDecisionParse {
  const out = String(output ?? "");
  const matches = [...out.matchAll(AUTO_DECISION_RE)];
  if (!matches.length) return { ok: false, decision: "", reason: "NO_AUTO_DECISION_LINE", detail: out.replace(/\s+/g, " ").slice(0, 160) };
  const decision = matches[matches.length - 1][1].trim();
  if (!decision) return { ok: false, decision: "", reason: "EMPTY_DECISION", detail: "" };
  if (isNonDecisionText(decision)) return { ok: false, decision: "", reason: "NON_DECISION_TEXT", detail: decision.slice(0, 160) };
  return { ok: true, decision, reason: "OK" };
}

export type ApplyAutoDecisionResult =
  | { ok: true; decision: string; changed: boolean }
  | { ok: false; reason: "NO_AUTO_DECISION_LINE" | "EMPTY_DECISION" | "NON_DECISION_TEXT"; noteWritten: boolean };

/**
 * 把一次 8 维审视产出的"决策"应用到源人类待办(只在 tasks/submit 的 HUMAN_DECISION_REVIEW 分支调用)。
 *
 *   · 有合法 AUTO_DECISION 行 -> status=DONE, doneBy=system:auto-decision-8d, note=决策文本(旧行为不变);
 *   · 没有 / 内容是材料回显 -> status=BLOCKED + note/evidence 留痕 + FlywheelEvent(AUTO_DECISION_MISSING),
 *     **不结单**; 调用方据此跳过 human-decision-consumer, 从源头杜绝"伪落地单"。
 *
 * 用 better-sqlite3(与 tasks/submit 原实现一致): Todo 是运行期自建表, Prisma 读它会报 Raw query failed。
 */
export async function applyAutoDecisionToTodo(opts: {
  dbPath: string;
  todoId: string;
  taskId: string;
  agentId: string;
  output: string;
  now?: number;
}): Promise<ApplyAutoDecisionResult> {
  const parsed = extractAutoDecision(opts.output);
  const now = opts.now ?? Date.now();

  const db = openMindDb({ role: "direct-rw", dbPath: opts.dbPath, caller: "auto-decision" });

  try {
    if (parsed.ok) {
      const decision = parsed.decision.trim().slice(0, 800);
      // 2026-10-23 P1: Todo 写走 todo-repo（sqlite/dual/pg）
      const r = await todoRepo.run("UPDATE Todo SET status='DONE', doneAt=?, doneBy=?, note=?, evidence=?, updatedAt=? WHERE id=? AND status='OPEN'",
        now, "system:auto-decision-8d", decision,
             ("8 维审视自动决策(人类未在时限内决策)。决策依据来源: file:packages/apps/mind/src/server/pipeline/auto-decision.ts (applyAutoDecision, 8 维审视); " +
              "复算入口: cmd: node scripts/... 或 POST /api/v1/flywheel/todos (doneBy=system:auto-decision-8d) ; 原始裁定: " + opts.output.slice(0, 3000)), now, opts.todoId);
      return { ok: true, decision, changed: r.changes === 1 };
    }
    const r = await todoRepo.run("UPDATE Todo SET status='BLOCKED', note=COALESCE(note,'')||?, evidence=?, updatedAt=? WHERE id=? AND status IN ('OPEN','DOING')",
      " [2026-09-18 机制修复: 8 维审视任务 " + opts.taskId + " 未产出 AUTO_DECISION 行(原因=" + parsed.reason + "), 平台拒绝把它当人类决策 -> 不结单、不生成落地单]",
           ("8 维审视任务 " + opts.taskId + " 提交于 " + new Date(now).toISOString() + "(by " + opts.agentId + ") 但输出无有效 AUTO_DECISION 行(原因=" + parsed.reason +
            "); 未把该输出当决策。输出节选: " + opts.output.slice(0, 1200)), now, opts.todoId);
    if (r.changes === 1) {
      db.prepare("INSERT INTO FlywheelEvent (id,stage,sourceType,sourceId,sourceTitle,targetStage,createdAt) VALUES (?,?,?,?,?,?,?)")
        .run("ad_" + now.toString(36) + Math.random().toString(36).slice(2, 8), "AUTO_DECISION_MISSING", "todo", opts.todoId,
             ("8 维审视任务无有效 AUTO_DECISION 行(原因=" + parsed.reason + "), 拒绝结单/拒绝生成落地单").slice(0, 300), "FAIL", now);
    }
    return { ok: false, reason: parsed.reason, noteWritten: r.changes === 1 };
  } finally {
    db.close();
  }
}
