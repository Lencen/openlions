/**
 * llm-client.ts — mind 的 LLM 协议抽象（2026-11-19 [team]，运营团队最高优先级）
 *
 * 为什么要有这一层（实测根因，不是设计偏好）：
 *   4 处 LLM 调用点各自硬编码 Anthropic 协议（POST ${base}/v1/messages + x-api-key + anthropic-version），
 *   而 uniontech 已禁用 Anthropic 协议：
 *     POST https://llm.example.com/tenant/v1/messages        -> HTTP 403 permission_error
 *        "Anthropic API (Claude Code) support has been disabled"
 *     POST https://llm.example.com/tenant/v1/chat/completions -> HTTP 200
 *   只改 env（ANTHROPIC_BASE_URL）无效 —— 协议路径与响应体格式都不同，必须有协议分支。
 *
 * 协议开关：LLM_PROTOCOL=openai|anthropic（默认 anthropic = 逐字回退旧行为）
 *   只改这一处实现，4 个调用点（reflect.ts x2 / structure-fragments.ts / generate-improving-tasks.ts）
 *   都走 callLlm，避免"改 3 处漏 1 处"。
 *
 * 三个必须处理的行为差异（运营团队实测，缺一即静默错）：
 *   1) uniontech 的 OpenAI 响应 choices[0].message.content 可能是**空字符串**，正文在
 *      reasoning_content（或 reasoning）里 —— 必须依次回落；回落不到才算"空响应"。
 *   2) finish_reason=length 是**静默截断**：uniontech 真实窗口约 30 万 token，
 *      prompt 到 345265 起全部只出 1 token + finish_reason=length，网关不报错。
 *      必须判失败（TRUNCATED），不能记 OK。
 *   3) 「真空响应」（结构合法但正文全空）与「协议解析错」（choices/message 缺失、body 非 JSON）
 *      是两件事：前者记空响应计数并让调用点按 EMPTY 处理，后者抛 PARSE_INVALID_JSON。
 *      两者都不许静默跳过。
 *
 * 超时/重试/并发：完全复用现有 fetchWithTimeout + withLlmConcurrency（调用点包），
 *   本模块只做协议适配与响应判读，不引入新的重试语义。
 */
import { extractLlmText } from "./extract-text";
import { fetchWithTimeout } from "../pipeline/with-retry";

export type LlmProtocol = "anthropic" | "openai";

export type LlmErrorCode =
  | "HTTP"                 // 非 2xx
  | "PARSE_INVALID_JSON"   // body 非 JSON / 协议结构缺失（choices/message）
  | "EMPTY"                // 保留给调用点判定；本模块不抛（返回 empty=true）
  | "TRUNCATED"            // finish_reason=length（openai）/ stop_reason=max_tokens（仅标记）
  | "NO_API_KEY"           // 凭据未配置
  | "TIMEOUT"              // fetchWithTimeout 内部超时
  | "NETWORK";             // 连接/DNS/其它 fetch 失败

/** 默认 base_url：anthropic 保持旧值逐字不变；openai 默认指向 uniontech（可用 LLM_BASE_URL 覆盖）。 */
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
export const DEFAULT_OPENAI_BASE_URL = "https://llm.example.com/tenant/v1";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CallLlmParams {
  /** system prompt（anthropic 走顶层 system 字段；openai 拼成 messages[0] role=system） */
  system: string;
  messages: LlmMessage[];
  /** 输出上限（Anthropic: max_tokens；OpenAI: max_tokens，值语义相同） */
  maxTokens: number;
  temperature?: number;
  /** 外部 AbortSignal（route 层超时/cron 超时透传，语义与 fetchWithTimeout 一致） */
  signal?: AbortSignal;
  /** 单次请求超时；不传 = 120000（fetchWithTimeout 的既有默认） */
  timeoutMs?: number;
  /** 调用点原模型名（anthropic 下逐字使用；openai 下 LLM_MODEL 优先） */
  model?: string;
  /** 仅用于日志/排障的入口名，不参与请求 */
  entry?: string;
}

export interface LlmTarget {
  protocol: LlmProtocol;
  baseUrl: string;
  /** 仅 host（含端口），用于观测打点 —— 判据要求能证明"真的走了哪个 host" */
  baseUrlHost: string;
  model: string;
  hasKey: boolean;
  /** 命中凭据的 env 名（不泄露 key 值） */
  apiKeyEnv: string;
  endpoint: string;
}

export interface CallLlmResult {
  /** 正文：openai 下 content 为空时回落 reasoning_content -> reasoning */
  text: string;
  /** 原始响应体（调用点需要 usage/debug 落盘时用） */
  raw: any;
  /** anthropic: stop_reason；openai: finish_reason（原样字符串，不做枚举映射） */
  finishReason: string;
  provider: LlmProtocol;
  model: string;
  baseUrlHost: string;
  /** 是否走了 reasoning 回落（为 true 说明 content 是空的，正文来自思维链字段） */
  usedReasoningFallback: boolean;
  /** 真空响应（结构合法但正文全空）——调用点必须按 EMPTY 记账并失败，不许跳过 */
  empty: boolean;
  /** openai: finish_reason=length；anthropic: stop_reason=max_tokens（anthropic 不抛，保持旧行为） */
  truncated: boolean;
  /** input+output token（响应里有没有给就按有没有记） */
  tokenUsed?: number;
  /** openai 专用：completion_tokens（截断时用于日志证明"只出了 N token"） */
  outputTokens?: number;
  durationMs: number;
}

interface LlmErrorOptions {
  code: LlmErrorCode;
  target: LlmTarget;
  httpStatus?: number;
  bodyPreview?: string;
  finishReason?: string;
  outputTokens?: number;
  /** 截断归因：output_budget=输出预算耗尽 / input_overflow=输入超窗口 */
  truncationKind?: "output_budget" | "input_overflow";
  cause?: unknown;
}

export class LlmCallError extends Error {
  code: LlmErrorCode;
  httpStatus?: number;
  bodyPreview?: string;
  finishReason?: string;
  outputTokens?: number;
  truncationKind?: "output_budget" | "input_overflow";

  constructor(message: string, opts: LlmErrorOptions) {
    super(message);
    this.name = "LlmCallError";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.bodyPreview = opts.bodyPreview;
    this.finishReason = opts.finishReason;
    this.outputTokens = opts.outputTokens;
    this.truncationKind = opts.truncationKind;
    if (opts.cause !== undefined) (this as any).cause = opts.cause;
    // 调用点记账要用到"实际打到了哪里"，失败时也必须能拿到（否则观测里 model/host 缺失）
    (this as any).target = opts.target;
    (this as any).provider = opts.target.protocol;
    (this as any).model = opts.target.model;
    (this as any).baseUrlHost = opts.target.baseUrlHost;
  }
}

// ===== 进程内计数（空响应 / 截断 / 解析失败必须可读，不能只靠看日志） =====
const stats = {
  calls: 0,
  ok: 0,
  emptyResponses: 0,
  reasoningFallbacks: 0,
  truncated: 0,
  parseErrors: 0,
  httpErrors: 0,
  invalidProtocol: 0,
  byProtocol: { anthropic: 0, openai: 0 } as Record<LlmProtocol, number>,
};

export function getLlmClientStats() {
  return { ...stats, byProtocol: { ...stats.byProtocol } };
}

export function resetLlmClientStats(): void {
  stats.calls = 0;
  stats.ok = 0;
  stats.emptyResponses = 0;
  stats.reasoningFallbacks = 0;
  stats.truncated = 0;
  stats.parseErrors = 0;
  stats.httpErrors = 0;
  stats.invalidProtocol = 0;
  stats.byProtocol = { anthropic: 0, openai: 0 };
}

let _invalidProtocolWarned = "";

/** 协议开关：LLM_PROTOCOL=openai|anthropic，默认 anthropic；非法值告警并回落默认（不许静默） */
export function getLlmProtocol(): LlmProtocol {
  const raw = String(process.env.LLM_PROTOCOL ?? "").trim().toLowerCase();
  if (!raw) return "anthropic";
  if (raw === "openai" || raw === "anthropic") return raw;
  stats.invalidProtocol++;
  if (_invalidProtocolWarned !== raw) {
    _invalidProtocolWarned = raw;
    console.warn(
      `[llm] LLM_PROTOCOL="${raw}" 非法（只接受 openai|anthropic），已回落 anthropic（旧行为）`
    );
  }
  return "anthropic";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** anthropic 端点：**逐字保留旧实现** `${baseUrl}/v1/messages`（含旧 env 无 /v1 的形态） */
export function anthropicEndpoint(baseUrl: string): string {
  return `${baseUrl}/v1/messages`;
}

/** openai 端点：base 已以 /v1 结尾则直接接 /chat/completions，否则补 /v1 */
export function openaiEndpoint(baseUrl: string): string {
  const b = trimSlash(baseUrl);
  return /\/v1$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

/** 解析一次调用的目标（协议/base/model/凭据）。不发请求，供记账与自检复用。 */
export function resolveLlmTarget(modelOverride?: string, protocolOverride?: LlmProtocol): LlmTarget {
  const protocol = protocolOverride ?? getLlmProtocol();
  if (protocol === "openai") {
    const baseUrl =
      process.env.LLM_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      process.env.UNIONTECH_BASE_URL ||
      DEFAULT_OPENAI_BASE_URL;
    const model =
      process.env.LLM_MODEL ||
      process.env.OPENAI_MODEL ||
      modelOverride ||
      process.env.ANTHROPIC_MODEL ||
      "";
    const picks: Array<[string, string | undefined]> = [
      ["LLM_API_KEY", process.env.LLM_API_KEY],
      ["OPENAI_API_KEY", process.env.OPENAI_API_KEY],
      ["UNIONTECH_API_KEY", process.env.UNIONTECH_API_KEY],
    ];
    let apiKeyEnv = "";
    for (const [name, val] of picks) {
      if (val && val.trim().length > 0) { apiKeyEnv = name; break; }
    }
    return {
      protocol,
      baseUrl,
      baseUrlHost: hostOf(baseUrl),
      model,
      hasKey: !!apiKeyEnv,
      apiKeyEnv,
      endpoint: openaiEndpoint(baseUrl),
    };
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL;
  const model = modelOverride || process.env.ANTHROPIC_MODEL || "MiniMax-M3";
  const apiKeyEnv = process.env.ANTHROPIC_AUTH_TOKEN
    ? "ANTHROPIC_AUTH_TOKEN"
    : process.env.MINIMAX_API_KEY
      ? "MINIMAX_API_KEY"
      : "";
  return {
    protocol,
    baseUrl,
    baseUrlHost: hostOf(baseUrl),
    model,
    hasKey: !!apiKeyEnv,
    apiKeyEnv,
    endpoint: anthropicEndpoint(baseUrl),
  };
}

/** 调用点做"无 key 退化"分支时用（confirmSemanticPairs 原有行为） */
export function hasLlmCredentials(): boolean {
  return resolveLlmTarget().hasKey;
}

function apiKeyValue(protocol: LlmProtocol): string {
  if (protocol === "openai") {
    return process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.UNIONTECH_API_KEY || "";
  }
  return process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
}

function buildHeaders(target: LlmTarget): Record<string, string> {
  const key = apiKeyValue(target.protocol);
  if (target.protocol === "openai") {
    return {
      "content-type": "application/json",
      // uniontech 的 OpenAI 协议用标准 Bearer（Anthropic 的 x-api-key 在这里不被接受）
      authorization: `Bearer ${key}`,
    };
  }
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };
}

function buildBody(target: LlmTarget, params: CallLlmParams): Record<string, unknown> {
  if (target.protocol === "openai") {
    const body: Record<string, unknown> = {
      model: target.model,
      max_tokens: params.maxTokens,
      messages: [
        { role: "system", content: params.system },
        ...params.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    if (typeof params.temperature === "number") body.temperature = params.temperature;
    return body;
  }
  const body: Record<string, unknown> = {
    model: target.model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (typeof params.temperature === "number") body.temperature = params.temperature;
  return body;
}

/** 文本归一：string 直接用；OpenAI 兼容服务偶见 content 为 blocks 数组 */
function normalizeText(v: any): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

interface Picked {
  text: string;
  finishReason: string;
  usedReasoningFallback: boolean;
  parseError?: string;
  tokenUsed?: number;
  outputTokens?: number;
}

function pickAnthropic(raw: any): Picked {
  if (!Array.isArray(raw.content)) {
    // content 缺失且没有 text 字段 = 协议结构不对（不是"空响应"）
    if (typeof raw.text !== "string") {
      return {
        text: "",
        finishReason: String(raw.stop_reason || ""),
        usedReasoningFallback: false,
        parseError: `Anthropic 响应缺 content[]: keys=${Object.keys(raw).join(",")}`,
      };
    }
  }
  const text = extractLlmText(raw) || normalizeText(raw.text);
  const usage = raw.usage || {};
  const tokenUsed =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens + Number(usage.output_tokens || 0)
      : typeof usage.prompt_tokens === "number"
        ? Number(usage.prompt_tokens) + Number(usage.completion_tokens || 0)
        : undefined;
  return {
    text,
    finishReason: String(raw.stop_reason || ""),
    usedReasoningFallback: false,
    tokenUsed,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
  };
}

function pickOpenai(raw: any): Picked {
  const choices = raw?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      text: "",
      finishReason: "",
      usedReasoningFallback: false,
      parseError: `OpenAI 响应缺 choices[]: keys=${Object.keys(raw || {}).join(",")}`,
    };
  }
  const c0 = choices[0] || {};
  const msg = c0.message;
  const usage = raw.usage || {};
  const tokenUsed =
    typeof usage.prompt_tokens === "number"
      ? Number(usage.prompt_tokens) + Number(usage.completion_tokens || 0)
      : typeof usage.input_tokens === "number"
        ? Number(usage.input_tokens) + Number(usage.output_tokens || 0)
        : undefined;
  const outputTokens =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : undefined;
  const finishReason = String(c0.finish_reason || "");

  if (!msg || typeof msg !== "object") {
    // message 缺失：允许 legacy 的 choices[0].text（少数兼容实现），否则判协议解析错
    const legacy = normalizeText(c0.text);
    if (legacy.length > 0) {
      return { text: legacy, finishReason, usedReasoningFallback: false, tokenUsed, outputTokens };
    }
    return {
      text: "",
      finishReason,
      usedReasoningFallback: false,
      parseError: `OpenAI 响应缺 choices[0].message（keys=${Object.keys(c0).join(",")}）`,
      tokenUsed,
      outputTokens,
    };
  }

  // 1) 正文；2) reasoning_content；3) reasoning（同一 message 或 choice 级）
  const contentText = normalizeText(msg.content);
  if (contentText.trim().length > 0) {
    return { text: contentText, finishReason, usedReasoningFallback: false, tokenUsed, outputTokens };
  }
  const reasoningText =
    normalizeText(msg.reasoning_content) ||
    normalizeText(msg.reasoning) ||
    normalizeText(c0.reasoning_content) ||
    normalizeText(c0.reasoning);
  if (reasoningText.trim().length > 0) {
    return { text: reasoningText, finishReason, usedReasoningFallback: true, tokenUsed, outputTokens };
  }
  // 结构合法但正文全空 = 真空响应（不是解析错）
  return { text: "", finishReason, usedReasoningFallback: false, tokenUsed, outputTokens };
}

let _firstTargetLogged = false;

/**
 * 发起一次 LLM 调用（协议按 LLM_PROTOCOL 切换）。
 *
 * 失败语义（调用点据此记账，不许把失败记成 OK）：
 *   - 非 2xx            -> LlmCallError(code=HTTP, httpStatus, bodyPreview)
 *   - body 非 JSON/结构错 -> LlmCallError(code=PARSE_INVALID_JSON)
 *   - openai length 截断  -> LlmCallError(code=TRUNCATED, finishReason, outputTokens)
 *   - 无凭据             -> LlmCallError(code=NO_API_KEY)
 *   - 网络/超时          -> LlmCallError(code=NETWORK|TIMEOUT)，message 与旧 fetchWithTimeout 一致
 *   - 真空响应           -> **不抛**（返回 empty=true，由调用点按 EMPTY 记账并失败）
 */
export async function callLlm(params: CallLlmParams): Promise<CallLlmResult> {
  const t0 = Date.now();
  const target = resolveLlmTarget(params.model);
  stats.calls++;
  stats.byProtocol[target.protocol]++;

  if (!target.hasKey) {
    throw new LlmCallError(
      target.protocol === "anthropic"
        ? "LLM API key 未配置 (ANTHROPIC_AUTH_TOKEN)"
        : "LLM API key 未配置 (LLM_API_KEY/OPENAI_API_KEY/UNIONTECH_API_KEY)",
      { code: "NO_API_KEY", target }
    );
  }

  if (!_firstTargetLogged) {
    _firstTargetLogged = true;
    console.info(
      `[llm] protocol=${target.protocol} model=${target.model} host=${target.baseUrlHost} endpoint=${target.endpoint} keyFrom=${target.apiKeyEnv}`
    );
  }

  const timeoutMs = params.timeoutMs ?? 120000;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      target.endpoint,
      {
        method: "POST",
        headers: buildHeaders(target),
        body: JSON.stringify(buildBody(target, params)),
      },
      timeoutMs,
      params.signal
    );
  } catch (e: any) {
    const isTimeout = /fetch timeout after/.test(String(e?.message || ""));
    throw new LlmCallError(String(e?.message || e), {
      code: isTimeout ? "TIMEOUT" : "NETWORK",
      target,
      cause: e,
    });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    stats.httpErrors++;
    throw new LlmCallError(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`, {
      code: "HTTP",
      target,
      httpStatus: res.status,
      bodyPreview: body.slice(0, 200),
    });
  }

  let raw: any;
  try {
    raw = await res.json();
  } catch {
    stats.parseErrors++;
    throw new LlmCallError("LLM 返回不是合法 JSON", { code: "PARSE_INVALID_JSON", target });
  }
  if (!raw || typeof raw !== "object") {
    stats.parseErrors++;
    throw new LlmCallError(`LLM 返回不是 JSON 对象 (type=${typeof raw})`, {
      code: "PARSE_INVALID_JSON",
      target,
    });
  }

  const picked = target.protocol === "openai" ? pickOpenai(raw) : pickAnthropic(raw);
  if (picked.parseError) {
    stats.parseErrors++;
    // 协议解析错必须与"空响应"分开：这里直接把原始结构线索带进错误
    throw new LlmCallError(`LLM 协议解析失败: ${picked.parseError}`, {
      code: "PARSE_INVALID_JSON",
      target,
      finishReason: picked.finishReason || undefined,
    });
  }

  const empty = picked.text.trim().length === 0;
  const truncated =
    target.protocol === "openai"
      ? /^(length|max_tokens)$/i.test(picked.finishReason)
      : /^max_tokens$/i.test(picked.finishReason);

  if (picked.usedReasoningFallback) stats.reasoningFallbacks++;

  if (empty) {
    // 真空响应计数（可读）+ 一行显式日志：不许静默跳过 content 为空的报文
    stats.emptyResponses++;
    console.warn(
      `[llm] 空响应 protocol=${target.protocol} model=${target.model} host=${target.baseUrlHost} ` +
      `finish=${picked.finishReason || "-"} completion_tokens=${picked.outputTokens ?? "-"} ` +
      `content_len=0 reasoning_len=0 entry=${params.entry || "-"}`
    );
  }

  if (truncated) {
    stats.truncated++;
    if (target.protocol === "openai") {
      // 静默截断必须判失败：记 OK 会让"只出 1 token"看起来是成功产出。
      // 归因必须按 completion_tokens 与 max_tokens 的关系分两类（2026-11-19 实测）：
      //   · completion_tokens >= max_tokens -> 输出预算耗尽（调大 max_tokens）
      //   · completion_tokens <  max_tokens -> 输入超窗口/被网关截断（uniontech 345265 起只出 1 token 即此类）
      // 二者都判失败，但处置不同，混成一句会误导排障方向。
      const outTok = picked.outputTokens;
      const budgetHit = typeof outTok === "number" && outTok >= params.maxTokens;
      const kind = budgetHit ? "output_budget" : "input_overflow";
      throw new LlmCallError(
        budgetHit
          ? `LLM 输出被截断(finish_reason=${picked.finishReason}, completion_tokens=${outTok}/${params.maxTokens}, 正文 ${picked.text.length} 字符): ` +
            `输出预算耗尽（调大 max_tokens 或减少输出要求）`
          : `LLM 输出被截断(finish_reason=${picked.finishReason}, completion_tokens=${outTok ?? "-"} < max_tokens=${params.maxTokens}, 正文 ${picked.text.length} 字符): ` +
            `输入超模型真实窗口（uniontech ≈300K）或被网关静默截断，请拆小输入或调低 chunk`,
        {
          code: "TRUNCATED",
          target,
          finishReason: picked.finishReason,
          outputTokens: picked.outputTokens,
          truncationKind: kind,
        }
      );
    }
    // anthropic：保持旧行为（旧代码不因 stop_reason=max_tokens 抛错，只把 stop_reason 带进失败文本）
    console.warn(
      `[llm] 输出达到 max_tokens（anthropic stop_reason=max_tokens，沿用旧行为不判失败）model=${target.model}`
    );
  }

  stats.ok++;
  return {
    text: picked.text,
    raw,
    finishReason: picked.finishReason,
    provider: target.protocol,
    model: target.model,
    baseUrlHost: target.baseUrlHost,
    usedReasoningFallback: picked.usedReasoningFallback,
    empty,
    truncated,
    tokenUsed: picked.tokenUsed,
    outputTokens: picked.outputTokens,
    durationMs: Date.now() - t0,
  };
}

/**
 * 把异常映射成 recordLlmCall 的 errorType（保持旧字符串：HTTP_xxx / PARSE_INVALID_JSON / EMPTY / ...）。
 * 非 LlmCallError 一律 UNKNOWN（不被吞掉）。
 */
export function llmErrorType(e: unknown): string {
  if (e instanceof LlmCallError) {
    if (e.code === "HTTP") return `HTTP_${e.httpStatus ?? "UNKNOWN"}`;
    return e.code;
  }
  const msg = String((e as any)?.message || e);
  if (/fetch timeout after/.test(msg)) return "TIMEOUT";
  return "UNKNOWN";
}

/**
 * 截断处置两分类的**下游可判**入口（2026-11-20 运营团队 05:04 提出）。
 * 背景：client.ts:557 早就把 truncationKind 写进 LlmCallError，但全仓**没有一个读者**——
 *   llmErrorType() 只返 code（TRUNCATED），于是 output_budget（调大 max_tokens）与
 *   input_overflow（拆小输入）在记账层不可区分 = 「可判」被降成「可见」。
 * 注意：turn/end.reason.error 是 **DSH harness** 写的帧，mind 的 LlmCallError 不会自动流过去（跨进程，无通路）。
 */
export function llmTruncationKind(e: unknown): "output_budget" | "input_overflow" | undefined {
  const k = (e as any)?.truncationKind;
  return k === "output_budget" || k === "input_overflow" ? k : undefined;
}

/** 失败记账用的目标信息（model/host 在失败时也必须可读） */
export function llmErrorTarget(e: unknown): { model: string; baseUrlHost: string; provider: LlmProtocol } {
  const t = (e as any)?.target;
  if (t && typeof t === "object") {
    return { model: String(t.model || ""), baseUrlHost: String(t.baseUrlHost || ""), provider: t.protocol };
  }
  const fallback = resolveLlmTarget();
  return { model: fallback.model, baseUrlHost: fallback.baseUrlHost, provider: fallback.protocol };
}

/** 便于失败日志重建旧格式（reflect 用 `LLM API ${status}`，其余用 `LLM HTTP ${status}`） */
export function llmErrorMessage(e: unknown, prefix: "LLM API" | "LLM HTTP"): string {
  if (e instanceof LlmCallError) {
    if (e.code === "HTTP") {
      return `${prefix} ${e.httpStatus}: ${String(e.bodyPreview || "").slice(0, 200)}`;
    }
    return e.message;
  }
  return String((e as any)?.message || e);
}

/** 日志用目标摘要（不含 key） */
export function describeLlmTarget(modelOverride?: string): string {
  const t = resolveLlmTarget(modelOverride);
  return `protocol=${t.protocol} model=${t.model} host=${t.baseUrlHost} endpoint=${t.endpoint} keyFrom=${t.apiKeyEnv || "(none)"}`;
}
