/**
 * external-fault.ts — 执行体通道级故障识别（2026-10-23）
 *
 * 目标：把"平台/通道挂了"与"agent 没干好"分开。前者不该计入 agent 质量、也不该让任务在租约里耗到 TTL。
 * 识别对象（实测样本）：cli_error + 401 Authentication Fails、compaction/summarization failed、
 *   RATE_LIMIT/429、openclaw/hermes 超时、执行体空输出、"本通道无工具"自述。
 * 注意：只认**强特征**，避免把正常产出里的"提到超时"误判成故障。
 */
export type ExternalFault = { fault: boolean; kind: string; evidence: string };

const PATTERNS: Array<{ kind: string; re: RegExp; maxLen?: number }> = [
  { kind: "auth_401", re: /401\s*Authentication Fails|api key[^\n]{0,40}is invalid|InvalidSubscription|invalid_api_key/i },
  { kind: "cli_error", re: /"type"\s*:\s*"cli_error"|cli_error:/i },
  { kind: "compaction", re: /Preflight compaction required|Compaction safeguard could not summarize|summarization_failed/i },
  { kind: "rate_limit", re: /RATE_LIMIT|rate limit|429 Too Many/i },
  { kind: "timeout", re: /openclaw 超时|hermes 超时|ETIMEDOUT|timed out|socket hang up/i },
  { kind: "empty_output", re: /执行体空输出|\brc=1\b[^\n]{0,20}空/i },
  // 只在"纯回执"（很短的输出）里认这一条：实测 agent-c 的真实产出末尾也带这句
  //   [诚实标注] 本通道无工具 的模板话术，但正文有 ssh/命令等真实执行 —— 一律当外部故障会把真活扔掉。
  { kind: "no_tool_channel", re: /本通道无工具|本通道 0 工具/, maxLen: 400 },
];

export function classifyExternalFault(text: string): ExternalFault {
  const t = String(text || "");
  for (const p of PATTERNS) {
    if (p.maxLen && t.length > p.maxLen) continue;
    const m = t.match(p.re);
    if (m) return { fault: true, kind: p.kind, evidence: String(m[0]).slice(0, 120) };
  }
  return { fault: false, kind: "", evidence: "" };
}
