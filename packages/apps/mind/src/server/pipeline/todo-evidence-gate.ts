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

export interface TodoCloseEvidenceCheck {
  ok: boolean;
  /** 未过项(可读); ok=false 时非空。 */
  missing: string[];
}

/** 纯函数: 校验一段结单证据是否达到"可复算"门槛(不碰库, 便于单测)。 */
export function checkTodoCloseEvidence(evidence: string | null | undefined): TodoCloseEvidenceCheck {
  const ev = String(evidence ?? "").trim();
  const missing: string[] = [];
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
