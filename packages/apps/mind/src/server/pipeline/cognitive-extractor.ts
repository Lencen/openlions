import type {
  ParsedConversation,
  ExtractedCognitiveData,
  ConversationMessage,
} from "./types";
// P1-C 2026-08-31: LLM 调用观测
import { recordLlmCall } from "./llm-observability";
// P0-3 2026-09-01: 全局并发信号量
import { withLlmConcurrency } from "./with-retry";
// 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套硬约束常量化引用
//   避免在 prompt 里复制 5 类产物硬约束 → 漂移即格式混乱(根因)
//   详见 flywheel-prompt-constraints.ts 顶部注释
import { V3_FIVE_PIECE_HARD_RULES, validateFlywheelProduct } from "./flywheel-prompt-constraints";
// 2026-10-07 P4: domain 受控投影(见 enum-projection.ts 的 domain 段)
import { projectDomain, projectCategory } from "./enum-projection";

const EXTRACTION_SYSTEM_PROMPT = `你是一个认知数据提取器，专门从 Claude Code 工作对话中提取有价值的认知数据。

你的任务是分析对话内容，识别并提取以下类型的认知数据。只提取真正有价值的数据，不要为了填充而创建低质量或泛泛而谈的记录。

**重要规则**:
1. content 必须是自然语言描述,不要返回 JSON 字符串或原始日志
2. theme 必须从以下标准主题列表中选择,不要自创:
   任务管理/环境配置/数据管理/功能验证/进程管理/API认证/错误处理/并发安全/文档管理/Pipeline/路由切换/路由管理/端口管理/硬件迁移/数据同步/字段映射/飞轮闭环/飞轮链路/飞轮空转/飞轮架构/项目结构/项目架构/问题解决/验证流程/验收标准/链路诊断/其他
3. 如果对话内容不属于任何标准主题,用"其他"

可提取的数据类型：

1. **记忆 (memories)** - 重要的上下文、决策、偏好、工作经验
   - tier: HOT(近期关键，频繁引用)/WARM(有用参考)/COLD(归档备查)
   - type: DECISION(决策)/PREFERENCE(偏好)/EXPERIENCE(经验)/CONTEXT(上下文)
   - valueScore: 0-1（越重要越高）
   - **theme (2-6字中文主题词, 必填)**: 例如 "端口管理" / "异步操作" / "环境配置" / "数据初始化"

2. **知识 (knowledge)** - 陈述性知识(概念/原理/事实/判断): 回答"是什么/为什么", 给 AI 提供背景、约束与事实; 不含执行步骤(步骤放 skills)
   - **必含三要素**: conclusion(一句话判断/结论: 是什么/为什么成立) / principle(原理·机制: 为什么) / boundary(适用边界·限制: 什么条件下成立/不成立); 原理/边界各一两句即可, 不要求长篇
   - 可选: evidence(事实/依据: 支撑结论的证据或来源) / caseExample(案例: 帮助复述与迁移理解)
   - category: FRONTEND/BACKEND/DEVOPS/DESIGN/PRODUCT/PROCESS/OTHER
   - confidence: 0-1（确定程度）
   - **theme (2-6字中文主题词, 必填)**
   - 判别(优先知识, 勿过度收缩): 能从对话归纳出可复用判断+适用条件+理由 → 放 knowledge(即使理由简短); 纯执行过程/无结论的操作记录 → 步骤放 skills, 经验放 memories; 只对"确实只有一句孤证、无任何边界理由"的单句才放 memories(type=EXPERIENCE)

3. **反思 (reflections)** - 遇到的问题、学到的教训、改进方向
   - priority: P1(紧急重要)/P2(重要)/P3(一般)
   - score: 0-1（反思深度和价值）
   - **theme (2-6字中文主题词)**: 例如 "端口管理" / "异步操作" / "环境配置" / "数据初始化" / "并发安全" / "错误处理" / "性能优化"
   - **category**: 限定 WORKFLOW / TECH / PRODUCT / PROCESS / TOOL
   - **structuredImprovements (数组)**: 替代旧的 improvements 字符串
     - 元素: {text: "具体改进", severity: "P1|P2|P3", area: "涉及的项目/模块路径"}
   - **actionType**: CREATE_TASK(可建任务) / UPDATE_SKILL(更新技能) / ADD_KNOWLEDGE(补知识) / ALERT(严重风险) / NONE(无需行动)
   - **actionConfidence (0-1)**: 对 actionType 的信心
   - **relatedRefs**: {memories: [id], knowledge: [id], sessions: [id], problems: [id]}
   - **rootCauseAnalysis (50-200字)**: 反思的根本原因
   - **proposedPlan (3-7行)**: 改进实施步骤, 每行一步
   - **processingVersion**: 固定 "v3"

4. **实践 (practices)** - 实际完成的工作、构建的功能、修复的bug
   - type: FEATURE(功能开发)/BUGFIX(修复)/REFACTOR(重构)/INTEGRATION(集成)/OTHER
   - outcome: SUCCESS(完全成功)/PARTIAL(部分完成)/FAILED(失败)
   - qualityScore: 0-1
   - difficulty: 1-5
   - **theme (2-6字中文主题词, 必填)**

5. **技能 (skills)** - 可重复执行的完整方法,必须含明确执行步骤 (docs/SKILL-SPEC.md 规范)
   - **铁律: 无 steps 不成 skill**。提不出具体步骤的,降为 knowledge(陈述性判断); 反之, knowledge 里出现完整可执行步骤序列 → 必须放 skills
   - name: 中文动宾短语 (如 "端口占用诊断"), 不填工具名熟练度
   - trigger: 适用场景,什么时候该用 (一句话)
   - content (steps): 执行步骤,markdown 编号步骤,每步含可直接执行的命令/路径/参数
   - pitfalls: 已知坑 (可选)
   - verification: 验证方法,怎么确认执行成功 (如期望的命令输出/HTTP 状态)
   - 判别: "用了某工具" / "某技术熟练度" 不是技能,是 knowledge;只有"一套可重复的操作序列"才是技能

重要规则：
- **每条 content/description 必须 ≥ 30 字**, 且有具体信息(命令/路径/参数/结论), 不接受空泛概括
- **工具调用、代码执行、bug 修复过程也包含认知数据** -- 从中提取的命令、路径、配置、教训都是认知数据
- 只有纯寒暄、无任何技术内容的对话才返回空 []
- **知识/技能边界**: "是什么/为什么" → knowledge(陈述性, 优先产出); "怎么做/命令步骤/流程/SOP" → skills(程序性); 无法归纳边界与理由的单句经验 → memories(type=EXPERIENCE)
- **输出量(防饿死)**: knowledge 每会话 0~4 条——只要出现可复用的判断/结论(即使原理与边界各一两句), 就必须产出 knowledge, 不要因为严格而输出空数组; memories 每会话 0~8 条
- **theme 必须从以下标准主题中选, 不要自创新词**:
  任务管理 / 环境配置 / 数据管理 / 功能验证 / 进程管理 / API认证 / 错误处理 / 并发安全 / 文档管理 / Pipeline / 端口管理 / 版本管理 / 凭证管理 / 路由切换 / 前端交互 / MCP接入 / 其他
- title 必须 ≥ 4 字, 描述本条核心
- tags 用中文逗号分隔
- 总结(summary)用一句话概括对话核心内容（20-50字）

你必须且只能返回一个合法的 JSON 对象，不要包含 markdown 代码块标记(\`\`\`json)，不要包含任何其他文字说明。

${V3_FIVE_PIECE_HARD_RULES}`;

// P1-B 2026-08-31: tool 结果截断长度 (DSH 会话 tool 消息多且长, 防止 prompt 膨胀)
const TOOL_RESULT_MAX = 300;

/**
 * 单条消息渲染 — 统一处理 user/assistant/tool/system 四种角色
 * - user → Lion, assistant → Claude (保持历史格式)
 * - tool → [工具结果: name] + 截断内容 (只保留工具身份与关键输出)
 * - system → 跳过 (DSH 运行时上下文快照等注入是噪声, 不进提取 prompt)
 */
function formatMessage(msg: ConversationMessage): string {
  if (msg.role === "system") return "";
  if (msg.role === "tool") {
    const name = msg.toolName ? `:${msg.toolName}` : "";
    const content = (msg.content || "").slice(0, TOOL_RESULT_MAX);
    return `**[工具结果${name}]** ${content}`;
  }
  const role = msg.role === "user" ? "Lion" : "Claude";
  return `**[${role}]** ${msg.content}`;
}

function formatConversation(conversation: ParsedConversation): string {
  const parts: string[] = [];
  parts.push(`## 对话标题: ${conversation.title || "无标题"}`);
  parts.push(
    `## 项目: ${conversation.projectName} (共 ${conversation.messageCount} 条消息)`
  );
  if (conversation.startTime) {
    parts.push(`## 时间: ${conversation.startTime}`);
  }
  parts.push("");
  parts.push("---");
  parts.push("");
  for (const msg of conversation.messages) {
    const line = formatMessage(msg);
    if (line) {
      parts.push(line);
      parts.push("");
    }
  }
  return parts.join("\n");
}

function buildExtractionPrompt(conversation: ParsedConversation): string {
  const formatted = formatConversation(conversation);
  return `${formatted}

请分析以上对话，提取认知数据。以如下 JSON 格式返回（不要包含 markdown 代码块标记）：

{
  "summary": "一句话总结",
  "memories": [
    {"content": "...", "title": "...", "tier": "HOT|WARM|COLD", "type": "DECISION|PREFERENCE|EXPERIENCE|CONTEXT", "domain": "领域", "tags": "标签1,标签2", "valueScore": 0.8, "theme": "主题词"}
  ],
  "knowledge": [
    {"title": "...", "conclusion": "一句话判断/结论(是什么/为什么成立)", "principle": "原理/机制(为什么)", "evidence": "事实/依据(可选)", "boundary": "适用边界/限制(何时成立/不成立)", "caseExample": "案例(可选)", "category": "FRONTEND|BACKEND|...", "tags": "标签", "confidence": 0.7, "theme": "主题词"}
  ],
  "reflections": [
    {"title": "...", "description": "...", "category": "类别", "priority": "P1|P2|P3", "lesson": "学到的教训", "improvements": "改进方向", "score": 0.6, "theme": "主题词"}
  ],
  "practices": [
    {"title": "...", "description": "...", "type": "FEATURE|BUGFIX|REFACTOR|INTEGRATION|OTHER", "outcome": "SUCCESS|PARTIAL|FAILED", "qualityScore": 0.8, "difficulty": 3, "theme": "主题词"}
  ],
  "skills": [
    {"name": "动宾短语技能名", "category": "类别", "description": "一句话概述", "trigger": "适用场景", "content": "1. 步骤一(含命令)\\n2. 步骤二(含命令)", "pitfalls": "已知坑", "verification": "验证方法"}
  ]}`;
}

function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();
  // Strip markdown code blocks
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  // If response doesn't start with { or [, try to extract JSON from text
  // (LLM may return "I'll analyze...\n\n{...}" or "Here is the result:\n{...}")
  if (cleaned && !cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    const jsonStart = cleaned.search(/[\[{]/);
    if (jsonStart >= 0) {
      // Find the matching closing bracket
      const openCh = cleaned[jsonStart];
      const closeCh = openCh === "{" ? "}" : "]";
      let depth = 0, inStr = false, esc = false;
      let lastClose = -1;
      for (let i = jsonStart; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === openCh) depth++;
        if (ch === closeCh) { depth--; if (depth === 0) { lastClose = i; break; } }
      }
      if (lastClose > jsonStart) {
        cleaned = cleaned.slice(jsonStart, lastClose + 1);
      }
    }
  }
  return cleaned;
}

/**
 * v3 fix: LLM 偶尔会输出带尾部逗号/多嵌套引号/转义错的 JSON,
 * 严格 JSON.parse 会抛 Unterminated string / Expecting ',' delimiter.
 * 这里做几轮渐进修复: 截到第一个完整对象 → 去尾逗号 → 修补引号.
 * 全部失败再抛原错 (让 DLQ 接住, 不静默吞错).
 */
function safeJsonParse<T = unknown>(text: string): T {
  const cleaned = cleanJsonResponse(text);
  // P2-8 fix (2026-07-15): 空字符串 case (LLM 返回空 response) → 直接抛清晰错
  // 之前 attempts[0] = '' → JSON.parse('') 抛 "Unexpected end of JSON input"
  // 端到端验证发现: session app 47 PENDING 重跑时 LLM 返回空, 全 FAILED
  // 抛清晰错 (而不是 "Unexpected end of JSON input") 方便 caller 区分"LLM 返回空"vs"JSON 损坏"
  if (!cleaned) {
    throw new Error('safeJsonParse: LLM 返回空 response (cleaned.length=0), 无法解析为 JSON');
  }
  const attempts: Array<() => string> = [
    // 1. 直接解析
    () => cleaned,
    // 2. 截到第一个 {/[ 平衡点, 丢掉尾部
    () => {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      return end > 0 ? cleaned.slice(0, end) : cleaned;
    },
    // 3. 去尾逗号 + 单引号→双引号
    () => cleaned.replace(/,(\s*[}\]])/g, "$1").replace(/'/g, '"'),
    // 4. 转义 value 里的中/英未转义嵌套双引号 + 中文引号 (最常见故障源)
    () => {
      // 把 `"任务调度"` / `"知识 "点1"` 中的裸引号转义
      // 策略: 在 " : "..." 到下一个 ", or } 之间, 将中间的 " 全部 \\
      // 简化: 把常见中文引号 " " ' ' 替换成合法的引号
      let s = cleaned.replace(/[""]/g, '\\"').replace(/['']/g, "'");
      s = s.replace(/,(\s*[}\]])/g, "$1");
      return s;
    },
    // 5. 兜底: 抽取第一个 { 到最后一个 } 的子串
    () => {
      const start = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");
      return start >= 0 && last > start ? cleaned.slice(start, last + 1) : cleaned;
    },
    // 6. P2-6 fix v9: unclosed string 截断到开引号前 + 补 depth close
    //    解决 "Unterminated string in JSON at position 10615" 类故障
    //    之前 v1-v8 各种尝试都失败 (闭合后 garbage, depth 永不归 0, 等)
    //    v9 算法: 找 unclosed 开引号, 截到那之前, 补 " 闭合 value, 再补 stack depth close
    () => {
      // 第一步: 找 unclosed 开引号
      let inStr = false, esc = false;
      const unclosedOpens: number[] = [];
      for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') {
          if (inStr) {
            if (unclosedOpens.length > 0) unclosedOpens.pop();
          } else {
            unclosedOpens.push(i);
          }
          inStr = !inStr;
        }
      }
      // 第二步: 截到最后一个 unclosed 开引号之前, 补 "" 作为空 value
      let candidate = cleaned;
      if (inStr && unclosedOpens.length > 0) {
        const lastUnclosed = unclosedOpens[unclosedOpens.length - 1];
        candidate = cleaned.slice(0, lastUnclosed) + '""';
      }
      // 第三步: 找 stack, 补 depth close
      const stack: string[] = [];
      let esc2 = false, inStr2 = false;
      for (let i = 0; i < candidate.length; i++) {
        const ch = candidate[i];
        if (esc2) { esc2 = false; continue; }
        if (ch === "\\") { esc2 = true; continue; }
        if (ch === '"') { inStr2 = !inStr2; continue; }
        if (inStr2) continue;
        if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") {
          const top = stack[stack.length - 1];
          if (top && ((top === "{" && ch === "}") || (top === "[" && ch === "]"))) {
            stack.pop();
          }
        }
      }
      let closer = "";
      for (let i = stack.length - 1; i >= 0; i--) {
        closer += stack[i] === "[" ? "]" : "}";
      }
      candidate = candidate + closer;
      return candidate;
    },
    // 7. P2-9 fix v10: position 锚定修复 (新增第 7 轮)
    //    解决 "Expected ',' or '}' at position 7504" / "Expected double-quoted property name at position 11038"
    //         / "Expected ',' or ']' at position 6925" / "Unterminated string at 10993" 类中段断故障
    //    算法: 利用 JSON.parse 报的 position, 截断到 position 之前 (策略 A)
    //          或找上一个 separator (`,` / `:`), 截断到那之后 (策略 B)
    //          再补 stack depth close
    //    端到端发现: 8 批 47 PENDING 跑下来 7 个 JSON 损坏
    //    v10 预期: 还能救 ~6 个 PROCESSED, PENDING 1 → 0
    () => {
      // 取 firstErr 的 position 信息
      const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      const m = errMsg.match(/at position (\d+)/);
      if (!m) return cleaned;
      const pos = parseInt(m[1]);
      if (pos <= 0 || pos >= cleaned.length) return cleaned;
      // 策略 A: 截断到 pos
      const truncatedA = cleaned.slice(0, pos);
      const stackA: string[] = [];
      let escA = false, inStrA = false;
      for (let i = 0; i < truncatedA.length; i++) {
        const ch = truncatedA[i];
        if (escA) { escA = false; continue; }
        if (ch === "\\") { escA = true; continue; }
        if (ch === '"') { inStrA = !inStrA; continue; }
        if (inStrA) continue;
        if (ch === "{" || ch === "[") stackA.push(ch);
        else if (ch === "}" || ch === "]") {
          const top = stackA[stackA.length - 1];
          if (top && ((top === "{" && ch === "}") || (top === "[" && ch === "]"))) stackA.pop();
        }
      }
      let candidateA = truncatedA + (inStrA ? '"' : '');
      let closerA = '';
      for (let i = stackA.length - 1; i >= 0; i--) closerA += stackA[i] === "[" ? "]" : "}";
      const tryA = candidateA + closerA;
      try { return JSON.parse(tryA); } catch {}
      // 策略 B: 找上一个 separator (`,` / `:`) 截断
      let lastSep = -1;
      for (let i = pos - 1; i >= 0; i--) {
        const ch = cleaned[i];
        if (ch === ',' || ch === ':') { lastSep = i + 1; break; }
      }
      if (lastSep <= 0) return cleaned;
      const truncatedB = cleaned.slice(0, lastSep);
      const stackB: string[] = [];
      let escB = false, inStrB = false;
      for (let i = 0; i < truncatedB.length; i++) {
        const ch = truncatedB[i];
        if (escB) { escB = false; continue; }
        if (ch === "\\") { escB = true; continue; }
        if (ch === '"') { inStrB = !inStrB; continue; }
        if (inStrB) continue;
        if (ch === "{" || ch === "[") stackB.push(ch);
        else if (ch === "}" || ch === "]") {
          const top = stackB[stackB.length - 1];
          if (top && ((top === "{" && ch === "}") || (top === "[" && ch === "]"))) stackB.pop();
        }
      }
      let candidateB = truncatedB + (inStrB ? '"' : '');
      let closerB = '';
      for (let i = stackB.length - 1; i >= 0; i--) closerB += stackB[i] === "[" ? "]" : "}";
      return candidateB + closerB;
    },
  ];
  let firstErr: unknown = null;
  for (const gen of attempts) {
    try { return JSON.parse(gen()) as T; }
    catch (e) { if (!firstErr) firstErr = e; }
  }
  throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
}

/**
 * 2026-08-21 agent-x: 错误分类
 * - RATE_LIMIT (429): 退避后重试, 不计入永久失败
 * - SERVER_ERROR (5xx): 退避后重试
 * - AUTH_ERROR (401/403): 不重试, 配置问题
 * - SCHEMA_INVALID: JSON 解析失败, 不重试
 * - NETWORK: 网络异常, 重试 1 次
 * - UNKNOWN: 其他
 */
export type LLMErrorType =
  | "RATE_LIMIT"
  | "SERVER_ERROR"
  | "AUTH_ERROR"
  | "SCHEMA_INVALID"
  | "NETWORK"
  | "ABORTED"   // P1-A 2026-08-31: route 层 abort 触发
  | "TIMEOUT"
  | "UNKNOWN";

export interface ClassifiedError extends Error {
  errorType: LLMErrorType;
  httpStatus?: number;
  rawMessage: string;
}

function classifyError(status: number | undefined, msg: string): LLMErrorType {
  if (status === 429) return "RATE_LIMIT";
  if (status && status >= 500) return "SERVER_ERROR";
  if (status === 401 || status === 403) return "AUTH_ERROR";
  if (/timeout|ETIMEDOUT|aborted/i.test(msg)) return "TIMEOUT";
  if (/network|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(msg)) return "NETWORK";
  if (/Unterminated|Expected|invalid JSON|JSON\.parse|SyntaxError/i.test(msg)) return "SCHEMA_INVALID";
  return "UNKNOWN";
}

async function callMinimax(
  prompt: string,
  retry: number = 0,
  opts?: { systemPrompt?: string; maxTokens?: number; signal?: AbortSignal },
): Promise<string> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
  const model = process.env.ANTHROPIC_MODEL || "MiniMax-M3";
  const maxRetries = parseInt(process.env.LLM_MAX_RETRIES || "1", 10);
  const baseDelayMs = parseInt(process.env.LLM_BASE_DELAY_MS || "2000", 10);
  const maxTokens = opts?.maxTokens || 8192; // 2026-09-04: 4096->8192 降低大会话 JSON 截断

  if (!apiKey) {
    const err = new Error(
      "LLM API key 未配置: 请在 .env.local 加 ANTHROPIC_AUTH_TOKEN=*** 或 MINIMAX_API_KEY=***"
    ) as ClassifiedError;
    err.errorType = "AUTH_ERROR";
    err.rawMessage = err.message;
    throw err;
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  // 使用 Anthropic API 的 system 参数, 让 LLM 更好地遵循角色指令
  if (opts?.systemPrompt) {
    body.system = opts.systemPrompt;
  }

  let response: Response;
  // P1-A 2026-08-31: signal 透传 — route 层 abort 时中止在途 LLM 调用 (防 token 白扣)
  const signal = opts?.signal;
  if (signal?.aborted) {
    const err = new Error("LLM call aborted by signal") as ClassifiedError;
    err.errorType = "ABORTED";
    err.rawMessage = err.message;
    throw err;
  }
  try {
    // P0-3 (2026-09-01): 全局并发信号量 (MiniMax 并发 5 上限, 防 429 空转)
    response = await withLlmConcurrency(() =>
      fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal,
      })
    );
  } catch (e) {
    // fetch 抛异常 = 网络/DNS/TLS 问题 或 abort
    if (signal?.aborted || (e instanceof Error && e.name === "AbortError")) {
      const err = new Error("LLM call aborted by signal") as ClassifiedError;
      err.errorType = "ABORTED";
      err.rawMessage = err.message;
      throw err;
    }
    const err = new Error(
      `Minimax API fetch failed: ${e instanceof Error ? e.message : String(e)}`
    ) as ClassifiedError;
    err.errorType = "NETWORK";
    err.rawMessage = err.message;
    if (retry < maxRetries) {
      const delayMs = baseDelayMs * (retry + 1);
      console.error(`[callMinimax] NETWORK retry ${retry+1}/${maxRetries} in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
      return callMinimax(prompt, retry + 1, opts);
    }
    throw err;
  }

  if (!response.ok) {
    const text = await response.text();
    const status = response.status;
    const errType = classifyError(status, text);
    // RATE_LIMIT / SERVER_ERROR 可重试 (abort 后不再重试)
    if ((errType === "RATE_LIMIT" || errType === "SERVER_ERROR") && retry < maxRetries && !signal?.aborted) {
      const delayMs = baseDelayMs * (retry + 1) * (errType === "RATE_LIMIT" ? 3 : 1); // 429 退避更久
      console.error(`[callMinimax] ${errType} ${status} retry ${retry+1}/${maxRetries} in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
      return callMinimax(prompt, retry + 1, opts);
    }
    // 其他类型: 抛带分类的错, 不重试
    const err = new Error(
      `Minimax API error (${status}, ${errType}): ${text}`
    ) as ClassifiedError;
    err.errorType = errType;
    err.httpStatus = status;
    err.rawMessage = text;
    throw err;
  }

  const json = await response.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
  const textBlocks = json.content?.filter((c) => c.type === "text") ?? [];
  const text = textBlocks.map((c) => c.text ?? "").join("\n");
  // 2026-09-01: 记录真实 usage token (MiniMax 后台按次数计费不展示 token, 平台侧自记)
  try {
    const u = json.usage;
    if (u && typeof u.input_tokens === "number") {
      (globalThis as any).__lastLlmUsage = (u.input_tokens || 0) + (u.output_tokens || 0);
    }
  } catch { /* 观测增强不影响主流程 */ }
  return text || "";
}

export async function extractCognitiveData(
  conversation: ParsedConversation,
  opts?: { signal?: AbortSignal },
): Promise<ExtractedCognitiveData> {
  const prompt = buildExtractionPrompt(conversation);

  // P0-C 2026-08-28: 4096 -> 8192。实测长 session (7 条消息 3000+ 字) 的提取输出
  // JSON 超过 4096 token 被截断 -> "Unexpected end of JSON input" -> 整个 session FAILED。
  // 与批量路径 (extractCognitiveDataBatch, 8192) 对齐。
  const t0 = Date.now();
  let output: string;
  try {
    output = await callMinimax(prompt, 0, {
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      maxTokens: 8192,
      signal: opts?.signal,
    });
  } catch (e: any) {
    recordLlmCall({ entry: "main-extract", ok: false, durationMs: Date.now() - t0, errorType: e?.errorType || "UNKNOWN", promptLength: prompt.length });
    throw e;
  }
  recordLlmCall({ entry: "main-extract", ok: true, durationMs: Date.now() - t0, promptLength: prompt.length, tokenUsed: (globalThis as any).__lastLlmUsage });
  if (!output) {
    throw new Error("Minimax API returned empty output");
  }

  const cleaned = cleanJsonResponse(output);
  const data = safeJsonParse<ExtractedCognitiveData>(cleaned);

  return validateExtractedData(data);
}

// === 批量增量提取: 多 session 合并到一次 callMinimax 调用 ===
// 调用次数从 N 降到 1, 对按次数计费的 Token Plan 更优

export interface BatchSessionInput {
  conversation: ParsedConversation;
  newMessages: ConversationMessage[];  // 只含增量消息 (已截断)
  lastProcessedCount: number;
  sessionIndex: number;  // prompt 中的序号 S1, S2...
}

export interface BatchExtractResult {
  sessionId: string;
  extracted: ExtractedCognitiveData;
}

export async function extractCognitiveDataBatch(
  sessions: BatchSessionInput[],
  opts?: { signal?: AbortSignal },
): Promise<BatchExtractResult[]> {
  if (sessions.length === 0) return [];

  // 1. 合并所有 session 的新消息到一个 prompt
  const sessionParts: string[] = [];
  for (const s of sessions) {
    const conv = s.conversation;
    const parts: string[] = [];
    parts.push(`## Session S${s.sessionIndex}: [${conv.projectName}] ${conv.title || "无标题"}`);
    parts.push(`项目: ${conv.projectName} | 总消息: ${conv.messageCount} | 新增: 第${s.lastProcessedCount + 1}-${s.lastProcessedCount + s.newMessages.length}条 (共${s.newMessages.length}条新消息)`);
    if (conv.startTime) parts.push(`时间: ${conv.startTime}`);
    parts.push("");
    for (const msg of s.newMessages) {
      // P1-B: 统一角色渲染 (tool 截断 / system 跳过)
      const line = formatMessage(msg);
      if (line) {
        parts.push(line);
        parts.push("");
      }
    }
    sessionParts.push(parts.join("\n"));
  }

  const batchBody = sessionParts.join("\n---\n\n");

  const batchInstruction = `\n\n请分析以上 ${sessions.length} 个 session 的对话，分别提取认知数据。以如下 JSON 格式返回（不要包含 markdown 代码块标记）：\n\n{\n  "sessions": [\n    {\n      "sessionIndex": 1,\n      "summary": "一句话总结该 session",\n      "memories": [\n        {"content": "...", "title": "...", "tier": "HOT|WARM|COLD", "type": "DECISION|PREFERENCE|EXPERIENCE|CONTEXT", "domain": "platform|agent-ops|devops|product|data|security|ai", "tags": "标签1,标签2", "valueScore": 0.8, "theme": "主题词"}\n      ],\n      "knowledge": [\n        {"title": "...", "conclusion": "一句话判断/结论(是什么/为什么成立)", "principle": "原理/机制(为什么)", "evidence": "事实/依据(可选)", "boundary": "适用边界/限制(何时成立/不成立)", "caseExample": "案例(可选)", "category": "FRONTEND|BACKEND|DEVOPS|DESIGN|PRODUCT|PROCESS|OTHER", "tags": "标签", "confidence": 0.7, "theme": "主题词"}\n      ],\n      "reflections": [\n        {"title": "...", "description": "...", "category": "WORKFLOW|TECH|PRODUCT|PROCESS|TOOL", "priority": "P1|P2|P3", "lesson": "学到的教训", "improvements": "改进方向", "score": 0.6, "theme": "主题词"}\n      ],\n      "practices": [\n        {"title": "...", "description": "...", "type": "FEATURE|BUGFIX|REFACTOR|INTEGRATION|OTHER", "outcome": "SUCCESS|PARTIAL|FAILED", "qualityScore": 0.8, "difficulty": 3, "theme": "主题词"}\n      ],\n      "skills": [\n        {"name": "动宾短语技能名", "category": "类别", "description": "一句话概述", "trigger": "适用场景", "content": "1. 步骤一(含命令)\\n2. 步骤二(含命令)", "pitfalls": "已知坑", "verification": "验证方法"}\n      ]\n    }\n  ]\n}\n\n重要：sessionIndex 必须对应上面的 S1/S2/... 编号。如果某个 session 没有有价值的认知数据，对应数组返回空 []。注意: skills 必须含完整执行步骤(无 steps 不成 skill); knowledge 必须含 conclusion/principle/boundary 三要素(陈述性, 原理/边界各一两句即可), 内容为步骤/流程/命令的放 skills; 优先把可复用的判断+适用条件+理由产出为 knowledge, 仅对无法归纳边界与理由的单句放 memories(type=EXPERIENCE)。tags 一律逗号分隔字符串, 不要数组。`;

  const fullPrompt = `${batchBody}${batchInstruction}`;

  // 2. 一次 callMinimax 调用处理所有 session
  //    使用 system 参数传递系统角色, max_tokens 提高到 8192 (批量需要更大输出空间)
  const t0 = Date.now();
  let output: string;
  try {
    output = await callMinimax(fullPrompt, 0, {
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      maxTokens: 8192,
      signal: opts?.signal,
    });
  } catch (e: any) {
    recordLlmCall({ entry: "main-extract-batch", ok: false, durationMs: Date.now() - t0, errorType: e?.errorType || "UNKNOWN", promptLength: fullPrompt.length });
    throw e;
  }
  recordLlmCall({ entry: "main-extract-batch", ok: true, durationMs: Date.now() - t0, promptLength: fullPrompt.length, tokenUsed: (globalThis as any).__lastLlmUsage });
  if (!output) {
    throw new Error("Minimax API returned empty output for batch extraction");
  }

  // 3. 解析结果
  const cleaned = cleanJsonResponse(output);
  const data = safeJsonParse<{ sessions: Array<{ sessionIndex: number } & Partial<ExtractedCognitiveData>> }>(cleaned);

  // 4. 按 sessionIndex 找回 sessionId
  const results: BatchExtractResult[] = [];
  for (const sessionData of data.sessions || []) {
    const input = sessions.find(s => s.sessionIndex === sessionData.sessionIndex);
    if (!input) continue;
    const extracted = validateExtractedData(sessionData);
    results.push({
      sessionId: input.conversation.sessionId,
      extracted,
    });
  }

  // 5. 没被 LLM 返回的 session 给空结果
  for (const s of sessions) {
    if (!results.find(r => r.sessionId === s.conversation.sessionId)) {
      results.push({
        sessionId: s.conversation.sessionId,
        extracted: validateExtractedData({}),
      });
    }
  }

  return results;
}

/**
 * P0-A 2026-08-28: tags 归一化为 String。
 * LLM 提示词要求 "tags 用逗号分隔字符串", 但 MiniMax 常输出 JSON 数组,
 * 直接透传会让 Prisma memory.create 抛 PrismaClientValidationError (Argument tags: Expected String)
 * -> 整个 session FAILED。实测于 cron_0ad32b8e55b3_20260828_142532。
 * 归一化: 数组 -> join(","), 字符串 -> trim, 其他 -> ""。
 */
function normalizeTags(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .filter((x) => typeof x === "string" && x.trim())
      .map((x) => (x as string).trim())
      .join(",");
  }
  return "";
}

// P1-1 (2026-09-01) 主题归一化: 同义词映射 (解决认知碎片化, 逻辑优化方案 S2)
//   实测 6 个任务类主题分裂 -> 反思聚合/检索分散; 只合并明显同义, 不误并独立业务
const THEME_SYNONYMS: Record<string, string> = {
  "任务调度监控": "任务调度",
  "任务监控": "任务管理",
  "端口占用": "端口管理",
  "环境变量": "环境配置",
  "pipeline": "Pipeline",
  "PIPELINE": "Pipeline",
  "数据初始化": "数据管理",
  "字段映射": "数据管理",
};

function sanitizeTheme(raw: unknown): string {
  if (typeof raw !== "string") return "未分类";
  const s = raw.trim().replace(/[「」『』\[\]()（）"'“”"`]/g, "").slice(0, 8);
  if (s.length < 2 || s.length > 8) return "未分类";
  // P1-1: 同义词归一化 (映射后超长则截断)
  const mapped = THEME_SYNONYMS[s] || THEME_SYNONYMS[s.slice(0, 4)] || s;
  return mapped.slice(0, 8);
}

function validateExtractedData(
  data: Partial<ExtractedCognitiveData>
): ExtractedCognitiveData {
  const validTiers = ["HOT", "WARM", "COLD"];
  const validMemTypes = ["DECISION", "PREFERENCE", "EXPERIENCE", "CONTEXT"];
  const validPriorities = ["P1", "P2", "P3"];
  const validOutcomes = ["SUCCESS", "PARTIAL", "FAILED"];
  const validPracticeTypes = [
    "FEATURE", "BUGFIX", "REFACTOR", "INTEGRATION", "OTHER",
  ];
  const validSkillLevels = [
    "AWARENESS", "BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT",
  ];

  return {
    summary: data.summary || "",
    memories: (data.memories || [])
      .filter((m) => m.content && m.content.length >= 30)  // 2026-07-02: 提到 30 字
      // 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套格式软验证 (markdown + V3 信号 + 非逃避式)
      .filter((m) => isFlywheelFormatValid(m, "memory"))
      .map((m) => ({
        content: m.content,
        title: m.title || m.content.slice(0, 30),
        tier: validTiers.includes(m.tier) ? m.tier : "WARM",
        type: validMemTypes.includes(m.type) ? m.type : "CONTEXT",
        // 2026-10-07 P4: LLM 的 domain 是自由文本("领域"), 而 Memory.domain 是受控 7 值 —— 原代码
        //   `m.domain || "通用"` 既让自由文本落库, 又用 "通用" 这个假默认值冒充领域(实测污染 71k 行)。
        //   改为投影: 命中枚举 -> 归一; 否则按平台关键词表分类; 仍不中 -> null(未知, 不污染)。
        domain: projectDomain(m.domain, { title: m.title, content: m.content, theme: (m as any).theme }),
        tags: normalizeTags(m.tags),  // P0-A 2026-08-28: LLM 可能输出数组, 必须归一化为 String
        valueScore: Math.min(1, Math.max(0, m.valueScore || 0.5)),
        theme: sanitizeTheme((m as any).theme),
      })),
    knowledge: (data.knowledge || [])
      // 2026-09-04: 兼容两种形态 — 老 content 正文(≥30字) 或 新陈述式三要素(conclusion+boundary)
      .filter((k) => k.title && k.title.length >= 4 && (
        (k.content && k.content.length >= 30) ||
        (k.conclusion && k.boundary)
      ))
      // 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套格式软验证
      .filter((k) => isFlywheelFormatValid(k, "knowledge"))
      .map((k) => ({
        title: k.title || "未命名知识",
        content: k.content || "",
        // 陈述式三要素透传 (db-writer 合成模板正文 + 门禁)
        conclusion: k.conclusion || undefined,
        principle: k.principle || undefined,
        boundary: k.boundary || undefined,
        evidence: k.evidence || undefined,
        caseExample: k.caseExample || undefined,
        // 2026-10-08 round 54: category 受控投影(实测 Knowledge.category 曾 462 种)—— LLM 直出字段
        category: projectCategory(k.category, "knowledge") ?? "OTHER",
        tags: normalizeTags(k.tags),
        confidence: Math.min(1, Math.max(0, k.confidence || 0.5)),
        theme: sanitizeTheme((k as any).theme),
      })),
    reflections: (data.reflections || [])
      .filter((r) => r.description && r.description.length >= 10)
      // 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套格式软验证
      .filter((r) => isFlywheelFormatValid(r, "reflection"))
      .map((r) => {
        // V3: 验证 structuredImprovements 数组
        const validActionTypes = ["CREATE_TASK", "UPDATE_SKILL", "ADD_KNOWLEDGE", "ALERT", "NONE"];
        const validSeverities = ["P1", "P2", "P3"];
        const structuredImprovements = Array.isArray(r.structuredImprovements)
          ? r.structuredImprovements
              .filter((si: any) => si && si.text && si.text.length >= 5)
              .map((si: any) => ({
                text: si.text,
                severity: validSeverities.includes(si.severity) ? si.severity : r.priority || "P2",
                area: si.area || "",
              }))
          : undefined;
        return {
          title: r.title || "未命名反思",
          description: r.description,
          category: ["WORKFLOW", "TECH", "PRODUCT", "PROCESS", "TOOL"].includes(r.category) ? r.category : "TECH",
          priority: validPriorities.includes(r.priority) ? r.priority : ("P3" as const),
          lesson: r.lesson || "",
          improvements: r.improvements || "",
          score: Math.min(1, Math.max(0, r.score || 0.5)),
          // === V3 ===
          theme: r.theme || "未分类",
          actionType: validActionTypes.includes(r.actionType as string) ? (r.actionType as string) : "NONE",
          actionConfidence: r.actionConfidence != null ? Math.min(1, Math.max(0, r.actionConfidence)) : 0,
          structuredImprovements,
          relatedRefs: r.relatedRefs || undefined,
          rootCauseAnalysis: r.rootCauseAnalysis || undefined,
          // proposedPlan: LLM 可能给字符串或数组,统一转字符串(每行一步)
          proposedPlan: Array.isArray(r.proposedPlan)
            ? r.proposedPlan.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => s.trim()).join("\n") || undefined
            : (typeof r.proposedPlan === "string" ? r.proposedPlan : undefined),
          processingVersion: "v3",
        } as unknown as import("./types").ExtractedReflection;
      }),
    practices: (data.practices || [])
      .filter((p) => p.description && p.description.length >= 30 && p.title && p.title.length >= 4)
      // 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套格式软验证
      .filter((p) => isFlywheelFormatValid(p, "practice"))
      .map((p) => ({
        title: p.title || "未命名实践",
        description: p.description,
        type: validPracticeTypes.includes(p.type) ? p.type : "OTHER",
        outcome: validOutcomes.includes(p.outcome) ? p.outcome : ("SUCCESS" as const),
        qualityScore: Math.min(1, Math.max(0, p.qualityScore || 0.5)),
        difficulty: Math.min(5, Math.max(1, Math.round(p.difficulty || 3))),
        theme: sanitizeTheme((p as any).theme),
      })),
    skills: (data.skills || [])
      .filter((s) => s.name)
      // SKILL-SPEC 铁律: 无 steps (content) 不成 skill, 提不出步骤的归 knowledge
      .filter((s) => (s.content || "").trim().length >= 30)
      .map((s) => ({
        name: s.name,
        // 2026-10-08 round 54: Skill.category 同样过投影(实测曾 3,923 种)
        category: projectCategory(s.category, "skill") ?? "OTHER",
        description: s.description || "",
        // SKILL-SPEC 2026-08-28: steps 承载于 content, trigger/verification 必填语义
        content: s.content || "",
        trigger: s.trigger || "",
        verification: s.verification || "",
        pitfalls: s.pitfalls || "",
      })),
    // 无步骤的"技能"降级进 knowledge (类型 PROCESS), 不丢数据
    knowledgeFromSkills: (data.skills || [])
      .filter((s) => s.name && (s.content || "").trim().length < 30)
      .map((s) => ({
        title: s.name,
        content: [s.description, s.content].filter(Boolean).join("\n") || s.name,
        category: "PROCESS",
        theme: "其他",
        confidence: 0.5,
        tags: "skill-downgraded",
      })),
  };
}

// 2026-09-29 todo_0aa1ea6d28a049fba44d: V3 五件套格式软验证 (轻量, 不重试 LLM)
//   不合规 -> 静默 drop (返回 false, 上层 filter 跳过), 不记 FlywheelEvent (避免 G1 飞轮事件流被拒收事件污染)
//   设计: prompt 已注入硬约束, 96.7% 无 markdown 的现状下, 若 reject 太严会让 session 提取 0 产物;
//   守门监控 scripts/check-product-format.cjs 持续观测, 7 日窗口目标降量到 < 5%。
function isFlywheelFormatValid(p: { title?: any; content?: any; description?: any }, kind: "knowledge" | "memory" | "practice" | "reflection" | "skill"): boolean {
  const val = validateFlywheelProduct(
    { title: p.title, content: p.content || p.description },
    { kind, maxTitle: 30 }
  );
  return val.ok;
}