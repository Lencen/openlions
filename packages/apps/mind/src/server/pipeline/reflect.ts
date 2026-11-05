/**
 * V1.5 反思引擎核心 — 主题粒度反思
 * 设计: docs/lions-flywheel-engine-v2-design.md §2.2
 *
 * 输入: 主题全文 (跨 groupKey 聚合) + 该主题所有 4 类产物
 * 处理: chunkIfNeeded 分批 + LLM 反思 (MiniMax-M3 优先, env ANTHROPIC_MODEL fallback 到 M2.7)
 * 输出: FlywheelReflection (theme @unique) + Memory 表同步记录 (D13)
 *
 * 触发源: 整点 cron / 手动 API
 */

import { extractLlmText } from "@/server/llm/extract-text";
import { sessionApiKey } from "@/lib/secret";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma"; // V1 原状, Next.js dev alias 解析
import { PrismaMemoryStore } from "@lions/modules-memory"; // V1.5 §D15: 复用, 不新建统一写入层
// P1-C 2026-08-31: LLM 调用观测
import { recordLlmCall } from "./llm-observability";
// 2026-09-01: LLM API 健康探针 (连续失败暂停反思 1h)
import { recordLlmFailure, recordLlmSuccess } from "./llm-health";
// 2026-09-09 P2.5: finding 选取(近重复/校准/多样性)
import { selectTopFindings } from "./reflect-select";
// 2026-09-10: structuredFindings 归一化(兼容旧信封形态, 防 "fs is not iterable")
import { parseStructuredFindings } from "./findings-parse";
// 2026-09-15 机制修复: 已裁决结单的持久登记 + 跨反思重算重放
import { loadFindingClosures, applyFindingClosures } from "./finding-closure-store";
// 2026-09-14 落地提案 cmtwgdmqu01lu1j768u6qfhag: 主题别名感知计数 (Auto-rotation f-001 "0 条" 根因)
import { themeVariants } from "./resolver";

// ===== 类型定义 =====

export interface ReflectInput {
  theme: string;
  fullMessages: GroupMessage[]; // 主题全文 (跨 groupKey 聚合)
  products: ThemeProducts;
  signal?: AbortSignal;  // P0-3: route 层 timeout 注入
  trigger?: string;      // 2026-09-09 P2: cron | manual
  ioStats?: any;         // 输入审计 {candidateSessions,fetchedSessions,filteredSessions,droppedMessages}
}

export interface GroupMessage {
  id: string;
  role: string;
  content: string;
  timestamp: Date;
  sessionSeq: number;
  sessionTitle: string;
}

export interface ThemeProducts {
  memory: any[];      // Memory[]
  knowledge: any[];   // Knowledge[]
  practice: any[];    // Practice[]
  reflection: any[];  // Reflection[]
}

export interface FlywheelReflectionResult {
  id: string;
  theme: string;
  missedTopics: string[];
  improvements: string[];
  coverageScore: number;
  conflicts: Array<{ memoryIds: string[]; reason: string }>;
  productCounts: { memory: number; knowledge: number; practice: number; reflection: number };
  status: "OK" | "FAILED" | "SKIPPED";
  reportedMemoryIds: string[];
  duration: number;
  attempts: number;
  error?: string;
  structuredFindings?: StructuredFinding[]; // V1.8: 结构化发现
  // ===== 2026-09-09 P2: 触发原因/输入审计/正文总结/覆盖增量 =====
  summary?: string;            // ≤300字 反思正文总结 (LLM 输出)
  sourceStats?: any;           // {candidateSessions,fetchedSessions,filteredSessions,droppedMessages,messages,chunks,truncatedChunks}
  triggerReason?: any;         // {kind,sinceLastHours,newDataSinceLast}
  coverageDelta?: number;      // 本次-上次 coverage
}

// ===== V1.8 StructuredFinding =====

export interface StructuredFinding {
  id: string;                    // "f-001", "f-002" ...
  category: "MISSED_TOPIC" | "CONFLICT" | "IMPROVEMENT" | "DATA_QUALITY" | "COVERAGE_GAP" | "RECURRING";
  what: string;                  // ≤200字
  why: string;                   // ≤200字
  background: string;            // 主题coverage/产物数/对话数/上次反思
  requirement: string;           // ≤300字, 可执行
  acceptance: string;            // ≤200字, 可验证
  priority: "P0" | "P1" | "P2";
  impact: string;                // ≤200字
  // 执行映射
  actionType: "MERGE_CONFLICT" | "RE_EXTRACT" | "CREATE_MEMORY" | "CREATE_PRACTICE" | "CREATE_KNOWLEDGE" | "FIX_DATA" | "MARK_REVIEW";
  evidenceSnippet: string;       // LLM 从对话摘录的关键片段 (≤500字)
  // ===== 2026-09-09 P2 质量自评 (LLM 自评 + 规则兜底) =====
  confidence?: number;          // 0-1 该发现可信度自评
  evidenceStrength?: "强" | "中" | "弱"; // 证据强度
  // 去重与收敛
  dedupHash: string;             // hash(category + what + relatedTopic)
  status: "NEW" | "RECURRING" | "RESOLVED" | "NEEDS_REVIEW"; // NEEDS_REVIEW: 低置信被拦, 待人工复核(见执行器写回)
  firstSeenAt: string;           // ISO
  lastResolvedAt?: string;
  recurrenceCount: number;
  measuredDelta?: number;        // execute 后回填的 coverage delta
  // ===== 2026-09-14 FW-EVIDENCE 机制修复: 关闭必须带可复现证据 =====
  evidenceRef?: string;          // 可复现证据(commit+文件 / SQL+返回 / before->after), 见 evidence.ts
  evidenceKind?: string;         // requireEvidence 判定的种类: code|data|metric
  staleEvidence?: boolean;       // 证据不合格时置位(不得置 RESOLVED)
  needsReviewReason?: string;    // 因缺证据转人审的原因
  needsReviewAt?: string;
  // ===== 2026-09-14 FW-GROW: "前提已不成立/已满足" 关闭审计 =====
  resolutionNote?: string;       // 关闭说明(可读), 与 evidenceRef 一起构成可复算证据
  closureReason?: string;        // 关闭原因码, 目前有 PREMISE_SATISFIED(前提已不成立/acceptance 已满足)
  // 关联数据
  relatedMemoryIds?: string[];
  relatedSessionUids?: string[];
  relatedTopic?: string;
}

// ===== 配置 =====

const SESSION_API_BASE = "http://localhost:3002/api/v1";
const SESSION_API_KEY = sessionApiKey(/* LIONS_SESSION_API_KEY */);
const REFLECT_MODEL = process.env.REFLECT_MODEL || process.env.ANTHROPIC_MODEL || "MiniMax-M3";
// 2026-11-05（Q7-min）：max_tokens 改为可配置，默认 16384。
// 为什么：两条链已切到 thinking 模型（deepseek-flash / M3.1），长反思在 8192 会被截断，
// 表现为 "all chunks failed"，把"模型没答完"误报成"API 不可用"。
const REFLECT_MAX_TOKENS = Number(process.env.REFLECT_MAX_TOKENS || 16384);
const REFLECT_TIMEOUT_MS = 180000; // 单批 LLM 反思 3 分钟 (大 chunk 需要更长)
// 2026-09-01 合并提交优化: 用户套餐按调用次数计费 (token 不限), 应把多次小调用合并为少次大调用
//   原 CHUNK_MAX_TOKENS=12000 -> 单主题 25 chunk = 25 次调用 (碎片化, 调用次数消耗快)
//   现 50000: MiniMax-M3 支持 200K+ 上下文, 50K 输入 + 8K 输出无压力; 单主题调用从 25 次 -> ~2-3 次
const CHUNK_MAX_TOKENS = 50000;
// 2026-11-05（Q7-min）：最近一次 LLM 响应的 stop_reason（模块级，供失败归因读取）
let lastStopReason = "";

// P2-1 2026-08-31: 反思 chunk 预算 + 熔断 (额度烧光事件遗留)
//   2026-09-01: chunk 变大后, 上限 25 -> 6 (50K x 6 = 300K 覆盖超大主题; 常规主题 1-2 chunk)
const MAX_CHUNKS_PER_THEME = 6;
const MAX_CONSECUTIVE_CHUNK_FAILURES = 3;

const FRAMEWORK_PATTERNS = [
  "[CONTEXT COMPACTION",
  "You just executed tool calls",
  "<!-- [PERSONA]",
  "<!-- [SHARED]",
  "<!-- [LOCAL]",
  "Conversation started:",
];

function isFrameworkInjection(content: string): boolean {
  return FRAMEWORK_PATTERNS.some((p) => content.startsWith(p));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const ascii = text.length - cjk;
  return Math.ceil(cjk * 2 + ascii / 4);
}

// P1-A 2026-08-31: 统一 fetch 封装 (原本地重复实现移除)
import { fetchWithTimeout, withLlmConcurrency } from "./with-retry";

/**
 * P4(2026-10-17, 生产不可用修复): **主动让出事件循环**。
 *
 * 为什么必须有它(不是洁癖, 是今晚两次生产不可用的机制):
 *   反思与 mind 的 HTTP 服务**跑在同一个 Node 进程**里。反思维度大(实测单主题 5-6 chunk、
 *   fullMessages 可达数百条、单 chunk ~40k token), 期间有大量**同步**段(逐消息估 token、
 *   切 chunk、拼接 prompt、SimHash 去重、JSON 解析)。Node 的 JS 是单线程 —— 同步段一旦长,
 *   accept()/健康检查/HTTP 回调全部排在它后面, 表现为 `Recv-Q` 堆积(端口 3000 实测 15~39)。
 *   `await` 只能让出**微任务**队列, 让不出 libuv 的 I/O 阶段; 只有 `setImmediate` 会把控制权
 *   交回事件循环的 check 阶段(先处理完已就绪的 I/O, 再回到本任务)。
 *
 * 口径: 这是**协作式**让出 —— 只在显式调用点起作用, 不改变任何业务语义(不丢消息、不改顺序)。
 *   代价是每个让出点多一次事件循环往返(≈微秒级), 相对单主题几十秒的总耗时是噪声。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** 反思同步循环的让出步长(条): 每处理这么多条消息/发现就让出一次。env 可调(夹具/压测用)。 */
function reflectYieldEvery(): number {
  const n = Number(process.env.REFLECT_YIELD_EVERY ?? "200");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 200;
}

/**
 * chunkIfNeeded — 按 session 边界分批, 不跨 session 切
 * 复用 V1 global-organizer.ts#chunkIfNeeded 逻辑 (V1.5 §2.2.2)
 *
 * P4(2026-10-17): 改 async —— 逐消息 `estimateTokens`(对中文正文做全量正则)本身是同步 CPU 段,
 *   fullMessages 可达数百上千条, 一次性跑完会把事件循环顶住(HTTP 期间不可用, 见 yieldToEventLoop 注释)。
 *   本函数**唯一**调用方是 reflect()(现同步改 await), 语义/输出与改前逐字相同(只是中途让出)。
 */
async function chunkIfNeeded(messages: GroupMessage[], maxTokens = CHUNK_MAX_TOKENS): Promise<GroupMessage[][]> {
  const chunks: GroupMessage[][] = [];
  let current: GroupMessage[] = [];
  let currentTokens = 0;
  const every = reflectYieldEvery();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgTokens = estimateTokens(msg.content) + 10;
    if (currentTokens + msgTokens > maxTokens && current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(msg);
    currentTokens += msgTokens;
    // 每 every 条让出一次(协作式; 不改变分批结果)
    if ((i + 1) % every === 0) await yieldToEventLoop();
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ===== 加载主题全文 (跨 groupKey 聚合) =====

/**
 * 找主题对应的所有 session groupKey
 * 策略: 通过 V1 reflection / knowledge / memory 的 theme 字段反查 groupKey
 */
async function findGroupKeysByTheme(theme: string): Promise<string[]> {
  // V1 实际数据: Reflection.relatedSessionIds 多为 null, 用 Memory.theme 间接反查
  // (Memory 没 sessionId 字段, 所以仍走 Reflection 关联, 但允许为空走兜底)
  const reflections = await prisma.reflection.findMany({
    where: { theme, status: { not: "ARCHIVED" } },
    select: { id: true, relatedSessionIds: true, theme: true },
    take: 200,
  });

  const sessionIds = new Set<string>();
  for (const r of reflections) {
    if (!r.relatedSessionIds) continue;
    // V1 db-writer 实际写的是逗号分隔 (db-writer.ts#354: .join(",")),
    // 但部分老数据/手动写入可能是 JSON 数组. 两种都兼容.
    const candidates: string[] = [];
    const trimmed = r.relatedSessionIds.trim();
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) candidates.push(...arr);
      } catch {}
    } else {
      // 兜底: 逗号分隔
      for (const s of trimmed.split(",")) candidates.push(s);
    }
    for (const sid of candidates) {
      if (typeof sid === "string" && sid.trim()) sessionIds.add(sid.trim());
    }
  }
  if (sessionIds.size === 0) return [];

  // 2. 从 SessionRegistry 拿 groupKey
  const sessions = await prisma.sessionRegistry.findMany({
    where: { session_uid: { in: Array.from(sessionIds) } },
    select: { session_uid: true, agent_id: true },
  });
  // session_uid 格式: "agent-{agent_id}:{source_id}", groupKey 通常 = agent_id
  const groupKeys = new Set(sessions.map((s: any) => s.agent_id).filter(Boolean));
  return Array.from(groupKeys).map(k => String(k));
}

/**
 * 跨 session_uid 直接拉主题全文 (V1.5 §2.2.1 主题粒度, 不走 groupKey 中转)
 * 修复: V1 groupKey 聚合 404 频繁 (groupKey 在 session API 不可识别),
 *       改用 session_uid 直接查 Session API /api/v1/sessions/{sessionUid}
 */
export async function loadThemeFullMessages(theme: string, io?: { stats?: any }): Promise<GroupMessage[]> {
  // 1. 从 Reflection.relatedSessionIds 反查 session_uid 列表 (兼容 JSON 数组 + 逗号分隔)
  const reflections = await prisma.reflection.findMany({
    where: { theme, status: { not: "ARCHIVED" } },
    select: { relatedSessionIds: true },
    take: 200,
  });

  const sessionUids = new Set<string>();
  for (const r of reflections) {
    if (!r.relatedSessionIds) continue;
    const trimmed = r.relatedSessionIds.trim();
    let candidates: string[] = [];
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) candidates = arr.filter((s: any) => typeof s === "string");
      } catch {}
    } else {
      candidates = trimmed.split(",").map(s => s.trim()).filter(Boolean);
    }
    for (const s of candidates) sessionUids.add(s);
  }
  console.log(`[reflect] theme="${theme}" sessionUids(from reflections)=${sessionUids.size}`);

  // P6 修复 (2026-07-23): Reflection 没有 relatedSessionIds 时, 从 Memory.sourceId fallback
  // GLOBAL_ORGANIZER 的 sourceId 是 groupKey -> 调 session-groups API 获取 session UID
  // PIPELINE_* 的 sourceId 是 session UID 前缀 -> 尝试直接调用 + 加前缀
  if (sessionUids.size === 0) {
    const memSources = await prisma.memory.findMany({
      // 2026-09-03: 排除 superseded (meta 归档后不参与主题回链)
      where: { theme, sourceId: { not: null }, supersededBy: null },
      select: { sourceId: true, sourceType: true },
      distinct: ["sourceId"],
      take: 50,
    });

    // 收集 groupKey (来自 GLOBAL_ORGANIZER) 和 session UID 前缀 (来自 PIPELINE_*)
    const groupKeys: string[] = [];
    const sessionIdPrefixes: string[] = [];
    for (const m of memSources) {
      if (!m.sourceId) continue;
      if (m.sourceType === "GLOBAL_ORGANIZER") {
        groupKeys.push(m.sourceId);
      } else if (m.sourceType?.startsWith("PIPELINE_")) {
        sessionIdPrefixes.push(m.sourceId);
      }
    }

    // 用 groupKey 调 session-groups API 获取真正的 session UID
    for (const gk of groupKeys.slice(0, 10)) {
      try {
        const sgUrl = `${SESSION_API_BASE}/session-groups/${encodeURIComponent(gk)}`;
        const sgRes = await fetchWithTimeout(sgUrl, {
          headers: { "X-API-Key": SESSION_API_KEY },
          cache: "no-store",
        }, 10000);
        if (sgRes.ok) {
          const sgData = await sgRes.json();
          for (const s of (sgData.sessions || [])) {
            if (s.sessionUid) sessionUids.add(s.sessionUid);
          }
        }
      } catch { /* ignore */ }
    }

    // PIPELINE_* 的 sourceId 可能是完整 session UID 或短前缀
    // 尝试直接用, 也尝试加常见前缀
    for (const prefix of sessionIdPrefixes.slice(0, 10)) {
      sessionUids.add(prefix);
      // 尝试常见前缀组合
      if (!prefix.startsWith("hermes")) {
        sessionUids.add("hermes-agent-h-" + prefix);
        sessionUids.add("hermes_sessions-agent-h-" + prefix);
      }
    }

    console.log(`[reflect] theme="${theme}" sessionUids(Memory fallback: ${groupKeys.length} groupKeys + ${sessionIdPrefixes.length} prefixes)=${sessionUids.size}`);
  }

  if (sessionUids.size === 0) return [];

  // 2026-09-09 P2 降噪a: 会话前置筛选 — 主题词命中标题优先, 未注册未知保留, 明确不相关靠后; 再按最近活跃排序取 50
  let candidates: string[] = Array.from(sessionUids);
  if (io?.stats) io.stats.candidateSessions = candidates.length;
  try {
    const regs: any[] = await prisma.sessionRegistry.findMany({
      where: { session_uid: { in: candidates } },
      select: { session_uid: true, title: true, last_message_at: true },
    });
    const regMap = new Map(regs.map((s: any) => [s.session_uid, s]));
    const themeKey = String(theme || "").toLowerCase();
    const scoreUid = (uid: string): number => {
      const row = regMap.get(uid);
      if (!row) return 1;
      const title = String(row.title || "").toLowerCase();
      if (themeKey && title.includes(themeKey)) return 0;
      return 2;
    };
    candidates.sort((a, b) => {
      const sa = scoreUid(a), sb = scoreUid(b);
      if (sa !== sb) return sa - sb;
      const ta = regMap.get(a)?.last_message_at ? new Date(regMap.get(a).last_message_at as any).getTime() : 0;
      const tb = regMap.get(b)?.last_message_at ? new Date(regMap.get(b).last_message_at as any).getTime() : 0;
      return tb - ta;
    });
  } catch (e: any) {
    console.warn(`[reflect] 会话前置筛选失败 (非致命): ${(e?.message || "").slice(0, 80)}`);
  }
  const uids = candidates.slice(0, 50); // D11 防止 token 爆 + P2 相关度优先
  if (io?.stats) io.stats.sessionUids = uids; // P3.5: 证据范围(该主题实际拉取的会话)
  if (io?.stats) { io.stats.filteredSessions = candidates.length - uids.length; io.stats.fetchedSessions = uids.length; }

  // 2. 并发拉每个 session 的消息 (走 /api/v1/sessions/{sessionUid}, 不走 groupKey)
  const allMessages: GroupMessage[] = [];
  const results = await Promise.allSettled(
    uids.map(async (uid) => {
      const url = `${SESSION_API_BASE}/sessions/${encodeURIComponent(uid)}?view=messages&maxMessages=500`;
      const res = await fetchWithTimeout(url, {
        headers: { "X-API-Key": SESSION_API_KEY },
        cache: "no-store",
      }, 15000);
      if (!res.ok) {
        console.warn(`[reflect] sessionUid=${uid.slice(0, 40)}... API ${res.status}, skip`);
        return null;
      }
      const data = await res.json();
      return { uid, messages: data.messages ?? [] };
    })
  );

  const every = reflectYieldEvery();
  let assembled = 0;
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value) continue;
    for (const m of r.value.messages) {
      const content = m.content || "";
      if (isFrameworkInjection(content)) continue;
      if (!content.trim()) { if (io?.stats) io.stats.droppedMessages = (io.stats.droppedMessages || 0) + 1; continue; }
      allMessages.push({
        id: m.messageUid || m.id || `${r.value.uid}-${m.createdAt}`,
        role: m.role || "unknown",
        content,
        timestamp: new Date(m.createdAt || m.timestamp),
        sessionSeq: 0,
        sessionTitle: r.value.uid,
      });
      // P4(2026-10-17): 跨 50 个 session 的逐条组装是同步段(实测可上万条), 每 every 条让出一次。
      if (++assembled % every === 0) await yieldToEventLoop();
    }
  }
  console.log(`[reflect] theme="${theme}" total messages=${allMessages.length}`);

  // P7 修复 (2026-08-21): Session API 全 404 时, fallback 到 Memory.sourceId
  // 之前只在 relatedSessionIds 为空时才走 Memory fallback, 但 relatedSessionIds 有值
  // 却在 Session API 中找不到 (如 agent-h:hermes_session:cron_* 不存在) 时直接返回空
  if (allMessages.length === 0 && sessionUids.size > 0) {
    console.log(`[reflect] theme="${theme}" all Session API calls failed, trying Memory.sourceId fallback`);
    const memSources = await prisma.memory.findMany({
      // 2026-09-03: 排除 superseded (meta 归档后不参与主题回链)
      where: { theme, sourceId: { not: null }, supersededBy: null },
      select: { sourceId: true, sourceType: true },
      distinct: ["sourceId"],
      take: 50,
    });

    const fallbackUids = new Set<string>();
    for (const m of memSources) {
      if (!m.sourceId) continue;
      // PIPELINE_* 的 sourceId 是短 ID, 加前缀组成完整 sessionUid
      if (m.sourceType?.startsWith("PIPELINE_") && !m.sourceId.startsWith("agent-")) {
        // 尝试 agent-h 和 agent-e 两种前缀
        fallbackUids.add(`agent-h:hermes_session:${m.sourceId}`);
        fallbackUids.add(`agent-e:hermes_session:${m.sourceId}`);
      } else if (m.sourceId.startsWith("agent-")) {
        fallbackUids.add(m.sourceId);
      }
    }

    if (fallbackUids.size > 0) {
      console.log(`[reflect] theme="${theme}" Memory fallback: ${fallbackUids.size} candidate UIDs`);
      const fallbackResults = await Promise.allSettled(
        Array.from(fallbackUids).slice(0, 30).map(async (uid) => {
          const url = `${SESSION_API_BASE}/sessions/${encodeURIComponent(uid)}?view=messages&maxMessages=500`;
          const res = await fetchWithTimeout(url, {
            headers: { "X-API-Key": SESSION_API_KEY },
            cache: "no-store",
          }, 15000);
          if (!res.ok) return null;
          const data = await res.json();
          return { uid, messages: data.messages ?? [] };
        })
      );
      for (const r of fallbackResults) {
        if (r.status !== "fulfilled" || !r.value) continue;
        for (const m of r.value.messages) {
          const content = m.content || "";
          if (isFrameworkInjection(content)) continue;
          if (!content.trim()) continue;
          allMessages.push({
            id: m.messageUid || m.id || `${r.value.uid}-${m.createdAt}`,
            role: m.role || "unknown",
            content,
            timestamp: new Date(m.createdAt || m.timestamp),
            sessionSeq: 0,
            sessionTitle: r.value.uid,
          });
        }
      }
      console.log(`[reflect] theme="${theme}" Memory fallback total messages=${allMessages.length}`);
    }
  }

  return allMessages;
}

// ===== 加载主题所有 4 类产物 =====

export async function loadThemeProducts(theme: string): Promise<ThemeProducts> {
  // 2026-09-14 落地提案 cmtwgdmqu01lu1j768u6qfhag (挑战 Auto-rotation f-001):
  //   原实现 `where: { theme }` 是**精确匹配** —— theme='Auto-rotation' 时, 写在别名
  //   'auto-rot'/'Auto-rot'/'自动轮转' 下的 Knowledge/Practice 全部漏计, productCounts 归零,
  //   反思据此报“Knowledge和Practice产物完全为0条”。改为别名族感知 (themeVariants),
  //   登记别名并入同一次查询; 未登记主题行为不变(仅自身)。写入侧由 normalizeTheme 收敛。
  const themeIn = { in: themeVariants(theme) };
  const [memory, knowledge, practice, reflection] = await Promise.all([
    prisma.memory.findMany({
      // 2026-09-03: 排除 superseded (归档 meta 不喂给主题反思上下文)
      // 2026-09-10 建议4-步骤2: 排除已归档行(tier=COLD, 超容/低活历史行) -> 反思输入降噪
      where: { theme: themeIn, supersededBy: null, NOT: { tier: "COLD" } },
      select: { id: true, content: true, title: true, type: true, importance: true, tier: true, sourceType: true, domain: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.knowledge.findMany({
      // 2026-09-10: 排除 stale(已归档/过时)行
      where: { theme: themeIn, stale: false },
      select: { id: true, content: true, title: true, sourceType: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.practice.findMany({
      // 2026-09-10: 排除 stale(已归档/过时)行
      where: { theme: themeIn, stale: false },
      select: { id: true, title: true, description: true, outcome: true, sourceType: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.reflection.findMany({
      where: { theme: themeIn },
      select: { id: true, title: true, description: true, lesson: true, priority: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  return { memory, knowledge, practice, reflection };
}

// ===== LLM Prompt + 调用 =====

const REFLECT_SYSTEM_PROMPT = `你是一个认知反思引擎。给定一个主题的完整对话全文 (跨多 session) 和该主题已入库的所有 4 类认知产物 (memory/knowledge/practice/reflection), 请评估:

1. missed_topics: 原始对话涉及但产物未覆盖的重要主题 (≥2 字短词, ≤10 个)
2. improvements: 产物的可改进点 (≤3 条, 每条 ≤40 字)
3. coverage_score: 产物覆盖原始对话的程度 (0-1, 浮点数)
4. conflicts: 产物之间存在的内部冲突 (≤3 组, 每组 {memoryIds: ["x", "y"], reason: "≤30 字"}, 没有冲突就空数组)
4.5 summary: 本轮反思的正文总结 (≤300 字, 人类可读, 概括主要结论与下一步)
5. structured_findings: 结构化发现 (≤5 条, 优先级排序), 每条包含:
   - id: "f-001", "f-002" ... (递增编号)
   - category: "MISSED_TOPIC" | "CONFLICT" | "IMPROVEMENT" | "DATA_QUALITY" | "COVERAGE_GAP"
   - what: 发现了什么问题 (≤200字)
   - why: 为什么是问题 (≤200字)
   - background: 主题coverage/产物数/对话数的背景信息
   - requirement: 要做什么才能修复 (≤300字, 具体可执行)
   - acceptance: 如何验证修复成功 (≤200字, 可验证标准)
   - priority: "P0" | "P1" | "P2"
   - impact: 不修复的后果 (≤200字)
   - actionType: "MERGE_CONFLICT" | "RE_EXTRACT" | "CREATE_MEMORY" | "CREATE_PRACTICE" | "CREATE_KNOWLEDGE" | "FIX_DATA" | "MARK_REVIEW"
   - evidenceSnippet: 从对话中摘录的关键证据片段 (≤500字)
   - confidence: 该发现可信度自评 0-1 (浮点数, 依据证据完整度)
   - evidence_strength: "强" | "中" | "弱" (证据强度, 强=有原文直证)
   - relatedTopic: 关联的子主题 (如有)

⚠ 关键原则:
- 原始对话全文是参照物, 产物是结论, 请用全文检验产物是否遗漏、产物之间是否有矛盾。
- structured_findings 必须是具体、可执行、可验证的, 不要泛泛而谈。
- 如果提供了 "上次反思发现", 请判断每个上次发现是否已在本次对话/产物中解决, 已解决的标 category="RECURRING" 且 status="RESOLVED"。
- 如果上次发现的问题仍然存在, category 改为 "RECURRING", status 保持 "RECURRING", recurrenceCount+1。

输出严格 JSON 格式, 不要 markdown 代码块:
{
  "missed_topics": ["主题1", "主题2"],
  "improvements": ["lesson1", "lesson2", "lesson3"],
  "coverage_score": 0.85,
  "conflicts": [{"memoryIds": ["id1", "id2"], "reason": "冲突原因"}],
  "summary": "本轮反思总结: 覆盖不足集中在X, 已识别 N 条可入库改进…",
  "structured_findings": [
    {
      "id": "f-001",
      "category": "COVERAGE_GAP",
      "what": "对话中提到 X 但 Memory 表无对应记录",
      "why": "X 是关键决策, 缺失会导致后续 session 无法引用",
      "background": "coverage=0.65, memory=12, 对话=45条",
      "requirement": "从对话第N段提取 X 的决策内容, 写入 Memory(theme=X, type=DECISION)",
      "acceptance": "Memory 表存在 theme=X 且 content 包含决策内容, coverage_score >= 0.75",
      "priority": "P1",
      "impact": "后续 session 重复讨论 X, 浪费 token",
      "actionType": "CREATE_MEMORY",
      "evidenceSnippet": "用户说: X 的决策是...",
      "relatedTopic": "子主题名"
    }
  ]
}`;

/**
 * V1.8: 从 LLM parsed 中构建 StructuredFinding[], 计算 dedupHash, 检测 RECURRING
 */
function buildStructuredFindings(
  rawFindings: any[],
  theme: string,
  lastFindings?: StructuredFinding[],
): StructuredFinding[] {
  const now = new Date().toISOString();
  const lastHashMap = new Map<string, StructuredFinding>();
  if (lastFindings) {
    for (const lf of lastFindings) {
      lastHashMap.set(lf.dedupHash, lf);
    }
  }

  return rawFindings.slice(0, 5).map((rf, idx) => {
    const category = (rf.category || "IMPROVEMENT") as StructuredFinding["category"];
    const what = String(rf.what || "").slice(0, 200);
    const relatedTopic = rf.relatedTopic || theme;
    const dedupHash = sha256(`${category}|${what}|${relatedTopic}`);

    // RECURRING 检测: 与上次 findings 的 dedupHash 匹配
    const lastMatch = lastHashMap.get(dedupHash);
    let status: StructuredFinding["status"] = "NEW";
    let recurrenceCount = 0;
    let firstSeenAt = now;

    if (lastMatch) {
      if (lastMatch.status === "RESOLVED") {
        status = "NEW";
        recurrenceCount = 0;
        firstSeenAt = now;
      } else {
        status = "RECURRING";
        recurrenceCount = (lastMatch.recurrenceCount || 0) + 1;
        firstSeenAt = lastMatch.firstSeenAt || now;
      }
    }

    return {
      id: rf.id || `f-${String(idx + 1).padStart(3, "0")}`,
      category,
      what,
      why: String(rf.why || "").slice(0, 200),
      background: String(rf.background || "").slice(0, 300),
      requirement: String(rf.requirement || "").slice(0, 300),
      acceptance: String(rf.acceptance || "").slice(0, 200),
      priority: (rf.priority || "P2") as StructuredFinding["priority"],
      impact: String(rf.impact || "").slice(0, 200),
      actionType: (rf.actionType || "MARK_REVIEW") as StructuredFinding["actionType"],
      evidenceSnippet: String(rf.evidenceSnippet || "").slice(0, 500),
      confidence: typeof rf.confidence === "number" ? Math.max(0, Math.min(1, rf.confidence)) : 0.5,
      evidenceStrength: ["强", "中", "弱"].includes(rf.evidence_strength) ? rf.evidence_strength : (["强", "中", "弱"].includes(rf.evidenceStrength) ? rf.evidenceStrength : "中"),
      dedupHash,
      status,
      firstSeenAt,
      recurrenceCount,
      relatedTopic,
      relatedMemoryIds: Array.isArray(rf.relatedMemoryIds) ? rf.relatedMemoryIds : undefined,
      relatedSessionUids: Array.isArray(rf.relatedSessionUids) ? rf.relatedSessionUids : undefined,
    };
  });
}

/**
 * 单批 LLM 反思 (一个 chunk) - V1.8: 支持 lastFindings 注入 + structured_findings 输出
 */
async function reflectChunk(
  chunk: GroupMessage[],
  products: ThemeProducts,
  lastFindings?: StructuredFinding[],
  signal?: AbortSignal,
): Promise<{
  missedTopics: string[];
  improvements: string[];
  coverageScore: number;
  conflicts: Array<{ memoryIds: string[]; reason: string }>;
  summary: string;
  structuredFindings: StructuredFinding[];
}> {
  const messagesText = chunk
    .map(m => `[${m.role}] ${m.content}`)
    .join("\n\n");

  // 4 类产物摘要 (节省 tokens: 只传 title+content 头 50 字)
  const productSummary = `
=== Memory (${products.memory.length}) ===
${products.memory.slice(0, 30).map(p => `- [${p.id.slice(-6)}] ${(p.title || p.content.slice(0, 60))}`).join("\n")}

=== Knowledge (${products.knowledge.length}) ===
${products.knowledge.slice(0, 20).map(p => `- [${p.id.slice(-6)}] ${(p.title || p.content.slice(0, 60))}`).join("\n")}

=== Practice (${products.practice.length}) ===
${products.practice.slice(0, 20).map(p => `- [${p.id.slice(-6)}] ${(p.title || p.description || "").slice(0, 60)}`).join("\n")}

=== Reflection (${products.reflection.length}) ===
${products.reflection.slice(0, 20).map(p => `- [${p.id.slice(-6)}] ${(p.title || p.lesson || "").slice(0, 60)}`).join("\n")}
`.trim();

  // V1.8: 上次反思发现注入 (反馈回路 F1)
  const lastFindingsContext = lastFindings && lastFindings.length > 0
    ? `\n\n=== 上次反思发现 (请判断是否已解决) ===\n${lastFindings.map(f => `- [${f.status}] ${f.category}: ${f.what} (dedupHash=${f.dedupHash.slice(0, 12)}, recurrence=${f.recurrenceCount})`).join("\n")}`
    : "";

  const userPrompt = `=== Memory/Knowledge/Practice/Reflection 产物 (按主题聚合) ===\n${productSummary}\n\n=== 原始对话全文 (节选) ===\n${messagesText}${lastFindingsContext}`;

  const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
  if (!apiKey) throw new Error("LLM API key 未配置 (ANTHROPIC_AUTH_TOKEN)");

  const t0 = Date.now();
  // P0-3 (2026-09-01): 全局并发信号量
  const res = await withLlmConcurrency(() => fetchWithTimeout(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: REFLECT_MODEL,
      max_tokens: REFLECT_MAX_TOKENS,
      system: REFLECT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  }, REFLECT_TIMEOUT_MS, signal));

  if (!res.ok) {
    const text = await res.text();
    recordLlmCall({ entry: "reflect", ok: false, durationMs: Date.now() - t0, errorType: `HTTP_${res.status}`, promptLength: userPrompt.length });
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // 2026-11-05（Q7-min）：记录 stop_reason，供失败归因使用（区分"被截断"与"真不可用"）。
  lastStopReason = String((data as any)?.stop_reason || "");
  // 2026-09-01: 记录真实 usage token (MiniMax 后台按次数计费不展示 token)
  const usage = (data as any)?.usage;
  const tokenUsed = usage && typeof usage.input_tokens === "number" ? usage.input_tokens + (usage.output_tokens || 0) : undefined;
  recordLlmCall({ entry: "reflect", ok: true, durationMs: Date.now() - t0, promptLength: userPrompt.length, tokenUsed });
  const rawText: string = extractLlmText(data);
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("LLM 返回非 JSON: " + rawText.slice(0, 200));

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    // V1.8: 截断 JSON 恢复 - 尝试补全缺失的括号
    let repaired = jsonMatch[0];
    // 计算未闭合的括号数
    const opens = (repaired.match(/[\[{]/g) || []).length;
    const closes = (repaired.match(/[\]}]/g) || []).length;
    const diff = opens - closes;
    if (diff > 0) {
      // 截断到最后一个完整值
      const lastComma = repaired.lastIndexOf(",");
      const lastColon = repaired.lastIndexOf(":");
      const lastQuote = repaired.lastIndexOf('"');
      // 尝试在最后一个完整 key-value 后截断
      const cutAt = Math.max(lastComma, lastColon + 1);
      if (cutAt > 0) repaired = repaired.slice(0, cutAt);
      // 补全括号
      for (let i = 0; i < diff; i++) repaired += "}";
      try {
        parsed = JSON.parse(repaired);
        console.log(`[reflect] chunk JSON 截断恢复成功 (补 ${diff} 个括号)`);
      } catch (e2) {
        throw new Error("JSON.parse 失败 (截断恢复也失败): " + rawText.slice(0, 200));
      }
    } else {
      throw new Error("JSON.parse 失败: " + rawText.slice(0, 200));
    }
  }

  // V1.8: 构建 structuredFindings (含 RECURRING 检测)
  const rawFindings = Array.isArray(parsed.structured_findings) ? parsed.structured_findings : [];
  const themeForFindings = (products.memory[0] as any)?.theme || "";
  const structuredFindings = buildStructuredFindings(rawFindings, themeForFindings, lastFindings);

  return {
    summary: String(parsed.summary || "").trim().slice(0, 300),
    missedTopics: Array.isArray(parsed.missed_topics) ? parsed.missed_topics.slice(0, 10) : [],
    improvements: Array.isArray(parsed.improvements) ? parsed.improvements.slice(0, 3) : [],
    coverageScore: typeof parsed.coverage_score === "number" ? Math.max(0, Math.min(1, parsed.coverage_score)) : 0.5,
    conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.slice(0, 3) : [],
    structuredFindings,
  };
}


// ===== 反思主函数: 多批平均 coverage_score =====

export async function reflect(input: ReflectInput): Promise<FlywheelReflectionResult> {
  const t0 = Date.now();
  const { theme, fullMessages, products, signal } = input;

  // V1.8 F1 反馈回路: 加载上次反思的 structuredFindings + Task.rerunResult (measuredDelta)
  let prevCoverage: number | null = null;
  let prevReflAt: Date | null = null;
  let lastFindings: StructuredFinding[] | undefined;
  try {
    const lastRefl = await prisma.flywheelReflection.findUnique({
      where: { theme },
      select: { structuredFindings: true, coverageScore: true, updatedAt: true },
    });
    if (lastRefl) { prevCoverage = lastRefl.coverageScore ?? null; prevReflAt = lastRefl.updatedAt ?? null; }
    if (lastRefl?.structuredFindings) {
      lastFindings = parseStructuredFindings(lastRefl.structuredFindings) as StructuredFinding[];
      // 加载上次 finding 的 measuredDelta (从 Task.rerunResult)
      const tasks = await prisma.task.findMany({
        where: { theme, rerunResult: { not: null } },
        select: { rerunResult: true },
        orderBy: { updatedAt: "desc" },
        take: 5,
      });
      if (lastFindings && tasks.length > 0) {
        for (const t of tasks) {
          try {
            const rr = JSON.parse(t.rerunResult!);
            if (rr.delta != null && rr.findingId) {
              const f = lastFindings.find(f => f.id === rr.findingId);
              if (f) f.measuredDelta = rr.delta;
            }
          } catch {}
        }
      }
      console.log(`[reflect] theme="${theme}" 加载上次 findings ${(lastFindings || []).length} 条 (RECURRING=${(lastFindings || []).filter(f => f.status === "RECURRING").length})`);
    }
  } catch (e: any) {
    console.warn(`[reflect] theme="${theme}" 加载上次 findings 失败 (非致命): ${e.message?.slice(0, 100)}`);
  }

  if (fullMessages.length === 0) {
    console.warn(`[reflect] theme="${theme}" 没找到原始对话全文, 跳过 (空 theme?)`);
    // 2026-09-10 遗留#5: 安静主题也做规则化冲突检测 — 真实重复不依赖 LLM, 不应因"无新消息"而永远无法合并
    const quietConflictGroups = await detectRealConflictGroups(theme);
    const quietRuleFindings = buildRuleConflictFindings(theme, quietConflictGroups, products.memory.length);
    // 有真实冲突组时按 OK 落行并持久化(本轮确实产出可执行 finding; 旧实现此处 return 不落行 -> 规则冲突永远无法生效);
    // 无冲突组时维持原有"不落行"行为(下游 FAILED 主题补跑逻辑不变)
    const quietOk = quietConflictGroups.length > 0;
    const quietResult: FlywheelReflectionResult = {
      id: "",
      theme,
      missedTopics: [],
      improvements: [],
      coverageScore: 0,
      conflicts: quietConflictGroups,
      productCounts: {
        memory: products.memory.length,
        knowledge: products.knowledge.length,
        practice: products.practice.length,
        reflection: products.reflection.length,
      },
      status: quietOk ? "OK" : "FAILED",
      reportedMemoryIds: [],
      duration: Date.now() - t0,
      attempts: 1,
      error: quietOk ? undefined : "empty theme (no messages)",
      structuredFindings: quietRuleFindings,
      summary: quietOk
        ? `无新对话可反思; 规则化检测到 ${quietConflictGroups.length} 组真实重复 Memory(contentHash 一致), 已生成 MERGE_CONFLICT 待执行`
        : undefined,
      triggerReason: {
        kind: input.trigger || "cron",
        sinceLastHours: prevReflAt ? Math.round((Date.now() - prevReflAt.getTime()) / 3600000) : null,
        newDataSinceLast: false,
      },
      sourceStats: {
        messages: 0,
        chunks: 0,
        ruleConflicts: quietConflictGroups.length,
      },
    };
    if (quietOk) {
      // 2026-09-15 机制修复: 安静路径(无新对话)同样是 MERGE_CONFLICT 规则 finding 的出口,
      //   必须一起重放已裁决结单, 否则该路径产出的冲突 finding 只能等每小时 sweep 兜底。
      try {
        const closures = await loadFindingClosures(theme);
        if (closures.length > 0) applyFindingClosures(quietResult.structuredFindings as any[], closures, theme);
      } catch (e: any) {
        console.warn(`[reflect] theme="${theme}" quiet 路径 finding-closure 重放失败(非致命): ${(e?.message || "").slice(0, 100)}`);
      }
      try { await saveReflectionResult(quietResult); }
      catch (e: any) { console.warn(`[reflect] theme="${theme}" 规则冲突落行失败(非致命): ${(e?.message || "").slice(0, 80)}`); }
    }
    return quietResult;
  }

  const rawChunks = await chunkIfNeeded(fullMessages, CHUNK_MAX_TOKENS);
  // P2-1: chunk 预算截断 -- 单 theme 最多 MAX_CHUNKS_PER_THEME 个 chunk (防数据污染致 55-206 chunks 烧额度)
  const chunks = rawChunks.slice(0, MAX_CHUNKS_PER_THEME);
  if (rawChunks.length > MAX_CHUNKS_PER_THEME) {
    console.warn(`[reflect] theme="${theme}" chunk 预算截断: ${rawChunks.length} -> ${MAX_CHUNKS_PER_THEME} (P2-1 防烧额度)`);
  }
  console.log(`[reflect] theme="${theme}" chunks=${chunks.length}`);

  // 多批平均: missed_topics/improvements/conflicts 取去重并集, coverage_score 取算术平均
  const allMissed: string[] = [];
  const allImprovements: string[] = [];
  const allConflicts: Array<{ memoryIds: string[]; reason: string }> = [];
  const allStructuredFindings: StructuredFinding[] = [];
  const coverageScores: number[] = [];
  const chunkSummaries: string[] = [];
  const seenMissed = new Set<string>();
  const seenImprovements = new Set<string>();
  const seenFindingHashes = new Set<string>();

  let consecutiveChunkFailures = 0;  // P2-1: 连续 chunk 失败计数 (429/网络熔断)

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    // P2-1: route 层 abort 早停 (signal 传递到 chunk 循环)
    if (signal?.aborted) {
      console.warn(`[reflect] theme="${theme}" aborted at chunk ${i + 1}/${chunks.length}`);
      break;
    }
    // P2-1: 连续失败熔断 -- 429/网络连续 3 次说明额度尽或服务不可用, 停剩余 chunks
    if (consecutiveChunkFailures >= MAX_CONSECUTIVE_CHUNK_FAILURES) {
      console.warn(`[reflect] theme="${theme}" 连续 ${consecutiveChunkFailures} 次 chunk 失败, 熔断跳过剩余 ${chunks.length - i} chunks`);
      break;
    }
    // P4(2026-10-17): 每个 chunk 开始前让出事件循环 —— 拼接 prompt(大字符串)/估 token 都是同步段,
    //   让 HTTP 与健康检查先跑一轮再进来(单主题 5-6 chunk => 至少 6 次让出机会)。
    await yieldToEventLoop();
    try {
      console.log(`[reflect] theme="${theme}" chunk ${i + 1}/${chunks.length} tokens≈${estimateTokens(c.map(m => m.content).join("\n"))}`);
      const r = await reflectChunk(c, products, lastFindings, signal); // P1-A: signal 透传到 LLM fetch
      consecutiveChunkFailures = 0;  // P2-1: 成功重置
      recordLlmSuccess();            // 2026-09-01: 健康探针 - 成功即自愈
      for (const t of r.missedTopics) {
        const key: string = String(t || "").trim();
        if (key && !seenMissed.has(key)) {
          seenMissed.add(key);
          allMissed.push(key);
        }
      }
      for (const imp of r.improvements) {
        const key: string = String(imp || "").trim();
        if (key && !seenImprovements.has(key)) {
          seenImprovements.add(key);
          allImprovements.push(key);
        }
      }
      for (const conf of r.conflicts) {
        if (conf.memoryIds?.length && conf.reason) {
          allConflicts.push(conf);
        }
      }
      coverageScores.push(r.coverageScore);
      if (r.summary) chunkSummaries.push(r.summary);
      // V1.8: 收集 structuredFindings (dedupHash 去重跨 chunk)
      for (const sf of r.structuredFindings) {
        if (!seenFindingHashes.has(sf.dedupHash)) {
          seenFindingHashes.add(sf.dedupHash);
          allStructuredFindings.push(sf);
        }
      }
    } catch (e: any) {
      consecutiveChunkFailures++;  // P2-1: 连续失败计数 (触发熔断)
      recordLlmFailure(e?.message || "chunk failed"); // 2026-09-01: 健康探针 - 连续失败暂停反思
      console.error(`[reflect] theme="${theme}" chunk ${i + 1} failed (连续失败 ${consecutiveChunkFailures}/${MAX_CONSECUTIVE_CHUNK_FAILURES}): ${e.message}`);
      // 失败批不贡献 coverage_score, 但其他批继续
    }
  }

  const coverageScore = coverageScores.length > 0
    ? coverageScores.reduce((a, b) => a + b, 0) / coverageScores.length
    : 0;

  // ★ P1 fix: 所有 chunk LLM 调用都失败时, status 应为 FAILED (不是 OK)
  const allChunksFailed = coverageScores.length === 0 && chunks.length > 0;
  // 2026-09-10: 诚实归因 —— 若本次是被 abort(route 超时/客户端断开)打断, 不能报 "LLM API 不可用"
  const aborted = !!signal?.aborted;
  const failReason = aborted
    ? `aborted: cron/route timeout or client disconnect (completed ${coverageScores.length}/${chunks.length} chunks)`
    : "all chunks failed (LLM API unavailable?)" +
      // 2026-11-05（Q7-min）：把 LLM 返回的 stop_reason 带进错误文本，
      // 否则 max_tokens 截断与真实不可用无法区分（今天 M3.1 那次就吃了这个亏）。
      (lastStopReason ? ` [stop_reason=${lastStopReason}]` : "");

  // 2026-09-09 P2.5: finding 选取(近重复合并 + 证据校准 + 多样性贪心 Top10), 逻辑见 reflect-select.ts
  // P4(2026-10-17): 让出后再进同步选取段(见 yieldToEventLoop 注释)。
  await yieldToEventLoop();
  const sel = selectTopFindings(allStructuredFindings, theme);
  const sortedFindings = sel.picked;
  const selectionMeta = sel.meta;

  // 2026-09-10 遗留#5: 规则化真实冲突对检测 (见 detectRealConflictGroups / buildRuleConflictFindings)
  const realConflictGroups = await detectRealConflictGroups(theme);
  // 2026-09-10 #1: 语义近重复 (SimHash 候选 + LLM 确认) — 只认完全一致之外的第二层, 仍只 supersede 不删除
  const semanticAudit = { candidates: 0, confirmed: 0, llmConfirmed: 0, scanned: 0 };
  if (process.env.REFLECT_SEMANTIC_DEDUPE !== "0") {
    try {
      // P4(2026-10-17): SimHash 候选计算是同步 CPU 段(对候选记忆逐条哈希), 先让出一次。
      await yieldToEventLoop();
      const sem = await detectSemanticDuplicateCandidates(theme, realConflictGroups.flatMap((g) => g.memoryIds));
      semanticAudit.candidates = sem.pairs.length;
      semanticAudit.scanned = sem.scanned;
      if (sem.pairs.length > 0) {
        const conf = await confirmSemanticPairs(theme, sem.pairs);
        for (const c of conf.confirmed) {
          semanticAudit.confirmed++;
          if (c.llm) semanticAudit.llmConfirmed++;
          realConflictGroups.push({
            memoryIds: [c.a, c.b],
            reason: `语义近重复确认: 汉明距离=${c.hamming} ${c.llm ? "(LLM 判定同一事实重复表述)" : "(近乎同文, 免 LLM)"}`,
            kind: "semantic",
          });
        }
        console.log(`[reflect] theme="${theme}" 语义候选 ${sem.pairs.length} 对 -> 确认 ${conf.confirmed.length} 对 (LLM=${conf.llmUsed})`);
      }
    } catch (e: any) {
      console.warn(`[reflect] theme="${theme}" 语义近重复检测失败(非致命): ${(e?.message || "").slice(0, 80)}`);
    }
  }
  const ruleConflictFindings = buildRuleConflictFindings(theme, realConflictGroups, products.memory.length);
  if (realConflictGroups.length > 0) {
    allConflicts.unshift(...realConflictGroups); // 真实冲突优先 (LLM 冲突组幻觉 ID 由生成/执行端防伪过滤)
    for (const f of ruleConflictFindings) {
      if (!sortedFindings.some((sf) => (sf.relatedMemoryIds || []).some((id) => (f.relatedMemoryIds || []).includes(id)))) {
        sortedFindings.unshift(f);
      }
    }
    console.log(`[reflect] theme="${theme}" 规则化真实冲突组 ${realConflictGroups.length} 个 -> conflicts + findings 已注入`);
  }

  // 2026-09-15 机制修复(f-001 Pipeline stale-memory, 任务 cmu25rlba089oki4aj78i5v3n):
  //   structuredFindings 每次反思整体重算, 会把写进去的「已裁决结单」标记冲掉 -> 同一冲突反复派单。
  //   这里在落库前重放 FindingClosure 登记表, 使结单与重算解耦(命中冲突类 finding 且证据合格才 RESOLVED)。
  try {
    const closures = await loadFindingClosures(theme);
    if (closures.length > 0) {
      const closedN = applyFindingClosures(sortedFindings, closures, theme);
      if (closedN > 0) {
        console.log(`[reflect] theme="${theme}" finding-closure 重放: ${closedN} 条置 RESOLVED(决策结单跨重算持久)`);
      }
    }
  } catch (e: any) {
    console.warn(`[reflect] theme="${theme}" finding-closure 重放失败(非致命): ${(e?.message || "").slice(0, 100)}`);
  }


  const latestMsgTime = fullMessages.reduce((max: Date, m: GroupMessage) => (m.timestamp > max ? m.timestamp : max), new Date(0));
  const newDataSinceLast = prevReflAt ? latestMsgTime.getTime() > prevReflAt.getTime() : true;

  // 2026-09-09 P3.5: 证据范围 / 间隔变化量 / 主题健康快照 / 7d热度 (轻查询, 失败不致命)
  const sessionUidsUsed: string[] = input.ioStats?.sessionUids || [];
  for (const f of sortedFindings) f.relatedSessionUids = sessionUidsUsed.slice(0, 50);
  let changesNewProducts: number | null = null;
  let heat7dMemory = 0;
  try {
    if (prevReflAt) changesNewProducts = await prisma.memory.count({ where: { theme, createdAt: { gt: prevReflAt } } });
    heat7dMemory = await prisma.memory.count({ where: { theme, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } } });
  } catch { /* 非致命 */ }
  const sampleMems: any[] = (products.memory || []).slice(0, 100);
  const healthBuckets = { high: 0, mid: 0, low: 0, unscored: 0 };
  let supInSample = 0;
  for (const m of sampleMems) {
    if (m.supersededBy) supInSample++;
    const q = m.qualityScore;
    if (q == null) healthBuckets.unscored++;
    else if (q >= 0.7) healthBuckets.high++;
    else if (q >= 0.4) healthBuckets.mid++;
    else healthBuckets.low++;
  }

  const result: FlywheelReflectionResult = {
    id: "",
    theme,
    missedTopics: allMissed.slice(0, 10),
    improvements: allImprovements.slice(0, 3),
    coverageScore,
    conflicts: allConflicts.slice(0, 3),
    productCounts: {
      memory: products.memory.length,
      knowledge: products.knowledge.length,
      practice: products.practice.length,
      reflection: products.reflection.length,
    },
    status: allChunksFailed ? (aborted ? "SKIPPED" : "FAILED") : "OK",
    error: allChunksFailed ? failReason : undefined,
    reportedMemoryIds: [],
    duration: Date.now() - t0,
    attempts: 1,
    structuredFindings: sortedFindings,
    summary: chunkSummaries.find((s) => s && s.trim())?.slice(0, 300) || "",
    sourceStats: {
      candidateSessions: input.ioStats?.candidateSessions ?? 0,
      fetchedSessions: input.ioStats?.fetchedSessions ?? 0,
      filteredSessions: input.ioStats?.filteredSessions ?? 0,
      droppedMessages: input.ioStats?.droppedMessages ?? 0,
      messages: fullMessages.length,
      chunks: chunks.length,
      truncatedChunks: Math.max(0, rawChunks.length - chunks.length),
      // P3.5: 选取审计 / 未拉取估计 / 证据范围 / 健康快照 / 热度 / 变化量
      selection: selectionMeta,
      ruleConflicts: realConflictGroups.length, // 2026-09-10 遗留#5: 规则化检测到的真实重复组数(含语义确认)
      semanticDedupe: semanticAudit,            // 2026-09-10 #1: {scanned,candidates,confirmed,llmConfirmed}
      unFetchedEstimate: Math.max(0, (input.ioStats?.candidateSessions ?? 0) - (input.ioStats?.fetchedSessions ?? 0)),
      sessionUidsUsed: sessionUidsUsed.length,
      themeProductsHealth: { sampleN: sampleMems.length, qualityBuckets: healthBuckets, supersededInSample: supInSample },
      heat7dMemory,
      changesSinceLast: { newMessagesSinceLast: newDataSinceLast, newProductsSinceLast: changesNewProducts },
    },
    triggerReason: {
      kind: input.trigger || "cron",
      sinceLastHours: prevReflAt ? Math.round((Date.now() - prevReflAt.getTime()) / 3600000) : null,
      newDataSinceLast,
    },
    coverageDelta: prevCoverage != null ? Number((coverageScore - prevCoverage).toFixed(4)) : undefined,
  };
  console.log(`[reflect] theme="${theme}" done in ${(result.duration / 1000).toFixed(1)}s, coverage=${coverageScore.toFixed(2)}, missed=${allMissed.length}, improvements=${allImprovements.length}, findings=${allStructuredFindings.length}`);
  return result;
}

// ===== 写 FlywheelReflection + Memory (D13, type=REFLECTION) =====

export async function saveReflectionResult(result: FlywheelReflectionResult): Promise<void> {
  const reportedMemoryIds: string[] = [];

  // 1. 写 FlywheelReflection 表 (theme @unique, update 不 insert)
  //    reportedMemoryIds 占位: 因为 lessons 还没写入, 后面 update 再补全
  //    ★ P0 fix: 捕获 upsert 返回值, 回写 result.id (V1.6 钩子依赖 result.id 非空)
  const saved = await prisma.flywheelReflection.upsert({
    where: { theme: result.theme },
    create: {
      theme: result.theme,
      missedTopics: JSON.stringify(result.missedTopics),
      improvements: JSON.stringify(result.improvements),
      coverageScore: result.coverageScore,
      conflicts: JSON.stringify(result.conflicts),
      productCounts: JSON.stringify(result.productCounts),
      status: result.status,
      attempts: result.attempts,
      lastErrors: result.error || null,
      structuredFindings: result.structuredFindings ? JSON.stringify(result.structuredFindings) : null,
      reflectionGranularity: "theme",
      triggerReason: result.triggerReason ? JSON.stringify(result.triggerReason) : null,
      sourceStats: result.sourceStats ? JSON.stringify(result.sourceStats) : null,
      summary: result.summary || null,
      coverageDelta: result.coverageDelta ?? null,
    },
    update: {
      missedTopics: JSON.stringify(result.missedTopics),
      improvements: JSON.stringify(result.improvements),
      coverageScore: result.coverageScore,
      conflicts: JSON.stringify(result.conflicts),
      productCounts: JSON.stringify(result.productCounts),
      status: result.status,
      attempts: result.attempts,
      lastErrors: result.error || null,
      structuredFindings: result.structuredFindings ? JSON.stringify(result.structuredFindings) : null,
      triggerReason: result.triggerReason ? JSON.stringify(result.triggerReason) : null,
      sourceStats: result.sourceStats ? JSON.stringify(result.sourceStats) : null,
      summary: result.summary || null,
      coverageDelta: result.coverageDelta ?? null,
      updatedAt: new Date(),
    },
  });
  result.id = saved.id;  // ★ 回写 cuid, V1.6 钩子才能触发
  console.log(`[reflect] theme="${result.theme}" FlywheelReflection ${result.status === "OK" ? "saved" : "FAILED"}`);

  // 2. 反思报告与 lesson 不再写入 Memory 表 (2026-09-03)
  //    原因: [反思报告]/[反思产物] 是"元日志"(报告自己该补什么), 不是记忆实体,
  //    混入 Memory 造成碎片化 (全量 4342+ 条, 拉低记忆质量均分)。
  //    这些信息完整保留在 FlywheelReflection 表 (coverage/improvements/conflicts/reportedMemoryIds),
  //    improvements 由 generate-improving-tasks 消费生成自动化任务 (闭环第 6 步)。
  if (result.status === "OK") {
    // 占位保持 reportedMemoryIds 为空 (FlywheelReflection.reportedMemoryIds 不再回写 meta 行)
    // 如需 theme 级溯源, FlywheelReflection 本身就是溯源载体
    if (false) {
      const memoryStore = new PrismaMemoryStore(prisma);
      console.log(`[reflect] theme="${result.theme}" meta-memory 写入已停用 (存 FlywheelReflection)`);
    }
    console.log(`[reflect] theme="${result.theme}" 反思完成 (meta 仅存 FlywheelReflection, 不再写 Memory)`);

    // 3. 回写 FlywheelReflection.reportedMemoryIds (供 V1.6 FIX_CONFLICT 溯源)
    //    用 theme @unique 找记录 (result.id 在 reflect() 里写死 "", 不能用)
    if (reportedMemoryIds.length > 0) {
      try {
        await prisma.flywheelReflection.update({
          where: { theme: result.theme },
          data: { reportedMemoryIds: JSON.stringify(reportedMemoryIds) },
        });
      } catch (e: any) {
        // 找不到 id 可能因为 race, 不阻塞
        console.warn(`[reflect] reportedMemoryIds 回写失败: ${e.message.slice(0, 100)}`);
      }
    }
  }

  result.reportedMemoryIds = reportedMemoryIds;
}

// ===== Reflect Worker (含 writeReflectionToMemory, V1.5 主入口) =====

// ==================== 2026-09-10 #1: 语义近重复 (SimHash 候选 + LLM 确认) ====================
// 背景: 规则层只认 contentHash 完全一致; 改写/同义重复需近似判定。
// 实测(scripts/memory-near-dup-scan.cjs): 38,408 活性行仅 274 组候选(汉明<=6), 规模小 ->
//   不做 embedding 基建, 用 4-gram SimHash 出候选 + 每主题 1 次 LLM 确认(候选<=5), 成本可忽略。
const SEM_MAX_HAM = Number(process.env.REFLECT_SEMANTIC_MAX_HAM ?? "6");
const SEM_MAX_PAIRS = Number(process.env.REFLECT_SEMANTIC_MAX_PAIRS ?? "5");

function simNorm(s: string): string {
  return String(s || "").toLowerCase().replace(/[\s\p{P}]+/gu, "").slice(0, 400);
}
function simhash64(text: string): bigint {
  const v = new Array(64).fill(0);
  for (let i = 0; i + 4 <= text.length; i++) {
    let h = 2166136261;
    for (let k = 0; k < 4; k++) { h ^= text.charCodeAt(i + k); h = Math.imul(h, 16777619); }
    for (let b = 0; b < 64; b++) v[b] += (h >>> b) & 1 ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) out |= 1n << BigInt(b);
  return out;
}
function hamming64(a: bigint, b: bigint): number { let x = a ^ b, c = 0; while (x) { x &= x - 1n; c++; } return c; }

export interface SemanticPair { a: string; b: string; hamming: number; aText: string; bText: string; }

/** 同主题内 SimHash 近重复候选 (只读, 不调 LLM) */
export async function detectSemanticDuplicateCandidates(
  theme: string,
  excludeIds: string[] = []
): Promise<{ pairs: SemanticPair[]; scanned: number }> {
  const rows = await prisma.memory.findMany({
    where: { theme, supersededBy: null },
    select: { id: true, content: true, title: true },
    take: 200,
  });
  const excl = new Set(excludeIds);
  const items = rows
    .filter((r) => r.content && r.content.length >= 30 && !excl.has(r.id))
    .map((r) => ({ id: r.id, text: simNorm(r.content), sim: simhash64(simNorm(r.content)), title: r.title || "" }));
  const pairs: SemanticPair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const shorter = Math.min(a.text.length, b.text.length), longer = Math.max(a.text.length, b.text.length);
      if (longer === 0 || shorter / longer < 0.6) continue;
      const d = hamming64(a.sim, b.sim);
      if (d <= SEM_MAX_HAM) pairs.push({ a: a.id, b: b.id, hamming: d, aText: (a.title + " " + a.text).slice(0, 220), bText: (b.title + " " + b.text).slice(0, 220) });
    }
  }
  pairs.sort((x, y) => x.hamming - y.hamming);
  return { pairs: pairs.slice(0, SEM_MAX_PAIRS), scanned: items.length };
}

/** 候选对 LLM 确认 (1 次调用; 汉明<=3 视为近乎同文免 LLM; 调用失败退化为只信 <=4) */
export async function confirmSemanticPairs(
  theme: string,
  pairs: SemanticPair[]
): Promise<{ confirmed: Array<{ a: string; b: string; hamming: number; llm: boolean }>; llmUsed: boolean }> {
  const auto = pairs.filter((p) => p.hamming <= 3);
  const ask = pairs.filter((p) => p.hamming > 3);
  const confirmed = auto.map((p) => ({ a: p.a, b: p.b, hamming: p.hamming, llm: false }));
  if (ask.length === 0) return { confirmed, llmUsed: false };

  const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
  if (!apiKey) {
    // 无 key: 保守退化 (仅 >=0.5 长度比 + 汉明<=4)
    for (const p of ask) if (p.hamming <= 4) confirmed.push({ a: p.a, b: p.b, hamming: p.hamming, llm: false });
    return { confirmed, llmUsed: false };
  }
  const listText = ask.map((p, i) => `[${i + 1}] A: ${p.aText}\n    B: ${p.bText}`).join("\n");
  const prompt = `主题: "${theme}"\n下面是若干 Memory 条目对。请判断每对是否为"同一事实/知识点的重复表述"(改写、同义、详略差异都算重复), 而非仅是主题相关。\n\n${listText}\n\n只输出严格 JSON: {"dups":[{"i":1,"same":true,"why":"≤40字"}]}`;
  try {
    const res = await withLlmConcurrency(() => fetchWithTimeout(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: REFLECT_MODEL, max_tokens: 800, system: "你是严谨的记忆去重判定器, 只输出 JSON。", messages: [{ role: "user", content: prompt }] }),
    }, 60000));
    recordLlmSuccess();
    const data: any = await res.json();
    const raw = String(extractLlmText(data));
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { dups: [] };
    for (const d of parsed.dups || []) {
      const idx = Number(d.i) - 1;
      const p = ask[idx];
      if (p && d.same === true) confirmed.push({ a: p.a, b: p.b, hamming: p.hamming, llm: true });
    }
    return { confirmed, llmUsed: true };
  } catch (e: any) {
    recordLlmFailure(e?.message || "semantic confirm failed");
    console.warn(`[reflect] theme="${theme}" 语义重复 LLM 确认失败(退化只信汉明<=4): ${(e?.message || "").slice(0, 80)}`);
    for (const p of ask) if (p.hamming <= 4) confirmed.push({ a: p.a, b: p.b, hamming: p.hamming, llm: false });
    return { confirmed, llmUsed: true };
  }
}

// ==================== 2026-09-10 遗留#5: 规则化真实冲突检测 ====================

/** 真实重复组检测: 同 theme 内 contentHash 相同且均活性 -> 确定性冗余 (非 LLM 叙事) */
export async function detectRealConflictGroups(theme: string): Promise<Array<{ memoryIds: string[]; reason: string; kind?: string }>> {
  const out: Array<{ memoryIds: string[]; reason: string; kind?: string }> = [];
  try {
    const dupGroups: any[] = await prisma.$queryRawUnsafe(
      "SELECT contentHash, COUNT(*) c FROM Memory WHERE theme=? AND supersededBy IS NULL AND contentHash IS NOT NULL AND contentHash != '' GROUP BY contentHash HAVING c>=2 ORDER BY c DESC LIMIT 5",
      theme
    );
    for (const g of dupGroups || []) {
      const rows = await prisma.memory.findMany({
        where: { theme, contentHash: g.contentHash, supersededBy: null },
        select: { id: true },
        orderBy: { reinforceCount: "desc" },
        take: 6,
      });
      const ids = rows.map((r) => r.id);
      if (ids.length < 2) continue;
      out.push({ memoryIds: ids, reason: `规则检测: theme="${theme}" 存在 ${ids.length} 条同内容(contentHash 一致)活性 Memory, 应合并为 1 条`, kind: "exact" });
    }
  } catch (e: any) {
    console.warn(`[reflect] theme="${theme}" 规则化冲突检测失败(非致命): ${(e?.message || "").slice(0, 80)}`);
  }
  return out;
}

/** 把真实重复组转成高置信 MERGE_CONFLICT finding (执行端 resolveRealConflictIds 只认真实 ID => 能真正合并) */
export function buildRuleConflictFindings(
  theme: string,
  groups: Array<{ memoryIds: string[]; reason: string; kind?: string }>,
  memCount: number
): StructuredFinding[] {
  const nowIso = new Date().toISOString();
  return groups.map((g, i) => ({
    id: `rc-${String(i + 1).padStart(3, "0")}`,
    category: "CONFLICT" as const,
    what: g.kind === "semantic"
      ? `语义近重复: ${g.memoryIds.length} 条 Memory 表述不同但指同一事实 (theme="${theme}")`
      : `规则检测到 ${g.memoryIds.length} 条同内容 Memory 重复 (theme="${theme}")`,
    why: g.kind === "semantic"
      ? "SimHash 近重复候选(" + g.reason + ") 经确认属同事实重复表述 => 合并可提升检索精度"
      : "同一主题下多条 Memory 内容完全一致(contentHash 相同) => 确定性冗余, 非 LLM 推测",
    background: `theme 产物: Memory ${memCount} 条; 重复组大小 ${g.memoryIds.length}`,
    requirement: "执行 MERGE_CONFLICT: 保留 reinforceCount/质量最高的一条, 其余标 supersededBy(不删除)",
    acceptance: "该 contentHash 活性组仅剩 1 条, 其余 supersededBy 指向保留行, 且 TaskStateTransition 有审计",
    priority: (g.memoryIds.length >= 3 ? "P0" : "P1") as "P0" | "P1",
    impact: `消除 ${g.memoryIds.length - 1} 条重复记忆, 提升主题检索精度与质量均分`,
    actionType: "MERGE_CONFLICT" as const,
    evidenceSnippet: `重复组 ${g.memoryIds.length} 条, id 后缀=${g.memoryIds.map((x) => x.slice(-6)).join(",")}`,
    confidence: 1,
    evidenceStrength: "强" as const,
    dedupHash: createHash("sha256").update("rule-conflict|" + theme + "|" + g.memoryIds.join(",")).digest("hex").slice(0, 16),
    status: "NEW" as const,
    firstSeenAt: nowIso,
    recurrenceCount: 0,
    relatedMemoryIds: g.memoryIds,
  })) as StructuredFinding[];
}

export async function reflectWorker(theme: string, opts: { signal?: AbortSignal; trigger?: string } = {}): Promise<FlywheelReflectionResult> {
  const t1 = Date.now();
  const signal = opts.signal;
  const ioStats: any = {}; // 2026-09-09 P2 输入审计
  console.log(`\n[reflect-worker] ========== START theme="${theme}" ==========`);

  // P0-3: route 层 abort 触发后, 立即退出 (不浪费 LLM 调用)
  if (signal?.aborted) {
    console.warn(`[reflect-worker] theme="${theme}" aborted at start`);
    return {
      id: "", theme, missedTopics: [], improvements: [], coverageScore: 0,
      conflicts: [], productCounts: { memory: 0, knowledge: 0, practice: 0, reflection: 0 },
      status: "SKIPPED", reportedMemoryIds: [], duration: Date.now() - t1, attempts: 0,
      error: "aborted by route signal",
    };
  }

  // 1. 加载主题全文 (跨 groupKey 聚合)
  const fullMessages = await loadThemeFullMessages(theme, { stats: ioStats });
  console.log(`[reflect-worker] theme="${theme}" fullMessages=${fullMessages.length}`);

  // 2. 加载该主题所有产物
  const products = await loadThemeProducts(theme);
  console.log(`[reflect-worker] theme="${theme}" products: M=${products.memory.length} K=${products.knowledge.length} P=${products.practice.length} R=${products.reflection.length}`);

  // ★ 2026-09-18 修改(用户口径: 飞轮入口不能因回链断层而饿死):
  //   原实现"无会话材料一律 SKIP"。实测根因是**材料回链断层** —— 会话提炼产物是 SESSION_EXTRACT,
  //   其 sourceId 形如 `taskexec:<TaskExecution.id>`, 而 Task/TaskExecution 未存会话 UID(input 为空),
  //   旧的两条回链(Reflection.relatedSessionIds / Memory.sourceId 的 PIPELINE_* 形态)都拿不到会话
  //   -> fullMessages=0 -> 每轮秒 SKIP(实测 70ms) -> 1693 个活跃主题从未被反思, ImprovementAction 近 7d=0。
  //   现改为两级:
  //     ① 主题**完全没有产物** -> 仍然 SKIP(真没料);
  //     ② 有产物但无会话材料 -> 继续执行(仅产物反思), 由下游用产物(Memory/Knowledge/Practice)作材料,
  //        并在日志里明确标注 productOnly, 不伪装成"基于会话的反思"。
  const totalProducts = products.memory.length + products.knowledge.length + products.practice.length;
  if (fullMessages.length === 0 && totalProducts === 0) {
    return {
      id: "", theme, missedTopics: [], improvements: [], coverageScore: 0,
      conflicts: [], productCounts: {
        memory: products.memory.length, knowledge: products.knowledge.length,
        practice: products.practice.length, reflection: products.reflection.length,
      },
      status: "SKIPPED", reportedMemoryIds: [], duration: Date.now() - t1, attempts: 1,
      error: "no conversation messages and no products for this theme",
    };
  }
  const productOnly = fullMessages.length === 0;
  let messagesForReflect: GroupMessage[] = fullMessages;
  if (productOnly) {
    // 把**产物本身**合成反思材料(GroupMessage), 让下游 reflect() 有真实文本可分析。
    // 标注: sessionTitle 写明来源是平台产物、且无会话回链 —— 不伪装成"基于会话的反思"。
    const synth: GroupMessage[] = [];
    const pushProducts = (arr: any[], kind: string) => {
      for (const p of (arr || []).slice(0, 120)) {
        const text = [p.title, p.summary, p.content].filter(Boolean).join(" — ").slice(0, 800);
        if (!text) continue;
        synth.push({
          id: kind + ":" + String(p.id || synth.length),
          role: "product",
          content: "[" + kind + "] " + text,
          timestamp: new Date(Number(p.createdAt) || Date.now()),
          sessionSeq: synth.length,
          sessionTitle: "平台产物(" + kind + ")/无会话回链",
        });
      }
    };
    pushProducts(products.memory, "Memory");
    pushProducts(products.knowledge, "Knowledge");
    pushProducts(products.practice, "Practice");
    messagesForReflect = synth;
    console.log("[reflect-worker] theme=\"" + theme + "\" 无会话材料(回链断层) -> **仅产物反思**: 合成材料 " +
      synth.length + " 条 (M=" + products.memory.length + " K=" + products.knowledge.length + " P=" + products.practice.length + ")");
  }

  // 3. 调用反思 (含 chunkIfNeeded)
  let result: FlywheelReflectionResult;
  try {
    result = await reflect({ theme, fullMessages: messagesForReflect, products, signal, trigger: opts.trigger || "cron", ioStats });
  } catch (e: any) {
    result = {
      id: "",
      theme,
      missedTopics: [],
      improvements: [],
      coverageScore: 0,
      conflicts: [],
      productCounts: {
        memory: products.memory.length,
        knowledge: products.knowledge.length,
        practice: products.practice.length,
        reflection: products.reflection.length,
      },
      status: "FAILED",
      reportedMemoryIds: [],
      duration: Date.now() - t1,
      attempts: 1,
      error: e.message,
    };
  }

  // 4. 写 FlywheelReflection + Memory
  try {
    await saveReflectionResult(result);
  } catch (e: any) {
    console.error(`[reflect-worker] theme="${theme}" save failed: ${e.message}`);
    // 即使保存失败, 仍返回 result (含 error 字段)
    result.error = (result.error || "") + " | save: " + e.message;
    result.status = "FAILED";
  }

  // 5. ===== V1.6 §3.1 ⑥ 反思完成 → 自动生成 ImprovingTask =====
  //    只在反思真成功 (OK 状态) 时触发. 失败/异常的反思不生成 (避免误改进)
  //    注意: FlywheelReflectionResult.id 是 FlywheelReflection 表的 cuid (theme @unique upsert 写入)
  if (result.status === "OK" && result.id) {
    try {
      // 异步动态 import, 避免 reflect.ts → generate-improving-tasks.ts 循环依赖
      // (generate-improving-tasks.ts 也 import ./reflect 取 FlywheelReflectionResult 类型)
      const { generateImprovingTasks } = await import("./generate-improving-tasks");
      const generated = await generateImprovingTasks({
        id: result.id,
        theme: result.theme,
        missedTopics: result.missedTopics,
        improvements: result.improvements,
        conflicts: result.conflicts,
        coverageScore: result.coverageScore,
      });
      console.log(`[reflect-worker:V1.6] theme="${theme}" generated ${generated.length} ImprovingTask(s) after reflection`);
    } catch (genErr: any) {
      // V1.6 §6.7 失败兜底: generate 失败不影响反思结果, 只记录日志
      console.error(`[reflect-worker:V1.6] theme="${theme}" generate-improving-tasks failed (non-fatal): ${genErr.message}`);
    }
  }

  console.log(`[reflect-worker] ========== END theme="${theme}" status=${result.status} duration=${((Date.now() - t1) / 1000).toFixed(1)}s ==========\n`);
  return result;
}
