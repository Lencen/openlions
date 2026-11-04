/**
 * Runtime token reader — reads ANTHROPIC_AUTH_TOKEN from .env.local at runtime.
 * Bypasses Next.js env var loading issues.
 *
 * 2026-09-15 (finding f-001, reflection cmt8hip0o5puvqbolnhuxzic2, theme 「飞轮闭环」):
 *   实测根因不是"process.env 为空", 而是 packages/apps/selfimproving/.env.local 里残留了一条
 *   **占位 token**(sk-cp-test-... , 32 字符)遮蔽了 .env 中的真实 key(125 字符) ——
 *   Next.js 的 env 优先级是 .env.local > .env, 于是 dev server 拿到的是 32 字符假 key,
 *   每次 LLM 调用都 401 -> task-generator 静默 fallback heuristic, 全平台以为"token 为空".
 *   本模块原来只要文件里有一行非空非 *** 的值就采信 -> 占位符同样被当有效 key 使用, 故障被吞掉.
 *
 * 加固(根因修复, 非症状):
 *   1) 显式识别占位/掩码 token 并**拒绝**, 按 .env.local -> process.env -> .env 顺序取第一个可用值;
 *   2) 全部不可用时, 打印每个候选来源及其长度/拒绝原因, **不再静默返回空**;
 *   3) 成功时打印实际取用的来源, 使 "using LLM / fallback heuristic" 可观测.
 */
import * as fs from "fs";
import * as path from "path";

let _cachedToken: string | null = null;

/** 占位符/掩码 token 识别: 常见于 .env 模板与联调残留, 绝不能当真实 key 使用. */
const PLACEHOLDER_RE =
  /(^|[-_])(test|testing|placeholder|dummy|fake|sample|example|your[-_]?key|change[-_]?me|todo)([-_]|$)|^\*\*\*$|^<.*>$/i;

export function isUsableToken(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (t.length < 20) return false;
  if (t === "***") return false;
  return !PLACEHOLDER_RE.test(t);
}

/** 从任意 env 文件里取 key 的原始值(不设默认). */
function readKeyFromFile(file: string, key: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const content = fs.readFileSync(file, "utf8");
  const prefix = key + "=";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  }
  return undefined;
}

export function getAnthropicToken(): string {
  if (_cachedToken) return _cachedToken;

  const candidates: Array<{ src: string; val: string | undefined }> = [
    // 1) .env.local —— 运行时直读, 不受 Next 加载顺序影响(且 Next 也以它为准)
    { src: ".env.local", val: readKeyFromFile(path.resolve(process.cwd(), ".env.local"), "ANTHROPIC_AUTH_TOKEN") },
    // 2) process.env —— Next dev server 已注入的值
    { src: "process.env", val: process.env.ANTHROPIC_AUTH_TOKEN },
    // 3) .env —— 兜底(仅当 .env.local 缺失/占位时)
    { src: ".env", val: readKeyFromFile(path.resolve(process.cwd(), ".env"), "ANTHROPIC_AUTH_TOKEN") },
  ];

  for (const c of candidates) {
    if (isUsableToken(c.val)) {
      _cachedToken = c.val.trim();
      console.info(`[token-reader] using ANTHROPIC_AUTH_TOKEN from ${c.src} (len=${_cachedToken.length})`);
      return _cachedToken;
    }
  }

  const detail = candidates
    .map((c) => {
      if (c.val === undefined) return `${c.src}=missing`;
      return `${c.src}=len${c.val.trim().length}${isUsableToken(c.val) ? "" : "(rejected: placeholder/masked)"}`;
    })
    .join(", ");
  console.error(`[token-reader] 无可用 ANTHROPIC_AUTH_TOKEN -> LLM 将不可用/fallback heuristic: ${detail}`);
  return "";
}

export function resetAnthropicTokenCache(): void {
  _cachedToken = null;
}

export function getAnthropicBaseUrl(): string {
  const fromLocal = readKeyFromFile(path.resolve(process.cwd(), ".env.local"), "ANTHROPIC_BASE_URL");
  if (fromLocal) return fromLocal;
  return process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
}

export function getAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL || "MiniMax-M3.1-Flash";
}
