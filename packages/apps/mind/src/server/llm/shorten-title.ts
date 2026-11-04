/**
 * shorten-title.ts -- 标题/名字 LLM 缩写 (2026-10-08 round 59, 人类批准)
 *
 * 业务前提: 写路径已由 lib/prisma.ts 钩子 + store 闸强制合规(round 58), 确定性归一在新数据上 100% 保证.
 *   本模块处理存量(~16,740 条超长) + 可重入的"手动重写单条".
 *
 * 设计: 纯函数异步 (llmShortenTitles), 短超时 8s, 最多 2 次重试, 失败抛错(不返回空)让调用方决定.
 *   输出严格校验: 长度 ≤ 上限, 非空, 与原值差异过大时拒绝(避免 LLM 改写含义), 命中黑名单词时拒绝.
 *
 * 调用: Anthropic 兼容 Messages API, 端点从 process.env.ANTHROPIC_BASE_URL 读, 缺省 https://api.minimaxi.com/anthropic
 *   Key 从 process.env.ANTHROPIC_AUTH_TOKEN / MINIMAX_API_KEY 读.
 */
export const TITLE_MAX = 30;
export const SKILL_NAME_MAX = 20;
const ENDPOINT = (process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic") + "/v1/messages";
const API_KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "MiniMax-M2.7";
const TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;

export type Row = { id: string; text: string; kind: "knowledge" | "practice" | "memory" | "skill" };

export class LlmError extends Error {}
export class LlmAuthError extends LlmError {}
export class LlmEmptyError extends LlmError {}
export class LlmTooLongError extends LlmError {}
export class LlmSuspiciousError extends LlmError {}
export class LlmNetError extends LlmError {}

/**
 * 系统提示按**本次真实上限**生成(2026-10-09 round 71 实测修正).
 *   原实现里 TITLE_MAX(30) 被写死在提示正文, 只有括号里提一句 "skill 上限 20 字" ——
 *   实测对 skill(上限 20) 请求时, 模型返回 28 字(踩在 30 的暗示上), 被 validateShortened 判 LlmTooLongError。
 *   提示里出现两个互相矛盾的数字, 是**提示层的口径分叉**, 与数据层口径分叉同一种病。
 */
const SYS_PROMPT = (limit: number) =>
  "你是一名产品标题压缩助手. 输入一条知识/实践/记忆/技能标题 (当前超长, 本次上限 **" + limit + " 字**), 你的任务: 压缩为符合上限的版本.\n" +
  "**严格约束**:\n" +
  "1. 输出长度 **必须 ≤ " + limit + " 字**(这是硬上限, 超一个字都算失败; 宁可更短, 也不要贴着上限写);\n" +
  "2. 仅压缩措辞, **不得新增、删减、改变原意**; 优先保留最有区分度的词(专有名词/技术名词/动作), 砍掉修饰与冗余;\n" +
  "3. **不要用省略号**(不要出现 \"…\" 或 \"...\")—— 需要更短就把词换掉, 不要截断留省略;\n" +
  "4. 若原标题已是动宾短语或本身就是关键术语, 尽量原样保留或仅去掉冗余前缀(如\"反思:\"、\"[反思]\"、\"[Practice]\");\n" +
  "5. 不要添加句号/问号等标点; 不要带引号; 不要在开头加序号/项目符号;\n" +
  "6. 输出**只含新标题本身**, 不要解释、不要换行、不要 markdown.\n";

const USER_TMPL = (text: string, limit: number) =>
  `原标题(超长, 上限 ${limit} 字):\n${text}\n\n压缩为 ≤${limit} 字(硬上限), 不含省略号, 严格按系统约束:`;

// 用 new RegExp 字符串构造, 避免正则字面量中 N/A 等路径里的 / 被 parser 当成终止符
//  (TS 在 line 43 把 `N/A` 后的 / 看作 regex 结束, 报 TS1005/TS1127)
const NO_GO_PATTERNS: RegExp[] = [
  /\b(?:TODO|FIXME|TBD)\b/i,
  new RegExp("\\b(?:test|null|undefined)\\b", "i"),
  new RegExp("\\bN/A\\b", "i"),
  /^(?:标题|title):\s*/i,
];

/**
 * 压缩单个标题. 失败抛 LlmError 子类(供调用方决定降级/重试/跳过).
 */
export async function llmShortenOne(text: string, kind: Row["kind"]): Promise<string> {
  if (!API_KEY) throw new LlmAuthError("LLM API key 未配置 (ANTHROPIC_AUTH_TOKEN / MINIMAX_API_KEY)");
  const limit = kind === "skill" ? SKILL_NAME_MAX : TITLE_MAX;
  const t = String(text || "").trim();
  if (t.length <= limit) return t;
  if (t.length > 300) throw new LlmError("输入过长 (" + t.length + "), 单条限 300 字符");

  let attempt = 0;
  let lastErr: Error | null = null;
  while (attempt <= MAX_RETRIES) {
    try {
      const res = await fetchWithTimeout(ENDPOINT, TIMEOUT_MS, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 128,
          messages: [{ role: "user", content: SYS_PROMPT(limit) + "\n\n" + USER_TMPL(t, limit) }],
        }),
      });
      if (!res.ok) {
        const status = res.status;
        if (status === 401 || status === 403) throw new LlmAuthError("HTTP " + status);
        throw new LlmNetError("HTTP " + status + ": " + (await res.text().catch(() => "")));
      }
      const j = await res.json();
      const text0 = extractContent(j);
      const out = validateShortened(text0, t, limit);
      return out;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      attempt++;
      // 2026-10-09 round 71 实测修正: LlmTooLongError / LlmSuspiciousError **必须重试**。
      //   它们不是"请求本身不可能成功"(那是 Auth), 而是**模型这一把没听话** —— 采样有随机性,
      //   重试一次常常就合规了。原实现把它们与 Auth 一起直接抛出 -> 调用方拿到的是失败,
      //   而实际只需要再试一次。实测证据: skill(上限 20) 请求返回 28 字被 LlmTooLongError 直接抛出。
      //   只有鉴权类(Auth)是真·不可重试。
      if (e instanceof LlmAuthError) throw e;
      if (attempt > MAX_RETRIES) throw e instanceof LlmError ? e : new LlmNetError(lastErr.message);
    }
  }
  throw new LlmError(lastErr?.message || "未知失败");
}

function extractContent(j: any): string {
  try {
    // Anthropic Messages API 响应格式: {content: [{type:"text", text:"..."}]}
    const arr = j?.content;
    if (Array.isArray(arr)) {
      for (const p of arr) if (p && p.type === "text" && typeof p.text === "string") return p.text;
    }
    // 兼容 OpenAI 风格: {choices: [{message: {content: "..."}}]}
    return j?.choices?.[0]?.message?.content ?? "";
  } catch { return ""; }
}

function validateShortened(out: string, original: string, limit: number): string {
  const t = String(out || "").trim();
  if (!t) throw new LlmEmptyError("LLM 输出为空");
  if (t.length > limit) throw new LlmTooLongError("LLM 输出仍超长 (" + t.length + "/" + limit + ")");
  // 拒绝落到 NO-GO 模板(测试占位/标题前缀)
  for (const p of NO_GO_PATTERNS) if (p.test(t)) throw new LlmSuspiciousError("LLM 输出命中禁忌模板: " + t);
  // 拒绝与原文差异过大(>60% 替换率 -> 怀疑 LLM 改写含义)
  const sim = similarity(t, original);
  if (sim < 0.4) throw new LlmSuspiciousError("LLM 输出与原文相似度太低 (" + sim.toFixed(2) + "), 拒绝以防改写含义: " + t);
  return t;
}

/** 简单字符 Jaccard 相似度(中英文通用) */
function similarity(a: string, b: string): number {
  const sa = new Set(a.split(""));
  const sb = new Set(b.split(""));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter++;
  return inter / (sa.size + sb.size - inter);
}

async function fetchWithTimeout(url: string, ms: number, init: any): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}

/**
 * 批量压缩, 输入输出 Map (id -> 原 -> 新). 失败 -> 抛错(调用方决定逐条降级还是整体跳过).
 * 串行调用, 不并发, 避免触发限流(平台 LLM 共享并发=3, 见 with-retry.ts).
 */
export async function llmShortenTitles(rows: Row[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.text.length <= (r.kind === "skill" ? SKILL_NAME_MAX : TITLE_MAX)) {
      out.set(r.id, r.text);
      continue;
    }
    try {
      out.set(r.id, await llmShortenOne(r.text, r.kind));
    } catch (e) {
      // 单条失败 -> 抛错, 调用方选择整体跳过(记录后回退)或中止
      throw new Error("refine " + r.id + " 失败: " + (e instanceof Error ? e.message : String(e)));
    }
  }
  return out;
}

/**
 * 2026-10-09 round 72-B: 一次 LLM 调用产出 name+summary+tags 三件套 (走 round 70 落地的人类口径)
 *
 * 设计动机: round 72-B 要批量给 39,545 Skill 起合规短名 + 摘要 + 标签。
 *   之前 round 69 的 llmShortenOne 只产出 name; 摘要/标签要么走产品契约的本地归一(没 LLM 智能),
 *   要么再单独调 LLM(3x 调用 = 12 万次)。本函数**一次调用出三件**, 把 LLM 调用数砍到 1/3。
 *
 * 输出: { name, summary, tags[] } —— 已**本地**归一(name 无省略、<= 上限; tags <= 8 / 每个 <=12; summary <= 80)
 * 失败: 抛 LlmError 子类(Auth/Empty/TooLong/Suspicious/Net, 沿用前两轮契约)
 *
 * 不用 LLM 的路径(本函数不做, 留给 caller):
 *   - 文本 <= 上限: caller 应跳过本函数, 自行用归一/默认值(LLM 调用贵)
 *   - 整条记录已被 keep-existing 命中: caller 应跳过
 */
export type DescribeResult = { name: string; summary: string; tags: string[] };

export async function llmDescribeRow(text: string, kind: Row["kind"]): Promise<DescribeResult> {
  if (!API_KEY) throw new LlmAuthError("LLM API key 未配置 (ANTHROPIC_AUTH_TOKEN / MINIMAX_API_KEY)");
  const t = String(text ?? "").trim();
  if (!t) throw new LlmEmptyError("空文本");
  const limit = kind === "skill" ? SKILL_NAME_MAX : TITLE_MAX;
  // 这里**不**做"<= limit 就直接返回": 摘要和标签是缺的, 必须调 LLM; 名字本身可能已合规但仍要走 LLM 拿摘要+标签。
  // 调用方应该自己用本系列函数的责任:
  //   - 已知完整(已有合规 name + 摘要 + 标签): 跳过本函数, 直接 upsert
  //   - 缺任一: 调本函数补全
  // 这里保留兼容性: 文本极短也允许(LLM 仍能给合理的 name+summary+tags)。
  const sysPrompt = (
    "你是一名技能/知识命名与摘要助手. 输入一条" + (kind === "skill" ? "技能" : (kind === "memory" ? "记忆" : (kind === "practice" ? "实践" : "知识"))) +
    "(原文本可能超长), 你的任务是同时产出**三件套**, 严格按 JSON 返回, 不要解释.\n" +
    "**严格约束**:\n" +
    "1. 返回**单个 JSON 对象** (不要 markdown, 不要 ```), 形如 {\"name\":...,\"summary\":...,\"tags\":[...]}。\n" +
    "2. name <= " + limit + " 字, 不含省略号, 不含标点(句末不要 . 之类), 优先保留最有区分度的关键词.\n" +
    "3. summary <= 80 字, 一句话给出 takeaway; 描述它的**适用场景**或**要做什么**.\n" +
    "4. tags 是 JSON 数组, 长度 2-6, 每个 <= 12 字, 去重(不区分大小写), 推荐技术名词或动词短语, 不要用 # 前缀.\n" +
    "5. **不得引入原文本没有的概念**; 不得包含 markdown / emoji.\n"
  );
  const userPrompt = "原文本:\n" + t.slice(0, 2000) + "\n\n按约束返回 JSON 三件套:";
  let attempt = 0, lastErr: Error | null = null;
  while (attempt <= MAX_RETRIES) {
    try {
      const res = await fetchWithTimeout(ENDPOINT, TIMEOUT_MS, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          messages: [{ role: "user", content: sysPrompt + "\n\n" + userPrompt }],
        }),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new LlmAuthError("HTTP " + res.status);
        throw new LlmNetError("HTTP " + res.status + ": " + (await res.text().catch(() => "")));
      }
      const j = await res.json();
      const raw = extractContent(j);
      const parsed = parseDescribeJson(raw, limit, t);
      return parsed;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      attempt++;
      if (e instanceof LlmAuthError) throw e;
      if (attempt > MAX_RETRIES) throw e instanceof LlmError ? e : new LlmNetError(lastErr.message);
    }
  }
  throw new LlmError(lastErr?.message || "未知失败");
}

/** 从 LLM 响应里抠出 JSON 三件套(容错: 去 ```json 围栏、去前导说明文字) */
function parseDescribeJson(raw: string, limit: number, originalText: string): DescribeResult {
  if (!raw) throw new LlmEmptyError("LLM 输出为空");
  let s = String(raw).trim();
  // 去常见 markdown 围栏
  s = s.replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\`\`\`\s*$/, "");
  // 找首个 { 与最后匹配的 } 之间的内容(LLM 偶尔在 JSON 前加一句"好的, ...")
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) throw new LlmSuspiciousError("LLM 输出找不到 JSON 对象: " + s.slice(0, 200));
  let json: any;
  try { json = JSON.parse(s.slice(first, last + 1)); }
  catch (e) { throw new LlmSuspiciousError("LLM 输出 JSON 解析失败: " + String(e).slice(0, 160) + " raw=" + s.slice(0, 200)); }
  // 抽取并本地归一(name/summary/tags 都走产品契约的归一函数; 这与 lib/prisma.ts 写入钩子同源)
  const { normalizeSkillName, normalizeSkillSummary, normalizeSkillTags } = require("@lions/product-contract");
  const name = normalizeSkillName(String(json.name ?? ""), { max: limit });
  if (!name) throw new LlmEmptyError("LLM 输出 name 为空/归一后为空");
  if (name.length > limit) throw new LlmTooLongError("name 归一后仍 > " + limit + ", 实际 " + name.length);
  if (/\u2026|\.\.\./.test(name)) throw new LlmSuspiciousError("name 含省略号: " + name);
  const summary = normalizeSkillSummary(String(json.summary ?? ""));
  if (summary && /\u2026|\.\.\./.test(summary)) {
    // summary 严格不省略——若 LLM 给了省略号, 截掉再归一
    const trimmed = summary.replace(/[\u2026]|\.\.\./g, "");
    const redone = normalizeSkillSummary(trimmed);
    if (redone) return { name, summary: redone, tags: normalizeSkillTags(json.tags ?? []) };
  }
  const tags = normalizeSkillTags(json.tags ?? []);
  // 2026-10-09 round 72-D 修(实测: 本检查是本轮回填 57% 失败率的**唯一**主因):
  //   原实现拿**压缩后的短名**去比**整段原文**做字符 Jaccard。短名 ~12 字、原文 1000+ 字且字符集 ~300,
  //   Jaccard 上限只有 ~0.04 —— **即使名字完全忠实也必然低于 0.3 阈值**。
  //   实测 153+19 次 LlmSuspiciousError 全是「相似度太低(0.21~0.29)」, 成功案例的名字其实都没问题。
  //   修法: 比**原名的首行**(调用方传的是 原名+换行+正文, 首行就是原名), 长度量级一致, Jaccard 才有意义。
  const originalName = String(originalText).split("\n")[0].trim();
  const ref = originalName.length >= 2 ? originalName : String(originalText).slice(0, 80);
  const sim = similarity(name, ref);
  if (sim < 0.3) {
    throw new LlmSuspiciousError("name 与原名相似度太低(" + sim.toFixed(2) + ") name=" + name + " 原名=" + ref.slice(0, 40));
  }
  return { name, summary: summary || "", tags };
}
