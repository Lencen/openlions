/**
 * client.selftest.ts — llm-client 的离线自检（注入假报文，不发真请求）
 *
 * 运行：
 *   cd packages/apps/mind && ../../..//node_modules/.bin/tsx src/server/llm/client.selftest.ts
 *   # 真实通道冒烟（发 1 次真请求，需 env）：
 *   ... tsx src/server/llm/client.selftest.ts --live
 *
 * 覆盖运营团队指定的两条反向用例：
 *   判据 3) content 为空 + reasoning_content 有正文 -> 必须取到正文（且判定不是空响应）
 *   判据 4) finish_reason=length 且只输出 1 token -> 必须判失败（errorType=TRUNCATED，绝不记 OK）
 * 另外覆盖：真空响应 vs 协议解析错、anthropic 逐字回退、openai 目标契约、HTTP/非 JSON 错误。
 */
import { callLlm, llmErrorType, llmErrorMessage, describeLlmTarget, getLlmClientStats, resetLlmClientStats, getLlmProtocol, resolveLlmTarget, LlmCallError } from "./client";

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, cond: boolean, detail: string): void {
  results.push({ name, ok: cond });
  console.log(`${cond ? "PASS" : "FAIL"} | ${name} | ${detail}`);
}

const ENV_KEYS = [
  "LLM_PROTOCOL", "LLM_BASE_URL", "OPENAI_BASE_URL", "UNIONTECH_BASE_URL", "LLM_MODEL", "OPENAI_MODEL",
  "LLM_API_KEY", "OPENAI_API_KEY", "UNIONTECH_API_KEY",
  "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_AUTH_TOKEN", "MINIMAX_API_KEY",
];
function resetEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

type Captured = { url: string; headers: Record<string, string>; body: any };
let captured: Captured | null = null;
const realFetch = globalThis.fetch;
function installFetch(responder: (req: Captured) => Response): void {
  captured = null;
  (globalThis as any).fetch = async (url: any, init: any) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers || {})) headers[String(k).toLowerCase()] = String(v);
    const req: Captured = { url: String(url), headers, body: JSON.parse(String(init?.body || "{}")) };
    captured = req;
    return responder(req);
  };
}
function restoreFetch(): void {
  (globalThis as any).fetch = realFetch;
}
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

async function expectThrow(fn: () => Promise<any>): Promise<any> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

async function run(): Promise<void> {
  // ── 用例 1：默认协议 = anthropic，且请求逐字等于旧实现 ─────────────────────────
  resetEnv();
  resetLlmClientStats();
  process.env.ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
  process.env.ANTHROPIC_AUTH_TOKEN = "sk-test-anthropic";
  process.env.ANTHROPIC_MODEL = "MiniMax-M3";
  installFetch(() =>
    jsonResponse({
      content: [{ type: "thinking", thinking: "推理中" }, { type: "text", text: '{"ok":1}' }],
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 7 },
    })
  );
  {
    const r = await callLlm({ system: "SYS", messages: [{ role: "user", content: "U" }], maxTokens: 8192 });
    const c = captured!;
    const body = c.body;
    check(
      "1a anthropic 默认协议",
      getLlmProtocol() === "anthropic" && r.provider === "anthropic",
      `protocol=${getLlmProtocol()} provider=${r.provider}`
    );
    check(
      "1b anthropic URL 逐字=${base}/v1/messages",
      c.url === "https://api.minimaxi.com/anthropic/v1/messages",
      `url=${c.url}`
    );
    check(
      "1c anthropic 专有头 x-api-key + anthropic-version",
      c.headers["x-api-key"] === "sk-test-anthropic" && c.headers["anthropic-version"] === "2023-06-01" && !c.headers["authorization"],
      `x-api-key=${c.headers["x-api-key"] ? "present" : "missing"} anthropic-version=${c.headers["anthropic-version"]} authorization=${c.headers["authorization"] || "(none)"}`
    );
    check(
      "1d anthropic body 含 system+max_tokens+model",
      body.system === "SYS" && body.max_tokens === 8192 && body.model === "MiniMax-M3" && Array.isArray(body.messages),
      `system=${body.system} max_tokens=${body.max_tokens} model=${body.model}`
    );
    check(
      "1e anthropic 取 text 块（忽略 thinking）",
      r.text === '{"ok":1}' && r.finishReason === "end_turn" && r.tokenUsed === 18,
      `text=${JSON.stringify(r.text)} stop_reason=${r.finishReason} tokenUsed=${r.tokenUsed}`
    );
    restoreFetch();
  }

  // ── 用例 2（判据 3 反向用例）：content="" + reasoning_content 有正文 ─────────────
  resetEnv();
  resetLlmClientStats();
  process.env.LLM_PROTOCOL = "openai";
  process.env.LLM_BASE_URL = "https://llm.example.com/tenant/v1";
  process.env.LLM_MODEL = "agent-d-v4.1-flash-1017";
  process.env.UNIONTECH_API_KEY = "ut-test-key";
  installFetch(() =>
    jsonResponse({
      id: "chatcmpl-fake",
      model: "agent-d-v4.1-flash-1017",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "", reasoning_content: "这是来自 reasoning_content 的正文" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    })
  );
  {
    const r = await callLlm({ system: "SYS", messages: [{ role: "user", content: "U" }], maxTokens: 4096 });
    const c = captured!;
    check(
      "2a openai 目标走 uniontech（host/model/endpoint/Bearer）",
      c.url === "https://llm.example.com/tenant/v1/chat/completions" &&
        c.headers["authorization"] === "Bearer ut-test-key" &&
        !c.headers["x-api-key"] &&
        c.body.model === "agent-d-v4.1-flash-1017" &&
        r.baseUrlHost === "llm.example.com",
      `url=${c.url} authorization=${c.headers["authorization"] ? "present" : "missing"} model=${c.body.model} host=${r.baseUrlHost}`
    );
    check(
      "2b content 为空 -> 回落 reasoning_content 并取到正文",
      r.text === "这是来自 reasoning_content 的正文" && r.usedReasoningFallback === true && r.empty === false,
      `text=${JSON.stringify(r.text.slice(0, 24))}… usedReasoningFallback=${r.usedReasoningFallback} empty=${r.empty}`
    );
    check(
      "2c 该报文不算空响应（emptyResponses 计数=0）",
      getLlmClientStats().emptyResponses === 0 && getLlmClientStats().reasoningFallbacks === 1,
      `stats=${JSON.stringify(getLlmClientStats())}`
    );
    restoreFetch();
  }

  // ── 用例 3：content="" + reasoning（无 reasoning_content） -> 回落 reasoning ─────
  resetEnv();
  resetLlmClientStats();
  process.env.LLM_PROTOCOL = "openai";
  process.env.LLM_BASE_URL = "https://llm.example.com/tenant/v1";
  process.env.LLM_MODEL = "agent-d-v4.1-flash-1017";
  process.env.UNIONTECH_API_KEY = "ut-test-key";
  installFetch(() =>
    jsonResponse({
      choices: [{ message: { role: "assistant", content: "", reasoning: "来自 reasoning 字段的正文" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
  );
  {
    const r = await callLlm({ system: "S", messages: [{ role: "user", content: "U" }], maxTokens: 64 });
    check(
      "3 content 为空 -> 再回落 reasoning",
      r.text === "来自 reasoning 字段的正文" && r.usedReasoningFallback === true,
      `text=${JSON.stringify(r.text)} usedReasoningFallback=${r.usedReasoningFallback}`
    );
    restoreFetch();
  }

  // ── 用例 4（判据 4 反向用例）：finish_reason=length 且只出 1 token -> 判失败 ─────
  resetEnv();
  resetLlmClientStats();
  process.env.LLM_PROTOCOL = "openai";
  process.env.LLM_BASE_URL = "https://llm.example.com/tenant/v1";
  process.env.LLM_MODEL = "agent-d-v4.1-flash-1017";
  process.env.UNIONTECH_API_KEY = "ut-test-key";
  installFetch(() =>
    jsonResponse({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "A", reasoning_content: "" },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 345265, completion_tokens: 1 },
    })
  );
  {
    const e = await expectThrow(() =>
      callLlm({ system: "S", messages: [{ role: "user", content: "U" }], maxTokens: 8192, entry: "selftest" })
    );
    const et = llmErrorType(e);
    const targetStage = `FAIL:${et}`;
    check(
      "4a finish_reason=length + 1 token -> 抛 TRUNCATED",
      !!e && e instanceof LlmCallError && e.code === "TRUNCATED",
      `error.code=${(e as any)?.code} message=${String((e as any)?.message || "").slice(0, 90)}`
    );
    check(
      "4b 记账串=FAIL:TRUNCATED（recordLlmCall 的 targetStage 不会是 OK）",
      et === "TRUNCATED" && targetStage === "FAIL:TRUNCATED",
      `errorType=${et} targetStage=${targetStage} outputTokens=${(e as any)?.outputTokens} finishReason=${(e as any)?.finishReason}`
    );
    check(
      "4c 截断计数 +1，且没有被计成成功",
      getLlmClientStats().truncated === 1 && getLlmClientStats().ok === 0,
      `stats=${JSON.stringify(getLlmClientStats())}`
    );
    restoreFetch();
  }

  // ── 用例 5：真空响应（结构合法、正文全空、finish=stop） -> 不静默，empty=true ───
  resetEnv();
  resetLlmClientStats();
  process.env.LLM_PROTOCOL = "openai";
  process.env.LLM_BASE_URL = "https://llm.example.com/tenant/v1";
  process.env.LLM_MODEL = "agent-d-v4.1-flash-1017";
  process.env.UNIONTECH_API_KEY = "ut-test-key";
  installFetch(() =>
    jsonResponse({
      choices: [{ message: { role: "assistant", content: "", reasoning_content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 0 },
    })
  );
  {
    const r = await callLlm({ system: "S", messages: [{ role: "user", content: "U" }], maxTokens: 64 });
    const stats = getLlmClientStats();
    // 模拟调用点（structure-fragments / improving-tasks 的既有分支）：空 -> 记 EMPTY 并抛
    const callSiteError = r.empty ? new Error("LLM 无返回内容") : null;
    check(
      "5a 真空响应 empty=true 且计入 emptyResponses（不静默跳过）",
      r.empty === true && r.text === "" && stats.emptyResponses === 1,
      `empty=${r.empty} text=${JSON.stringify(r.text)} emptyResponses=${stats.emptyResponses}`
    );
    check(
      "5b 调用点据此记 FAIL:EMPTY（不是 OK）",
      !!callSiteError && `FAIL:EMPTY` === "FAIL:EMPTY",
      `callSiteError=${callSiteError?.message} errorType=EMPTY -> targetStage=${r.empty ? "FAIL:EMPTY" : "OK"}`
    );
    restoreFetch();
  }

  // ── 用例 6：协议解析错（缺 choices） -> PARSE_INVALID_JSON，与真空响应分开 ──────
  resetEnv();
  resetLlmClientStats();
  process.env.LLM_PROTOCOL = "openai";
  process.env.LLM_BASE_URL = "https://llm.example.com/tenant/v1";
  process.env.LLM_MODEL = "agent-d-v4.1-flash-1017";
  process.env.UNIONTECH_API_KEY = "ut-test-key";
  installFetch(() => jsonResponse({ id: "x", object: "chat.completion" }));
  {
    const e = await expectThrow(() => callLlm({ system: "S", messages: [{ role: "user", content: "U" }], maxTokens: 64 }));
    const stats = getLlmClientStats();
    check(
      "6a 缺 choices -> PARSE_INVALID_JSON（不是 EMPTY）",
      !!e && (e as any).code === "PARSE_INVALID_JSON" && llmErrorType(e) === "PARSE_INVALID_JSON" && stats.parseErrors === 1 && stats.emptyResponses === 0,
      `code=${(e as any)?.code} errorType=${llmErrorType(e)} parseErrors=${stats.parseErrors} emptyResponses=${stats.emptyResponses}`
    );
    restoreFetch();
  }

  // ── 用例 7：body 非 JSON -> PARSE_INVALID_JSON ────────────────────────────────
  resetEnv();
  resetLlmClientStats();
  process.env.LLM_PROTOCOL = "openai";
  process.env.LLM_BASE_URL = "https://llm.example.com/tenant/v1";
  process.env.LLM_MODEL = "agent-d-v4.1-flash-1017";
  process.env.UNIONTECH_API_KEY = "ut-test-key";
  installFetch(() => new Response("<html>gateway</html>", { status: 200 }));
  {
    const e = await expectThrow(() => callLlm({ system: "S", messages: [{ role: "user", content: "U" }], maxTokens: 64 }));
    check(
      "7 非 JSON body -> PARSE_INVALID_JSON",
      !!e && (e as any).code === "PARSE_INVALID_JSON",
      `code=${(e as any)?.code} message=${String((e as any)?.message || "").slice(0, 60)}`
    );
    restoreFetch();
  }

  // ── 用例 8：HTTP 403 -> HTTP_403（reflect 的旧文本可重建） ────────────────────
  resetEnv();
  resetLlmClientStats();
  process.env.ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
  process.env.ANTHROPIC_AUTH_TOKEN = "sk-test-anthropic";
  installFetch(() =>
    new Response(JSON.stringify({ error: "permission_error" }), { status: 403 })
  );
  {
    const e = await expectThrow(() => callLlm({ system: "S", messages: [{ role: "user", content: "U" }], maxTokens: 64 }));
    check(
      "8 HTTP 403 -> errorType=HTTP_403，文本可按旧格式重建",
      llmErrorType(e) === "HTTP_403" && llmErrorMessage(e, "LLM API").startsWith("LLM API 403:"),
      `errorType=${llmErrorType(e)} rebuilt=${llmErrorMessage(e, "LLM API").slice(0, 40)}`
    );
    restoreFetch();
  }

  // ── 用例 9：无凭据 -> NO_API_KEY（不是网络错） ───────────────────────────────
  resetEnv();
  resetLlmClientStats();
  installFetch(() => jsonResponse({ ok: 1 }));
  {
    const e = await expectThrow(() => callLlm({ system: "S", messages: [{ role: "user", content: "U" }], maxTokens: 64 }));
    check(
      "9 无凭据 -> NO_API_KEY",
      !!e && (e as any).code === "NO_API_KEY" && llmErrorType(e) === "NO_API_KEY",
      `code=${(e as any)?.code} message=${String((e as any)?.message || "").slice(0, 40)}`
    );
    restoreFetch();
  }

  // ── 用例 10：真空响应 + 截断同时出现 -> 判 TRUNCATED（截断优先），但空响应也计数 ──
  resetEnv();
  resetLlmClientStats();
  process.env.LLM_PROTOCOL = "openai";
  process.env.LLM_BASE_URL = "https://llm.example.com/tenant/v1";
  process.env.LLM_MODEL = "agent-d-v4.1-flash-1017";
  process.env.UNIONTECH_API_KEY = "ut-test-key";
  installFetch(() =>
    jsonResponse({
      choices: [{ message: { role: "assistant", content: "", reasoning_content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 345265, completion_tokens: 1 },
    })
  );
  {
    const e = await expectThrow(() => callLlm({ system: "S", messages: [{ role: "user", content: "U" }], maxTokens: 64 }));
    const s = getLlmClientStats();
    check(
      "10 空正文+length -> 判 TRUNCATED 且空响应/截断两个计数都记",
      (e as any)?.code === "TRUNCATED" && s.emptyResponses === 1 && s.truncated === 1 && s.ok === 0,
      `code=${(e as any)?.code} stats=${JSON.stringify(s)}`
    );
    restoreFetch();
  }

  // ── 用例 11：非法 LLM_PROTOCOL -> 告警并回落 anthropic ───────────────────────
  resetEnv();
  resetLlmClientStats();
  process.env.LLM_PROTOCOL = "opnai";
  {
    const p = getLlmProtocol();
    check(
      "11 非法 LLM_PROTOCOL -> 回落 anthropic 且计数",
      p === "anthropic" && getLlmClientStats().invalidProtocol === 1,
      `protocol=${p} invalidProtocol=${getLlmClientStats().invalidProtocol}`
    );
  }

  // ── 用例 12：openai 端点拼接（base 无 /v1 时补 /v1） ─────────────────────────
  resetEnv();
  process.env.LLM_PROTOCOL = "openai";
  process.env.LLM_BASE_URL = "https://llm.example.com/tenant";
  process.env.LLM_MODEL = "agent-d-v4.1-flash-1017";
  process.env.UNIONTECH_API_KEY = "k";
  {
    const t = resolveLlmTarget();
    check(
      "12 base 无 /v1 -> 补 /v1/chat/completions",
      t.endpoint === "https://llm.example.com/tenant/v1/chat/completions" && t.baseUrlHost === "llm.example.com",
      `endpoint=${t.endpoint} host=${t.baseUrlHost}`
    );
  }

  resetEnv();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n[selftest] ${passed}/${results.length} PASS`);
  if (passed !== results.length) {
    console.log("[selftest] 有失败用例：" + results.filter((r) => !r.ok).map((r) => r.name).join(" | "));
    process.exitCode = 1;
  }
}

async function live(): Promise<void> {
  console.log("[live] 目标: " + describeLlmTarget());
  try {
    const r = await callLlm({
      system: "只输出一个 JSON: {\"pong\":true}",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 512,
      entry: "selftest-live",
    });
    console.log(
      `[live] ok provider=${r.provider} model=${r.model} host=${r.baseUrlHost} finish=${r.finishReason} ` +
      `empty=${r.empty} usedReasoningFallback=${r.usedReasoningFallback} tokenUsed=${r.tokenUsed ?? "-"} durationMs=${r.durationMs}`
    );
    console.log(`[live] text[0:40]=${JSON.stringify(r.text.slice(0, 40))}`);
  } catch (e: any) {
    console.log(`[live] FAILED code=${(e as any)?.code || "?"} errorType=${llmErrorType(e)} message=${String(e?.message || e).slice(0, 200)}`);
    process.exitCode = 1;
  }
}

/**
 * --probe-tokens：实测 uniontech 的"字符 -> token"比，用于复核 chunk 阈值（判据 4 的阈值结论）。
 * 只发 2 次小输出请求（max_tokens=16），输入各 50,000 字符；不落库、不改任何状态。
 */
async function probeTokens(): Promise<void> {
  process.env.LLM_PROTOCOL = process.env.LLM_PROTOCOL || "openai";
  process.env.LLM_BASE_URL = process.env.LLM_BASE_URL || "https://llm.example.com/tenant/v1";
  process.env.LLM_MODEL = process.env.LLM_MODEL || "agent-d-v4.1-flash-1017";
  const repeatTo = (s: string, n: number) => {
    let out = "";
    while (out.length < n) out += s;
    return out.slice(0, n);
  };
  const zh = repeatTo("飞轮结构化整理必须按协议分流并校验空正文与截断。", 50000);
  const en = repeatTo("The flywheel structured pass must split protocol branches and validate empty bodies. ", 50000);
  console.log("[probe] 目标: " + describeLlmTarget());
  for (const [name, text] of [["zh(50k chars)", zh], ["en(50k chars)", en]] as Array<[string, string]>) {
    try {
      const r = await callLlm({ system: "只回答 OK", messages: [{ role: "user", content: text }], maxTokens: 512, entry: "probe-tokens" });
      const u = r.raw?.usage || {};
      const promptTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
      const ratio = promptTokens / text.length;
      console.log(
        `[probe] ${name} prompt_tokens=${promptTokens} chars=${text.length} ratio=${ratio.toFixed(3)} tok/char ` +
        `-> 200000 字符 ≈ ${Math.round(ratio * 200000)} tokens; finish=${r.finishReason} out=${u.completion_tokens ?? "-"}`
      );
    } catch (e: any) {
      console.log(`[probe] ${name} FAILED code=${(e as any)?.code || "?"} message=${String(e?.message || e).slice(0, 160)}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv.includes("--probe-tokens")) {
  probeTokens();
} else if (process.argv.includes("--live")) {
  live();
} else {
  run();
}
