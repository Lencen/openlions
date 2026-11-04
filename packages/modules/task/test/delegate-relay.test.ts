/**
 * delegate-relay.test.ts — agent-x #6 `delegate_task` 原地接力 单测
 *
 * 运行:  node --import tsx --test packages/modules/task/test/delegate-relay.test.ts
 *        (等价: cd packages/modules/task && npm test)
 * 退出码: 非 0 = 有断言失败 (可直接用于 CI/复测)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  DELEGATE_TASK_TOOL,
  stableDelegationId,
  truncateUtf8,
  extractPartial,
  extractError,
  defaultIsSuccess,
  buildRedispatchRequest,
  runDelegateTaskWithRelay,
  wrapDelegateTask,
  dispatchDelegateInBackground,
  type DelegateRequest,
  type DelegateResult,
} from "../src/delegate-relay.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../src/delegate-relay.ts");

type Call = { req: DelegateRequest };

/** 构造一个按脚本返回结果的假 delegate; 记录每次收到的请求。 */
function scriptedDelegate(script: Array<DelegateResult>): { calls: Call[]; fn: (r: DelegateRequest) => DelegateResult } {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    fn: (req: DelegateRequest) => {
      calls.push({ req });
      const out = script[Math.min(i, script.length - 1)];
      i++;
      return out;
    },
  };
}

// ---------------------------------------------------------------- 基本成功路径
test("首次成功 -> DONE, 不重派, 不改 additional_context", async () => {
  const d = scriptedDelegate([{ status: "success", summary: "ok done" }]);
  const out = await runDelegateTaskWithRelay({ goal: "g", context: "c" }, d.fn);
  assert.equal(out.status, "DONE");
  assert.equal(out.ok, true);
  assert.equal(out.dispatches, 1);
  assert.equal(out.retries, 0);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].req.additional_context, undefined, "首次派发不得注入 additional_context");
  assert.equal(d.calls[0].req.goal, "g");
  assert.equal(d.calls[0].req.context, "c");
});

// ---------------------------------------------------- 核心验收: 失败自动重派 + 注入
test("失败 -> 自动重派: 原 payload 不变 + additional_context 注入失败原因与上次 partial output", async () => {
  const d = scriptedDelegate([
    { status: "error", error: "ReferenceError: r is not defined", partial: "WROTE file a.ts\nSTARTED server" },
    { status: "success", summary: "recovered" },
  ]);
  const out = await runDelegateTaskWithRelay({ goal: "G", context: "CTX", tools: ["read"] }, d.fn);
  assert.equal(out.status, "DONE");
  assert.equal(out.dispatches, 2, "应发生 1 次重派");
  assert.equal(out.retries, 1);
  assert.equal(d.calls.length, 2);

  const first = d.calls[0].req;
  const second = d.calls[1].req;
  // 原 payload 原样
  assert.equal(second.goal, "G");
  assert.equal(second.context, "CTX");
  assert.deepEqual(second.tools, ["read"]);
  // additional_context 注入
  const ac = second.additional_context as Record<string, unknown>;
  assert.ok(ac, "重派必须带 additional_context");
  assert.equal(ac.tool, DELEGATE_TASK_TOOL);
  assert.equal(ac.retry_round, 1);
  assert.equal(ac.prev_status, "error");
  assert.equal(ac.prev_error, "ReferenceError: r is not defined");
  assert.equal(ac.prev_partial, "WROTE file a.ts\nSTARTED server");
  assert.equal(ac.delegation_id, out.delegation_id);
  // 首次派发不得带 additional_context
  assert.equal(first.additional_context, undefined);
});

test("timeout 视为失败并重派 (brain exit_reason=timeout 口径)", async () => {
  const d = scriptedDelegate([
    { status: "timeout", exit_reason: "timeout after 600s", partial: "half done" },
    { status: "success", summary: "ok" },
  ]);
  const out = await runDelegateTaskWithRelay({ goal: "g" }, d.fn);
  assert.equal(out.retries, 1);
  const ac = d.calls[1].req.additional_context as Record<string, unknown>;
  assert.equal(ac.prev_status, "timeout");
  assert.equal(ac.prev_error, "timeout after 600s");
  assert.equal(ac.prev_partial, "half done");
});

test("delegate 抛异常 -> 按失败处理并重派, 不向外抛", async () => {
  let n = 0;
  const calls: DelegateRequest[] = [];
  const fn = (req: DelegateRequest) => {
    calls.push(req);
    n++;
    if (n === 1) throw new Error("boom");
    return { status: "success" } as DelegateResult;
  };
  const out = await runDelegateTaskWithRelay({ goal: "g" }, fn);
  assert.equal(out.status, "DONE");
  assert.equal(out.dispatches, 2);
  const ac = calls[1].additional_context as Record<string, unknown>;
  assert.equal(ac.prev_error, "boom");
  assert.equal(ac.prev_partial, "(no partial output captured)");
});

// ---------------------------------------------------------------- hard-cap / 升级
test("hard-cap: 默认重派 2 次后仍失败 -> NEEDS_CHECKPOINT_ESCALATION (不谎报成功)", async () => {
  const d = scriptedDelegate([{ status: "failed", error: "e1", partial: "p1" }]);
  const out = await runDelegateTaskWithRelay({ goal: "g" }, d.fn);
  assert.equal(out.status, "NEEDS_CHECKPOINT_ESCALATION");
  assert.equal(out.ok, false);
  assert.equal(out.dispatches, 3, "首次 + 2 次重派 = 3");
  assert.equal(out.retries, 2);
  assert.equal(out.history.length, 3);
  assert.equal(d.calls.length, 3);
  // retry_round 递增 1,2
  assert.equal((d.calls[1].req.additional_context as any).retry_round, 1);
  assert.equal((d.calls[2].req.additional_context as any).retry_round, 2);
  // 升级包必须带原因+partial, 供中期全量 checkpoint 版本续跑
  assert.ok(out.escalation);
  assert.equal(out.escalation!.checkpoint_required, true);
  assert.equal(out.escalation!.reason, "DELEGATE_TASK_RETRIES_EXHAUSTED");
  assert.equal(out.escalation!.tool, DELEGATE_TASK_TOOL);
  assert.equal(out.escalation!.prev_error, "e1");
  assert.equal(out.escalation!.prev_partial, "p1");
  assert.equal(out.escalation!.max_retries, 2);
});

test("maxRetries=0 -> 只派发 1 次即升级", async () => {
  const d = scriptedDelegate([{ status: "error", error: "x" }]);
  const out = await runDelegateTaskWithRelay({ goal: "g" }, d.fn, { maxRetries: 0 });
  assert.equal(out.dispatches, 1);
  assert.equal(out.status, "NEEDS_CHECKPOINT_ESCALATION");
});

test("maxRetries=1 -> 首次+1 次重派", async () => {
  const d = scriptedDelegate([{ status: "error", error: "x" }]);
  const out = await runDelegateTaskWithRelay({ goal: "g" }, d.fn, { maxRetries: 1 });
  assert.equal(out.dispatches, 2);
  assert.equal(out.retries, 1);
});

test("maxRetries 非法值被夹紧 (负数->0, 超大->10)", async () => {
  const d1 = scriptedDelegate([{ status: "error", error: "x" }]);
  const o1 = await runDelegateTaskWithRelay({ goal: "g" }, d1.fn, { maxRetries: -5 });
  assert.equal(o1.dispatches, 1);
  const d2 = scriptedDelegate([{ status: "error", error: "x" }]);
  const o2 = await runDelegateTaskWithRelay({ goal: "g" }, d2.fn, { maxRetries: 999 });
  assert.equal(o2.dispatches, 11);
});

// ---------------------------------------------------------------- 幂等 / 稳定
test("delegation_id 确定性: 同 goal+context 生成同一 id; 显式 id 优先", () => {
  assert.equal(stableDelegationId({ goal: "a", context: "b" }), stableDelegationId({ goal: "a", context: "b" }));
  assert.notEqual(stableDelegationId({ goal: "a", context: "b" }), stableDelegationId({ goal: "a", context: "c" }));
  assert.equal(stableDelegationId({ goal: "a", context: "b", delegation_id: "MY-ID" }), "MY-ID");
});

test("幂等钩子: attempt_key 已派发 -> SKIPPED_DUPLICATE, 不重复派发", async () => {
  const d = scriptedDelegate([{ status: "error", error: "e" }, { status: "success" }]);
  const seen = new Set<string>();
  const out = await runDelegateTaskWithRelay({ goal: "g" }, d.fn, {
    shouldDispatch: (k) => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
  });
  assert.equal(out.status, "DONE");
  assert.equal(d.calls.length, 2);
  // attempt_key 形状
  assert.equal(out.history[0].attempt_key, `${out.delegation_id}#r0`);
  assert.equal(out.history[1].attempt_key, `${out.delegation_id}#r1`);
  // 已派发过 r1 -> 再次执行走到 r1 时应跳过
  const d2 = scriptedDelegate([{ status: "error", error: "e" }]);
  const out2 = await runDelegateTaskWithRelay({ goal: "g", delegation_id: out.delegation_id }, d2.fn, {
    shouldDispatch: (k) => !seen.has(k),
  });
  assert.equal(out2.status, "SKIPPED_DUPLICATE");
  assert.equal(d2.calls.length, 0);
  assert.equal(out2.skip!.attempt_key, `${out.delegation_id}#r0`, "r0 已派发过 -> 整个接力幂等跳过");
});

test("onAttempt 观测回调: 每次派发各触发一次, 含失败/成功", async () => {
  const d = scriptedDelegate([{ status: "error", error: "e" }, { status: "success" }]);
  const rounds: number[] = [];
  await runDelegateTaskWithRelay({ goal: "g" }, d.fn, { onAttempt: (a) => rounds.push(a.round) });
  assert.deepEqual(rounds, [0, 1]);
});

// ---------------------------------------------------------------- 纯函数边界
test("truncateUtf8: UTF-8 安全, 不切出半个多字节字符", () => {
  assert.equal(truncateUtf8("abc", 10), "abc");
  assert.equal(Buffer.byteLength(truncateUtf8("中文中文", 5), "utf-8") <= 5, true);
  const cut = truncateUtf8("中文中文", 5);
  assert.equal(cut.includes("\uFFFD"), false, "不得出现替换字符");
  assert.equal(truncateUtf8("中文", 0), "");
});

test("extractPartial 优先级: partial > partialOutput > output > summary > tail", () => {
  assert.equal(extractPartial({ partial: "P", summary: "S" }), "P");
  assert.equal(extractPartial({ partialOutput: "PO", summary: "S" }), "PO");
  assert.equal(extractPartial({ output: "O", summary: "S" }), "O");
  assert.equal(extractPartial({ summary: "S" }), "S");
  assert.equal(extractPartial({ tail: [{ preview: "t1" }, { preview: "t2" }] }), "t1\n---\nt2");
  assert.equal(extractPartial(undefined), "");
});

test("extractError 兜底: 无 error 时用 exit_reason/status", () => {
  assert.equal(extractError({ error: " E " }), "E");
  assert.equal(extractError({ exit_reason: "timeout" }), "timeout");
  assert.equal(extractError({ status: "failed" }), "status=failed");
  assert.equal(extractError(undefined), "(no result)");
});

test("defaultIsSuccess: error 字段优先于 status; timeout/failed 失败", () => {
  assert.equal(defaultIsSuccess({ status: "success" }), true);
  assert.equal(defaultIsSuccess({ status: "ok" }), true);
  assert.equal(defaultIsSuccess({ status: "failed" }), false);
  assert.equal(defaultIsSuccess({ status: "timeout" }), false);
  assert.equal(defaultIsSuccess({ status: "success", error: "oops" }), false, "带 error 视为失败");
  assert.equal(defaultIsSuccess({ summary: "content, no status" }), true);
  assert.equal(defaultIsSuccess({}), false);
});

test("buildRedispatchRequest: 合并已有 additional_context 且新键覆盖", () => {
  const req = buildRedispatchRequest(
    { goal: "g", additional_context: { custom: 1, retry_round: 99 } },
    { delegation_id: "D", retry_round: 2, prev_status: "error", prev_error: "e", prev_partial: "p" }
  );
  const ac = req.additional_context as Record<string, unknown>;
  assert.equal(ac.custom, 1);
  assert.equal(ac.retry_round, 2, "新值覆盖旧值");
  assert.equal(ac.tool, DELEGATE_TASK_TOOL);
  assert.equal(req.goal, "g");
});

// ---------------------------------------------------------------- wrap / 后台派发
test("wrapDelegateTask: 返回可直接替换 delegate_task 的函数", async () => {
  const d = scriptedDelegate([{ status: "error", error: "e", partial: "p" }, { status: "success" }]);
  const wrapped = wrapDelegateTask(d.fn, { maxRetries: 2 });
  const out = await wrapped({ goal: "g" });
  assert.equal(out.status, "DONE");
  assert.equal(d.calls.length, 2);
});

test("dispatchDelegateInBackground: 立即返回 handle, 不阻塞; done 稍后 resolve", async () => {
  let ran = false;
  const handle = dispatchDelegateInBackground(async () => {
    ran = true;
    return 42;
  });
  assert.equal(ran, false, "派发必须异步, 调用方立即拿回控制权");
  const v = await handle.done;
  assert.equal(v, 42);
  assert.equal(ran, true);
});

test("dispatchDelegateInBackground: cancel 后不执行", async () => {
  let ran = false;
  const handle = dispatchDelegateInBackground(async () => {
    ran = true;
  });
  handle.cancel();
  await assert.rejects(() => handle.done);
  assert.equal(ran, false);
});

// ------------------------------------------- 验收 ② 静态断言: grep 命中重派逻辑
test("源码断言: packages/ 内 delegate_task 重派逻辑存在 (agent-x #6 ②)", () => {
  const src = readFileSync(SRC, "utf-8");
  for (const needle of [
    "delegate_task",
    "additional_context",
    "prev_error",
    "prev_partial",
    "retry_round",
    "NEEDS_CHECKPOINT_ESCALATION",
  ]) {
    assert.ok(src.includes(needle), `delegate-relay.ts 必须包含 ${needle}`);
  }
});
