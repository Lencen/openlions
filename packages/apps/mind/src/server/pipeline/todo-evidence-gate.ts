/**
 * todo-evidence-gate.ts — 待办结单「证据预检」的唯一权威实现 (2026-09-18)
 *
 * 为什么需要把这段逻辑抽出来当单一来源(任务 cmu5mfcf00007ni3k32c7ldbs):
 *   2026-09-17 c410b2d 给 **PATCH /api/v1/flywheel/todos** 加了结单证据预检, 但
 *   **POST /api/v1/flywheel/todos/submit** (agent 回执的正式入口, 见 scripts/macs-responder/todo_worker.py)
 *   没有同等门槛 —— 于是"通道回执型 DONE"换个入口照样能结: agent-operator 的假完成单
 *   (todo_d9c01e32a75e40fea1a2 的承接输出自证"本通道 0 工具, 未跑任何命令") 系统照样收 DONE,
 *   给出 NO_VERDICT, 直接制造"任务 DONE 但验收无证据"的假象。
 *   两处各写一段正则/长度判断必然漂移(仓库已经吃过分叉的亏), 所以抽成本模块:
 *   PATCH 与 submit 都调用 `checkTodoCloseEvidence`, 由 scripts/test-todo-close-evidence-gate.ts
 *   守住"两个入口口径一致 + 通道回执被拒"。
 *
 * 规则(与 PATCH 既有行为逐字一致, 不改口径):
 *   agent 把待办置 DONE 时, evidence 必须 >= 120 字 **且** 至少含一个可复算锚点
 *   (file:/cmd:/sql:/commit/仓库路径/7位以上 hex)。人类结单不受限(actor.kind=human)。
 *   环境变量 TODO_EVIDENCE_GATE=0 可整体关闭(逃生口, 默认开)。
 */

/** 结单证据最小长度(字)。 */
export const TODO_EVIDENCE_MIN_LEN = 120;

/**
 * 可复算锚点判据 —— 与 PATCH 路由原实现完全一致, 移到这里只改一处。
 * 命中任意一项即视为"有可复算锚点": file:/cmd:/sql: 前缀, 仓库相对路径, 7-40 位 hex(commit)。
 */
export const TODO_EVIDENCE_ANCHOR_RE =
  /(file:\s*\S+|cmd:\s*\S+|sql:\s*\S+|scripts\/[\w./-]+|packages\/[\w./-]+|docs\/[\w./-]+|\b[0-9a-f]{7,40}\b|git\s+\S+|curl\s+http|node\s+scripts\/|node\s+-e)/i;

/**
 * 2026-11-09 P0（缺口 a）：结单证据不得是**通道报错回执**（先判错误，再判长度/锚点）。
 *
 * 根因：TODO_EVIDENCE_ANCHOR_RE 含 `[0-9a-f]{7,40}`（commit 位），而报错回执里的 runId
 *   （如 786f1db9-…）恰好是 7-40 位 hex -> 锚点"命中" -> 报错回执被当成合格证据放行。
 *   实测：近 2h 34 条结单里 32 条是报错证据，其中 28 条就是这样穿过的。
 */
export const ERROR_RECEIPT_PATTERNS: RegExp[] = [
  /does not support the (agent|coding) plan feature/i,
  /API\s+(call\s+)?failed/i,
  /All models fail(ed)?/i,
  /HTTP\s*[45]\d{2}\b/i,
  /RATE_LIMIT|rate[_-]?limit/i,
  /Token Plan|AccountQuotaExceeded|exceeded the monthly usage quota/i,
  /ECONNREFUSED|ETIMEDOUT|socket hang up|timed out/i,
  /"ok"\s*:\s*false/i,
  /Cannot find module|no such table|command not found/i,
  /执行体空输出|\brc\s*=\s*1\b|FAIL:EMPTY/i,
];

/** 负向排除：证据在描述「已修好 / 复现步骤里引用报错」时不算错误回执，避免误伤合格证据。 */
export const ERROR_RECEIPT_NEGATIVE_RE =
  /已修复|修复后|报错消失|已消失|复现步骤|改用|改走|不再报|已恢复|恢复正常|已解决|空内容/;

/** 错误回执分类词表（与 worker 侧 afe4440fa 完全一致，别各造一套）。 */
export type ExternalFaultClass = "MODEL_PLAN" | "QUOTA" | "EXEC" | "OTHER";

export interface ExternalFaultInfo {
  class: ExternalFaultClass;
  signature: string;
  matched: string;
}

/** 分类规则；顺序有意义：先"模型与 plan 不兼容"，再配额，再执行期错误，最后 OTHER 保底。 */
const EXTERNAL_FAULT_CLASS_RULES: Array<{ cls: ExternalFaultClass; sig: string; re: RegExp }> = [
  { cls: "MODEL_PLAN", sig: "plan_feature_unsupported", re: /does not support the (agent|coding) plan feature/i },
  { cls: "MODEL_PLAN", sig: "http_404", re: /HTTP\s*404\b/i },
  { cls: "QUOTA", sig: "quota_429", re: /\b429\b|AccountQuotaExceeded|exceeded the monthly usage quota|Token Plan/i },
  { cls: "QUOTA", sig: "rate_limit", re: /RATE_LIMIT|rate[_-]?limit/i },
  { cls: "EXEC", sig: "exec_empty_output", re: /执行体空输出|\brc\s*=\s*1\b|FAIL:EMPTY/i },
  { cls: "EXEC", sig: "exec_timeout", re: /ETIMEDOUT|timed out|socket hang up|ECONNREFUSED|command failed/i },
  { cls: "EXEC", sig: "api_call_failed", re: /API\s+(call\s+)?failed/i },
  { cls: "EXEC", sig: "all_models_failed", re: /All models fail(ed)?/i },
  { cls: "OTHER", sig: "http_4xx_5xx", re: /HTTP\s*[45]\d{2}\b/i },
  { cls: "OTHER", sig: "ok_false", re: /"ok"\s*:\s*false/i },
  { cls: "OTHER", sig: "module_or_table_missing", re: /Cannot find module|no such table|command not found/i },
];

/** 纯函数：给一段错误回执定 class/signature（供路由写事件的 targetStage）。 */
export function classifyExternalFault(evidence: string, matched?: string): ExternalFaultInfo {
  const ev = String(evidence ?? "");
  for (const r of EXTERNAL_FAULT_CLASS_RULES) {
    const m = ev.match(r.re);
    if (m) return { class: r.cls, signature: r.sig, matched: String(m[0]).slice(0, 120) };
  }
  return { class: "OTHER", signature: "other", matched: String(matched ?? "").slice(0, 120) };
}

/** 纯函数：判断一段结单证据是否其实是通道报错回执（不碰库）。 */
export function detectErrorReceipt(evidence: string): { hit: boolean; matched?: string; externalFault?: ExternalFaultInfo } {
  const ev = String(evidence ?? "");
  if (!ev.trim()) return { hit: false };
  if (ERROR_RECEIPT_NEGATIVE_RE.test(ev)) return { hit: false };
  for (const re of ERROR_RECEIPT_PATTERNS) {
    const m = ev.match(re);
    if (m) return { hit: true, matched: m[0], externalFault: classifyExternalFault(ev, m[0]) };
  }
  return { hit: false };
}

export interface TodoCloseEvidenceCheck {
  ok: boolean;
  /** 未过项(可读); ok=false 时非空。 */
  missing: string[];
  /** 2026-11-09 P0：命中通道错误回执时给出分类（路由用它写 targetStage="EXTERNAL_FAULT:"+class）。 */
  externalFault?: ExternalFaultInfo;
}

/** 纯函数: 校验一段结单证据是否达到"可复算"门槛(不碰库, 便于单测)。 */
export function checkTodoCloseEvidence(evidence: string | null | undefined): TodoCloseEvidenceCheck {
  const ev = String(evidence ?? "").trim();
  const missing: string[] = [];
  // 2026-11-09 P0：错误回执**先判** —— 否则报错里的 runId hex 会命中锚点正则而放行。
  const er = detectErrorReceipt(ev);
  if (er.hit) {
    return { ok: false, missing: ["证据是通道错误回执（EXTERNAL_FAULT）"], externalFault: er.externalFault };
  }
  if (ev.length < TODO_EVIDENCE_MIN_LEN) missing.push("证据长度 " + ev.length + " < " + TODO_EVIDENCE_MIN_LEN + " 字");
  if (!TODO_EVIDENCE_ANCHOR_RE.test(ev)) missing.push("缺可复算锚点(需 file:/cmd:/sql:/commit/仓库路径 之一)");
  return { ok: missing.length === 0, missing };
}

/**
 * 该待办是否属于「取证类」—— 由无工具通道结单前必须先过证据预检。
 *
 * 权威字段是 `Todo.meta.needsTools`(建单方最清楚: scripts/findings-run.cjs 与
 * from-finding 入口都会显式写布尔值)。**不用关键词兜底**: scripts/macs-responder/todo_worker.py
 * 里有一份 Python 关键词镜像, 在 TS 侧再写一份只会两边漂移("工具需求判定"已经吃过这个亏)。
 * 未显式标记(undefined/null/字符串) -> 不做结单预检(非取证类: 收件箱清读、讨论回答等)。
 *
 * 豁免: kind=HUMAN_DECISION_LANDING 的「无需做事」落地单由人类决定驱动, 记录本身就是决定卡,
 *       不是 agent 取证产物 -> 不适用本预检(否则 worker 的 no-action 结单会被反复打回)。
 */
/**
 * 2026-11-09 P0 缺口 b：**结单时**的取证判定（与 isEvidenceRequiredTodo 的区别只在于 meta 为空）。
 *
 * 实测缺口：submit 入口用 isEvidenceRequiredTodo(row.meta)，meta=null 时直接返回 false
 *   -> 闸门不跑（近 2h 34 条里有 4 条这样漏过）。
 * 口径（运营团队 2026-11-09 22:2x 授权）：
 *   · agent 结单且 meta 为空 -> **视为取证类**，走 checkTodoCloseEvidence（fail-closed）
 *   · 人类结单（actor.kind=human）不受限
 *   · meta 非空时语义与 isEvidenceRequiredTodo 完全一致（含 HUMAN_DECISION_LANDING 豁免）
 * 注意：isEvidenceRequiredTodo 本身**不改**，避免影响其它只关心"显式标记"的调用方。
 */
export function isEvidenceRequiredForClose(meta: unknown, actorKind?: string | null): boolean {
  const kind = String(actorKind ?? "").toLowerCase();
  if (kind === "human") return false;
  if (meta === null || meta === undefined) return true;
  if (typeof meta === "string" && !meta.trim()) return true;
  return isEvidenceRequiredTodo(meta);
}

export function isEvidenceRequiredTodo(meta: unknown): boolean {
  let m: any = meta;
  if (typeof meta === "string") {
    try { m = JSON.parse(meta); } catch { return false; }
  }
  if (!m || typeof m !== "object") return false;
  if (String(m.kind || "") === "HUMAN_DECISION_LANDING") return false;
  // 2026-09-18 收口(实测漏洞): 原判据只看 needsTools, 于是**告警单(meta.kind=ALERT)与服务检查单**可以
  //   用 38 字的"通道回执"(evidence="agent=… brain=…")结单 —— 数据质量评审随即把它们判为
  //   "可处置: 占位话术证据"(实测 4 条, 其中 1 条是我自己结的幽灵引用告警)。
  //   这两类待办天然带**可复算条件**(告警=采集器命令读数归零; 服务检查=重跑 service-check 该项转绿),
  //   所以必须给证据。判定仍不看关键词: 由**建单方**显式写 meta.kind(alert-bus 已写 ALERT,
  //   service-check-5h 也已补写 SERVICE_CHECK)。
  const kind = String(m.kind || "");
  if (kind === "ALERT" || kind === "SERVICE_CHECK") return true;
  return m.needsTools === true || m.recomputable === true;
}
