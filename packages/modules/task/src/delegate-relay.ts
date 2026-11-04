/**
 * delegate-relay.ts — `delegate_task` 原地接力 (失败自动重派) 的平台侧封装
 * =====================================================================
 * 需求来源: agent-x P1 #6 (转发自 operator↔agent-d, conv_bb5d4f7066cf msg 29-30)。
 * 待办: `todo_uos20fb_1790047372341_6` / 升级任务 `cmudlzwnn02o2oi311cb7nigd`。
 *
 * ## 为什么在平台侧 (packages/) 而不是 hermes-agent 侧
 * `delegate_task` 工具本体位于 hermes-agent brain (`~/.hermes/hermes-agent/tools/delegate_tool.py`)。
 * agent-x #6 的验收硬指标是 `grep -rn delegate_task packages/` 必须命中重派逻辑 + node 单测,
 * 因此重派策略必须落在 LIONS 仓 packages/ —— 本模块把 brain 返回的失败结果 (含 partial output)
 * 收敛成一次「原 payload + additional_context 重派」的确定性策略。平台侧只负责**策略与包装**,
 * 不复制 brain 的子代理进程管理。平台记忆 cmudsurz603wtoi31ytiw6z57 已拍板此落点。
 *
 * ## 轻量版规则 (本次落地)
 *   1. 仅当 `delegate_task` 返回**非 success** (status=error/failed/timeout, 或带 error 字段, 或抛异常) 时重派;
 *   2. 重派 = 原 payload 原样 (goal/context/tools 不变) + `additional_context`:
 *      { prev_status, prev_error, prev_partial, retry_round, delegation_id, tool: "delegate_task" };
 *   3. hard-cap = 2 次重派 (`maxRetries`, 默认 2); 第 2 次仍失败 -> 不静默、不谎报成功,
 *      返回 `NEEDS_CHECKPOINT_ESCALATION`, 交中期「全量 checkpoint」版本处理;
 *   4. 后台派发 (`dispatchDelegateInBackground`) 不阻塞主线程, timer 已 unref。
 *
 * ## 边界 (诚实披露)
 *   - 本模块是**策略/包装层**, 不实现真正的子代理 spawn; 调用方注入 `delegate` 回调
 *     (brain 的 delegate_task 调用) 后才产生真实重派。等价于 agent-x #9 的 `compressToolResult`
 *     被 harness 复用: 平台给出可复用、可单测的确定性实现。
 *   - `additional_context` 的字段是本次新定的 schema (平台记忆 cmuc5i9nr005d1hqrdr0kp6sc 记录的
 *     "没有现成 schema 需要新定")。键名固定为 prev_error/prev_partial/retry_round/prev_status,
 *     旧调用方不传 additional_context 时行为 = 旧行为 (首次派发完全等价)。
 *   - 不含 LLM 调用、不联网、不落库 (纯函数 + 注入回调), 零新依赖。
 */

import { createHash } from "node:crypto";

/** 工具名字面量。用于 additional_context 标注与验收 grep (agent-x #6 ②)。 */
export const DELEGATE_TASK_TOOL = "delegate_task";

/** brain `delegate_tool.py` 判定为失败的 status 值 (含 timeout, 见其 status/exit_reason 口径)。 */
const FAILED_STATUSES = new Set(["error", "failed", "failure", "timeout", "cancelled", "canceled"]);
/** 明确表示成功的 status 值。 */
const SUCCESS_STATUSES = new Set(["success", "ok", "done", "completed", "succeeded"]);

export type DelegateResultStatus = string;

/** brain 侧 delegate_task 的结果形状 (取实际会用到的字段, 其余透传保留)。 */
export interface DelegateResult {
  status?: DelegateResultStatus;
  error?: string;
  exit_reason?: string;
  summary?: string;
  /** 子代理中途产出的部分输出 (原地接力要注入的关键上下文)。 */
  partial?: string;
  partialOutput?: string;
  output?: string;
  /** brain 收集的 tool-result tail: [{ tool, preview, is_error }]。 */
  tail?: Array<{ tool?: string; preview?: string; is_error?: boolean }> | unknown;
  subagent_id?: string;
  [k: string]: unknown;
}

/** delegate_task 的调用请求 (即"原 payload")。 */
export interface DelegateRequest {
  goal: string;
  context?: string;
  tools?: string[];
  /** 重派时平台注入; 首次派发可为空。 */
  additional_context?: Record<string, unknown>;
  /** 幂等键; 缺省时由 goal+context 派生确定性 id。 */
  delegation_id?: string;
  [k: string]: unknown;
}

/** 重派注入的 additional_context (本次新定的 schema)。 */
export interface DelegateAdditionalContext {
  tool: typeof DELEGATE_TASK_TOOL;
  delegation_id: string;
  retry_round: number; // 1-based (第 1 次重派 = 1)
  prev_status: string;
  prev_error: string;
  prev_partial: string;
}

export interface RelayAttempt {
  /** 0 = 首次派发; 1.. = 第 N 次重派 */
  round: number;
  /** 幂等键: `<delegationId>#r<round>` */
  attempt_key: string;
  request: DelegateRequest;
  result?: DelegateResult;
  ok: boolean;
  error: string;
  partial: string;
}

export type RelayStatus = "DONE" | "NEEDS_CHECKPOINT_ESCALATION" | "SKIPPED_DUPLICATE";

export interface DelegateEscalation {
  reason: "DELEGATE_TASK_RETRIES_EXHAUSTED";
  tool: typeof DELEGATE_TASK_TOOL;
  delegation_id: string;
  max_retries: number;
  prev_status: string;
  prev_error: string;
  prev_partial: string;
  /** 交中期全量 checkpoint 版本 (agent-x #6 已排期)。 */
  checkpoint_required: true;
}

export interface DelegateRelayOutcome {
  status: RelayStatus;
  ok: boolean;
  delegation_id: string;
  /** 实际派发次数 (含首次)。跳过/幂等跳过也会如实计数。 */
  dispatches: number;
  /** 实际发生的重派次数 (= dispatches - 1 当无跳过)。 */
  retries: number;
  result?: DelegateResult;
  history: RelayAttempt[];
  escalation?: DelegateEscalation;
  skip?: { attempt_key: string; reason: string };
}

export interface DelegateRelayPolicy {
  /** 最多重派次数 (hard-cap)。默认 2。0 = 不重派。 */
  maxRetries?: number;
  /** 注入的 partial output 上限 (UTF-8 字节)。默认 4000, 防止部分输出灌爆上下文。 */
  partialMaxBytes?: number;
  /** 成功判定 (可覆盖)。默认见 defaultIsSuccess。 */
  isSuccess?: (result: DelegateResult) => boolean;
  /** 幂等钩子: 返回 false 表示该 attempt_key 已派发过 -> 跳过不重复派发。 */
  shouldDispatch?: (attemptKey: string) => boolean | Promise<boolean>;
  /** 每次派发后的观测回调 (打点/留痕)。 */
  onAttempt?: (attempt: RelayAttempt) => void;
}

/** 由 goal+context 派生确定性 delegation_id (同一逻辑任务多次调用得到同一 id -> 可去重/可追溯)。 */
export function stableDelegationId(request: Pick<DelegateRequest, "goal" | "context" | "delegation_id">): string {
  if (request.delegation_id && String(request.delegation_id).trim()) return String(request.delegation_id);
  const h = createHash("sha1")
    .update(`${request.goal ?? ""}\u0000${request.context ?? ""}`, "utf-8")
    .digest("hex")
    .slice(0, 16);
  return `dlg_${h}`;
}

/** UTF-8 安全截断 (按字节, 不产生半个多字节字符)。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const s = String(text ?? "");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf-8");
  if (buf.length <= maxBytes) return s;
  // 逐码点回退, 保证不切断多字节序列。
  let cut = buf.subarray(0, maxBytes).toString("utf-8");
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  return cut;
}

/** 从 delegate 结果里抽取"上次 partial output"(优先级: partial > partialOutput > output > summary > tail)。 */
export function extractPartial(result: DelegateResult | undefined, maxBytes = 4000): string {
  if (!result || typeof result !== "object") return "";
  const direct = [result.partial, result.partialOutput, result.output, result.summary];
  for (const v of direct) {
    if (typeof v === "string" && v.trim()) return truncateUtf8(v, maxBytes);
  }
  if (Array.isArray(result.tail)) {
    const joined = result.tail
      .map((e) => (e && typeof e === "object" && typeof (e as any).preview === "string" ? (e as any).preview : ""))
      .filter(Boolean)
      .join("\n---\n");
    if (joined.trim()) return truncateUtf8(joined, maxBytes);
  }
  return "";
}

/** 从 delegate 结果里抽取失败原因文本。 */
export function extractError(result: DelegateResult | undefined): string {
  if (!result || typeof result !== "object") return "(no result)";
  const e = result.error ?? result.exit_reason ?? result.summary;
  const s = typeof e === "string" ? e.trim() : "";
  if (s) return s;
  return result.status ? `status=${String(result.status)}` : "(unknown delegate failure)";
}

/** 默认成功判定 (与 brain 的 status 口径对齐: success/ok/done 成功; error/failed/timeout 失败)。 */
export function defaultIsSuccess(result: DelegateResult | undefined): boolean {
  if (!result || typeof result !== "object") return false;
  if (typeof result.error === "string" && result.error.trim()) return false;
  const status = String(result.status ?? "").trim().toLowerCase();
  if (FAILED_STATUSES.has(status)) return false;
  if (SUCCESS_STATUSES.has(status)) return true;
  // 无显式 status: 有内容且非错误 -> 视为成功 (brain 通常会带 status, 这里是容错)。
  return status === "" && extractPartial(result) !== "";
}

/** 构造重派请求: 原 payload 原样 + additional_context (注入失败原因与上次 partial output)。 */
export function buildRedispatchRequest(
  base: DelegateRequest,
  ctx: Omit<DelegateAdditionalContext, "tool">
): DelegateRequest {
  const additional: DelegateAdditionalContext = {
    tool: DELEGATE_TASK_TOOL,
    delegation_id: ctx.delegation_id,
    retry_round: ctx.retry_round,
    prev_status: ctx.prev_status || "unknown",
    prev_error: ctx.prev_error || "(unknown)",
    prev_partial: ctx.prev_partial || "(no partial output captured)",
  };
  return {
    ...base,
    additional_context: {
      ...(base.additional_context ?? {}),
      ...additional,
    },
  };
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 原地接力主循环: 派发 -> 判定 -> 失败则带 additional_context 重派 -> hard-cap 后升级。
 * 永不抛出 (delegate 抛异常按失败处理), 便于在 worker/后台任务里安全调用。
 */
export async function runDelegateTaskWithRelay(
  request: DelegateRequest,
  delegate: (req: DelegateRequest) => Promise<DelegateResult> | DelegateResult,
  policy: DelegateRelayPolicy = {}
): Promise<DelegateRelayOutcome> {
  const maxRetries = clampInt(policy.maxRetries ?? 2, 0, 10);
  const partialMaxBytes = clampInt(policy.partialMaxBytes ?? 4000, 1, 1_000_000);
  const isSuccess = policy.isSuccess ?? defaultIsSuccess;
  const delegationId = stableDelegationId(request);
  const baseRequest: DelegateRequest = { ...request, delegation_id: delegationId };
  const history: RelayAttempt[] = [];

  let dispatches = 0;
  let lastResult: DelegateResult | undefined;
  let lastStatus = "";
  let lastError = "";
  let lastPartial = "";

  for (let round = 0; round <= maxRetries; round++) {
    const attemptKey = `${delegationId}#r${round}`;

    if (policy.shouldDispatch) {
      const allowed = await policy.shouldDispatch(attemptKey);
      if (!allowed) {
        return {
          status: "SKIPPED_DUPLICATE",
          ok: false,
          delegation_id: delegationId,
          dispatches,
          retries: Math.max(0, round),
          result: lastResult,
          history,
          skip: { attempt_key: attemptKey, reason: "attempt already dispatched (idempotent skip)" },
        };
      }
    }

    const req =
      round === 0
        ? baseRequest
        : buildRedispatchRequest(baseRequest, {
            delegation_id: delegationId,
            retry_round: round,
            prev_status: lastStatus,
            prev_error: lastError,
            prev_partial: lastPartial,
          });

    dispatches++;
    let result: DelegateResult;
    try {
      result = (await delegate(req)) as DelegateResult;
    } catch (e) {
      result = { status: "error", error: e instanceof Error ? e.message : String(e) };
    }

    const ok = isSuccess(result);
    lastResult = result;
    lastStatus = String(result?.status ?? (ok ? "success" : "error"));
    lastError = ok ? "" : extractError(result);
    lastPartial = extractPartial(result, partialMaxBytes);

    const attempt: RelayAttempt = {
      round,
      attempt_key: attemptKey,
      request: req,
      result,
      ok,
      error: lastError,
      partial: lastPartial,
    };
    history.push(attempt);
    policy.onAttempt?.(attempt);

    if (ok) {
      return {
        status: "DONE",
        ok: true,
        delegation_id: delegationId,
        dispatches,
        retries: round,
        result,
        history,
      };
    }
  }

  // hard-cap 用尽: 升级, 不静默, 不谎报成功。
  return {
    status: "NEEDS_CHECKPOINT_ESCALATION",
    ok: false,
    delegation_id: delegationId,
    dispatches,
    retries: maxRetries,
    result: lastResult,
    history,
    escalation: {
      reason: "DELEGATE_TASK_RETRIES_EXHAUSTED",
      tool: DELEGATE_TASK_TOOL,
      delegation_id: delegationId,
      max_retries: maxRetries,
      prev_status: lastStatus,
      prev_error: lastError,
      prev_partial: lastPartial,
      checkpoint_required: true,
    },
  };
}

/**
 * wrap: 把裸 delegate 回调包成"带原地接力"的 delegate_task, 供调用方直接替换原工具调用。
 * 平台记忆 cmudsurz603wtoi31ytiw6z57 的"封装 wrap + 重派"即此函数。
 */
export function wrapDelegateTask(
  delegate: (req: DelegateRequest) => Promise<DelegateResult> | DelegateResult,
  policy: DelegateRelayPolicy = {}
): (req: DelegateRequest) => Promise<DelegateRelayOutcome> {
  return (req: DelegateRequest) => runDelegateTaskWithRelay(req, delegate, policy);
}

export interface BackgroundDispatch<T> {
  /** 后台派发结果; 立即返回 handle, 不阻塞调用方。 */
  done: Promise<T>;
  /** 取消 (若尚未开始执行)。 */
  cancel(): void;
}

/**
 * 后台派发: 把一次接力放到下一个 tick 执行并 unref 定时器, 主线程立即拿回控制权。
 * (轻量版规则 4: 用 background dispatch 避免主线程阻塞。)
 */
export function dispatchDelegateInBackground<T>(
  run: () => Promise<T> | T,
  opts: { onSettled?: (result: T) => void; onError?: (err: unknown) => void } = {}
): BackgroundDispatch<T> {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectRef: ((e: unknown) => void) | undefined;
  const done = new Promise<T>((resolve, reject) => {
    rejectRef = reject;
    timer = setTimeout(() => {
      timer = undefined;
      if (cancelled) {
        reject(new Error("delegate background dispatch cancelled"));
        return;
      }
      Promise.resolve()
        .then(run)
        .then((r) => {
          try {
            opts.onSettled?.(r);
          } catch {
            /* onSettled 抛错不影响结果 */
          }
          resolve(r);
        })
        .catch((e) => {
          try {
            opts.onError?.(e);
          } catch {
            /* ignore */
          }
          reject(e);
        });
    }, 0);
    // 不因该定时器阻止进程退出 (worker/cron 场景)。
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      rejectRef?.(new Error("delegate background dispatch cancelled"));
    },
  };
}
