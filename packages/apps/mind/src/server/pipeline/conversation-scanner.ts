import { sessionApiKey } from "@/lib/secret";
import fs from "fs";
import path from "path";
import { prisma } from "@/lib/prisma";
import { PrismaClient } from "../../../node_modules/.prisma/mind-client";
import type {
  ParsedConversation,
  ConversationMessage,
  ScanResult,
} from "./types";

const CLAUDE_DIR = path.join(
  "~/.claude",
  "projects"
);

const MAX_MESSAGE_LENGTH = 2000;
const MAX_MESSAGES = 500;

function parseProjectName(dirName: string): string {
  return dirName
    .replace(/^-data-home-/, "")
    .replace(/^-/, "")
    .split(/[-]/)
    .map((w, i) => (i > 0 && w.length > 2 ? w : w))
    .join(" ")
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

export function scanAllConversations(): ScanResult {
  // 同步保留: 仅扫 ~/.claude/projects/ (Claude 客户端)
  // session 服务数据源走 scanSessionService() (异步)
  const result: ScanResult = {
    totalConversations: 0,
    newConversations: [],
    alreadyProcessed: 0,
    projectSummary: [],
  };

  if (!fs.existsSync(CLAUDE_DIR)) {
    return result;
  }

  const projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true });

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    if (dir.name.startsWith(".")) continue;

    const projectPath = path.join(CLAUDE_DIR, dir.name);
    const files = fs.readdirSync(projectPath);

    let conversationCount = 0;
    let newCount = 0;

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = path.join(projectPath, file);
      const sessionId = file.replace(".jsonl", "");
      const conversation = parseConversationFile(
        filePath,
        sessionId,
        projectPath,
        dir.name
      );

      if (!conversation) continue;
      conversationCount++;
      result.totalConversations++;

      if (conversation.messages.length < 2) continue;

      result.newConversations.push(conversation);
      newCount++;
    }

    result.projectSummary.push({
      projectPath,
      projectName: parseProjectName(dir.name),
      conversationCount,
      newCount,
    });
  }

  return result;
}

// ============================================================================
// Session 服务数据源 (新增 2026-08-18)
// 通过 REST API 从 session 服务 :3002 拉取全 agent 的 sessions
// ============================================================================

const SESSION_SERVICE_URL =
  process.env.SESSION_SERVICE_URL || "http://localhost:3002";
const SESSION_SERVICE_API_KEY =
  sessionApiKey(/* SESSION_SERVICE_API_KEY */);

interface SessionServiceSession {
  sessionUid: string;
  agentId: string;
  source: string;
  title?: string;
  startedAt?: string;
  lastMessageAt?: string;
  messageCount: number;
  status?: string; // 2026-09-01: RETRYABLE 扫描返回的 FAILED 会话标记优先处理
}

interface SessionServiceSingleResponse {
  session: SessionServiceSession;
  messages: Array<{
    role: string;
    content: string;
    timestamp?: string;
    toolName?: string;
  }>;
}

/**
 * 从 session 服务拉取单个 session（含 messages）
 */
async function fetchSessionFromService(
  sessionUid: string
): Promise<SessionServiceSingleResponse | null> {
  try {
    const url = `${SESSION_SERVICE_URL}/api/v1/sessions/${encodeURIComponent(sessionUid)}`;
    const res = await fetch(url, {
      headers: { "X-API-Key": SESSION_SERVICE_API_KEY },
    });
    if (!res.ok) return null;
    return (await res.json()) as SessionServiceSingleResponse;
  } catch {
    return null;
  }
}

/**
 * 从 session 服务分页拉取全部 sessions，转成 ParsedConversation
 *
 * 优化: 不在 scan 时拉 messages (大 session 几十万 message, 拉慢)
 *       而是只取 session 元信息，messageCount 作为近似长度
 *       真正的 messages 拉取由 enrichWithMessages 按需进行
 *
 * @param opts.agentIds - 只扫指定 agent 的 session (默认空=全部)
 * @param opts.limit - 最大 session 数 (默认 200, 防 OOM)
 */
export async function scanSessionService(opts: {
  agentIds?: string[];
  limit?: number;
  since?: string; // ISO 时间, 只拉 updatedAt > since 的 session
  includeRetryable?: boolean; // 2026-09-01: 瞬时错误 FAILED 冷却后重新入队 (NETWORK 死端修复)
} = {}): Promise<ParsedConversation[]> {
  const results: ParsedConversation[] = [];
  const seen = new Set<string>();
  const agentFilter = opts.agentIds && opts.agentIds.length > 0
    ? new Set(opts.agentIds)
    : null;

  const pushPage = (sessions: SessionServiceSession[]) => {
    for (const sess of sessions) {
      if (agentFilter && !agentFilter.has(sess.agentId)) continue;
      // D-18 (2026-09-07): 防御 — SKIPPED(自动会话/空壳) 永不进提炼管线, 双保险防未来 API 变更
      if (sess.status === "SKIPPED") continue;
      if (seen.has(sess.sessionUid)) continue;
      const conv = sessionMetaToConversation(sess);
      if (conv) {
        seen.add(sess.sessionUid);
        results.push(conv);
      }
    }
  };

  const pageSize = 200;
  const maxSessions = opts.limit ?? 200;

  // 1. 重试扫描优先: RETRYABLE (瞬时错误 FAILED 冷却期已过) — 2026-09-01 NETWORK 死端修复
  //    状态机 FAILED→PROCESSING 允许重试; 这里把它拉回来走正常提取流程
  //    放最前保证每轮固定预算, 不被 PENDING 洪峰饿死
  if (opts.includeRetryable !== false) {
    const RETRYABLE_LIMIT = Math.min(20, maxSessions); // 每轮最多 20 条, 防雪崩
    let rCursor: string | null = null;
    for (let rp = 0; rp < 5 && results.length < RETRYABLE_LIMIT; rp++) {
      try {
        const params = new URLSearchParams({
          limit: String(Math.min(pageSize, RETRYABLE_LIMIT - results.length)),
        });
        if (rCursor) params.set("cursor", rCursor);
        params.set("status", "RETRYABLE");
        const url = `${SESSION_SERVICE_URL}/api/v1/sessions?${params.toString()}`;
        const res = await fetch(url, {
          headers: { "X-API-Key": SESSION_SERVICE_API_KEY },
        });
        if (!res.ok) break;
        const data = (await res.json()) as {
          sessions?: SessionServiceSession[];
          items?: SessionServiceSession[];
          nextCursor?: string | null;
        };
        const sessions = data.sessions || data.items || [];
        if (sessions.length === 0) break;
        pushPage(sessions);
        rCursor = data.nextCursor ?? null;
        if (!rCursor) break;
      } catch {
        break;
      }
    }
  }

  // 2. 主扫描: PENDING (extractStatus IS NULL 或 PENDING) — 空转治理, 排除 DONE
  let cursor: string | null = null;
  let page = 0;
  while (results.length < maxSessions) {
    try {
      const params = new URLSearchParams({
        limit: String(Math.min(pageSize, maxSessions - results.length)),
      });
      if (cursor) params.set("cursor", cursor);
      if (opts.since) params.set("since", opts.since);
      // P0-1 (2026-09-01) 空转治理: 只拉 PENDING (extractStatus IS NULL 或 PENDING),
      //   排除 FAILED/DONE — 失败 session 不再循环重提 (飞轮空转根因修复)
      params.set("status", "PENDING");
      const url = `${SESSION_SERVICE_URL}/api/v1/sessions?${params.toString()}`;
      const res = await fetch(url, {
        headers: { "X-API-Key": SESSION_SERVICE_API_KEY },
      });
      if (!res.ok) break;
      const data = (await res.json()) as {
        sessions?: SessionServiceSession[];
        items?: SessionServiceSession[];
        nextCursor?: string | null;
      };
      const sessions = data.sessions || data.items || [];
      if (sessions.length === 0) break;
      pushPage(sessions);
      cursor = data.nextCursor ?? null;
      page++;
      if (!cursor) break;
    } catch {
      break;
    }
  }

  return results;
}

/**
 * 仅 session 元数据 → ParsedConversation (不含 messages, 按需拉)
 */
function sessionMetaToConversation(
  sess: SessionServiceSession
): ParsedConversation | null {
  if (!sess.sessionUid) return null;
  // messageCount >= 2 才处理 (避免空 session 触发 LLM 调用)
  if (!sess.messageCount || sess.messageCount < 2) return null;

  return {
    sessionId: sess.sessionUid,
    projectPath: "lions-session-service",
    projectName: sess.agentId || "unknown-agent",
    title: sess.title,
    messages: [], // 留空, 由 extractCognitiveData 按需拉
    messageCount: sess.messageCount,
    startTime: sess.startedAt,
    endTime: sess.lastMessageAt,
    filePath: `session-service:${sess.sessionUid}`,
    // 2026-09-01 NETWORK 死端修复: RETRYABLE 扫描返回的 FAILED 会话优先处理
    retryable: sess.status === "FAILED",
  };
}

/**
 * 按需拉取 session 的 messages (extractCognitiveData 调用前)
 * 把 messages 注入到 ParsedConversation
 */
export async function enrichWithMessages(
  conv: ParsedConversation
): Promise<ParsedConversation> {
  if (conv.messages.length > 0) return conv; // 已有 messages
  if (!conv.filePath.startsWith("session-service:")) return conv;

  const sessionUid = conv.filePath.replace("session-service:", "");
  const detail = await fetchSessionFromService(sessionUid);
  if (!detail) return conv;

  const convMessages: ConversationMessage[] = [];
  for (const m of detail.messages) {
    if (!m.content || !m.content.trim()) continue;
    // P1-B 2026-08-31: 保留 tool/system 角色, 让 extractor 正确渲染 (防 tool 长内容污染 prompt)
    const role = (m.role === "user" || m.role === "assistant" || m.role === "tool" || m.role === "system")
      ? m.role as ConversationMessage["role"]
      : "assistant";
    const content = m.content;
    convMessages.push({
      role,
      content: content.length > MAX_MESSAGE_LENGTH
        ? content.slice(0, MAX_MESSAGE_LENGTH) + "..."
        : content,
      timestamp: m.timestamp,
      toolName: m.toolName,
    });
    if (convMessages.length >= MAX_MESSAGES) break;
  }

  return {
    ...conv,
    messages: convMessages,
    messageCount: convMessages.length,
  };
}

export function parseConversationFile(
  filePath: string,
  sessionId: string,
  projectPath: string,
  projectDirName: string
): ParsedConversation | null {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  const messages: ConversationMessage[] = [];
  let title: string | undefined;
  let startTime: string | undefined;
  let endTime: string | undefined;
  let actualMessageCount = 0;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const type = obj.type;

      if (type === "ai-title" && obj.aiTitle) {
        title = obj.aiTitle;
      }

      if (type === "user" || type === "assistant") {
        const msg = obj.message;
        if (!msg) continue;

        let textContent = "";
        if (typeof msg.content === "string") {
          textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter(
              (p: Record<string, unknown>) =>
                p.type === "text" && typeof p.text === "string"
            )
            .map((p: { text: string }) => p.text);
          textContent = textParts.join("\n");
        }

        if (!textContent.trim()) continue;
        if (textContent.length < 5) continue;

        if (!startTime && obj.timestamp) {
          startTime = obj.timestamp;
        }
        if (obj.timestamp) {
          endTime = obj.timestamp;
        }

        messages.push({
          role: type as "user" | "assistant",
          content:
            textContent.length > MAX_MESSAGE_LENGTH
              ? textContent.slice(0, MAX_MESSAGE_LENGTH) + "..."
              : textContent,
          timestamp: obj.timestamp,
        });
        actualMessageCount++;
      }
    } catch {
      continue;
    }
  }

  if (messages.length > MAX_MESSAGES) {
    const half = Math.floor(MAX_MESSAGES / 2);
    messages.splice(half, messages.length - MAX_MESSAGES);
  }

  return {
    sessionId,
    projectPath,
    projectName: parseProjectName(projectDirName),
    title,
    messages,
    messageCount: actualMessageCount,
    startTime,
    endTime,
    filePath,
  };
}

/**
 * 2026-08-21 leo 修复: SyncLog 与 pipeline sessionId/filePath 匹配错位
 *   之前: SyncLog.sourcePath 是 UUID (hermes-session-scanner 写的), pipeline.filePath 是 hermes://xxx, 永远不匹配 → alwaysProcessed=0
 *   现在: pipeline 写 DB 后用 filePath 写 SyncLog (db-writer.ts), 同时保留 UUID 旧数据
 *   匹配策略: 同时返回 filePath->count 和 sessionId->count 两套 key, 让 pipeline 用两者之一查
 */
export async function getAlreadyProcessedConversations(): Promise<Map<string, number>> {

  try {
    const logs = await prisma.syncLog.findMany({
      where: {
        status: "COMPLETED",
      },
      select: { sourcePath: true, messageCount: true },
    });

    // 同一个 sourcePath 可能有多条记录 (不同 sourceType), 取 messageCount 最大值
    const map = new Map<string, number>();
    for (const l of logs) {
      const existing = map.get(l.sourcePath);
      if (existing === undefined || l.messageCount > existing) {
        map.set(l.sourcePath, l.messageCount);
      }
      // 同时支持 sessionId 后缀匹配 (如 20260730_194934_23ca26)
      // SyncLog.sourcePath 现在包含 filePath (db-writer 写入), 也可能包含 UUID (老数据)
      // 把 sourcePath 的最后一段 (去掉前綴/路径) 也作为 key, 这样 sessionId 后缀能命中
      const lastSegment = l.sourcePath.split(/[/:\s]+/).pop() || "";
      if (lastSegment && lastSegment !== l.sourcePath) {
        const existing2 = map.get(lastSegment);
        if (existing2 === undefined || l.messageCount > existing2) {
          map.set(lastSegment, l.messageCount);
        }
      }
    }
    return map;
  } finally {
    prisma.$disconnect();
  }
}

/**
 * f-005 (2026-09-14) 统一匹配口径: 同一条 SyncLog 处理记录可能有 3 种可命中的 key ——
 *   ① conversation.filePath  (db-writer 写入的原始 sourcePath, 如 session-service:<uid>)
 *   ② conversation.sessionId (部分历史行直接以完整 uid 作为 sourcePath)
 *   ③ sessionId 的最后一段   (旧 UUID / 协议前缀行, 如 hermes://<id> 拆出的 id)
 *
 * 之前只有 index.ts 预切片循环按 ①②③ 三键查, 而 filterNewConversations /
 * getUpdatedConversations 只按 ② 查 —— 两处口径不一致, 导致已处理 session
 * 在过滤阶段被误判为 new 并重复 enrich (finding f-005 的真实残留).
 * 收敛到这一个 helper, 三个调用点共用同一套匹配语义.
 *
 * 只读、纯函数: 不写 DB, 便于单测/探针复算.
 */
export function lookupProcessedCount(
  processed: Map<string, number>,
  conv: { sessionId: string; filePath: string }
): number | undefined {
  const byFilePath = processed.get(conv.filePath);
  if (byFilePath !== undefined) return byFilePath;
  const bySessionId = processed.get(conv.sessionId);
  if (bySessionId !== undefined) return bySessionId;
  const lastSegment = conv.sessionId.split(/[/:\s]+/).pop() || "";
  if (lastSegment) {
    const byLastSegment = processed.get(lastSegment);
    if (byLastSegment !== undefined) return byLastSegment;
  }
  return undefined;
}

export async function filterNewConversations(
  conversations: ParsedConversation[]
): Promise<ParsedConversation[]> {
  const processed = await getAlreadyProcessedConversations();
  return conversations.filter((c) => {
    // f-005: 与 index.ts 的三键口径一致, 已处理(任意 key 命中)即不算 new
    return lookupProcessedCount(processed, c) === undefined;
  });
}

export async function getUpdatedConversations(
  conversations: ParsedConversation[]
): Promise<ParsedConversation[]> {
  const processed = await getAlreadyProcessedConversations();
  return conversations.filter((c) => {
    const processedCount = lookupProcessedCount(processed, c);
    return processedCount !== undefined && c.messageCount > processedCount;
  });
}

/**
 * P0-1 (2026-09-01) 空转治理: 回写 session 服务 extractStatus
 *   extract 成功/失败都回写, 让 scan 的 status=PENDING 过滤生效
 *   (失败 session 不再被下次 cron 循环重提 — 飞轮空转根因)
 */
export async function markSessionExtractStatus(
  sessionUid: string,
  status: "DONE" | "FAILED",
  error?: string,
): Promise<void> {
  const patch = (s: string, err?: string) =>
    fetch(`${SESSION_SERVICE_URL}/api/v1/sessions/${encodeURIComponent(sessionUid)}/status`, {
      method: "PATCH",
      headers: {
        "X-API-Key": SESSION_SERVICE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: s,
        processedBy: "mind-pull",
        ...(err ? { error: err } : {}),
      }),
    });
  try {
    const res = await patch(status, error);
    // 状态机: PENDING → PROCESSING → DONE/FAILED; PENDING 不能直接到终态
    //   409 = 状态机拒绝 (PENDING->FAILED 或 PENDING->DONE), 先转 PROCESSING 再转目标
    if (res.status === 409) {
      const claim = await patch("PROCESSING");
      if (claim.ok || claim.status === 409) {
        // 409 说明已被其他 worker claim, 不再重复写终态 (让那个 worker 负责)
        if (claim.ok) await patch(status, error);
      }
    }
  } catch (e) {
    console.warn(`[scanner] markSessionExtractStatus ${sessionUid} -> ${status} failed: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }
}
