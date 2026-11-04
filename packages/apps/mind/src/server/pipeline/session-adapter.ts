/**
 * 2026-06-17 P4 NEW: Session Registry Adapter
 *
 * 把 SessionRegistry 表里的 session 适配成 pipeline 能处理的 ParsedConversation
 *
 * 流程:
 *   1. claim() - 从 SessionRegistry 拉 PENDING session (原子切换到 PROCESSING)
 *   2. convertToParsedConversation() - 把 raw_payload 里的 messages 转成 ParsedConversation
 *   3. extractCognitiveData() - 走现有 LLM 提取逻辑 (跟 claude 扫描共用)
 *   4. writeToDatabase() - 写入 mind DB, 跟现有流程一致
 *   5. update() - 把 SessionRegistry 标记成 PROCESSED / FAILED
 *
 * 关键: 提取 + 写入 完全复用现有 pipeline 逻辑, 不重写
 *   优势: 一处修改, 全员受益 (PIPELINE_CLAUDE / PIPELINE_HERMES / 未来 OPENAI 都走这个)
 *
 * agent_id + source 的语义:
 *   - source 决定 sourceType (写入 Mind.memory.sourceType), 用于数据归因
 *   - sourceId 决定 filePath, 跟原系统对齐 (方便 dedup)
 */

import type { ParsedConversation, ConversationMessage } from "./types";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

// 跟 conversation-scanner 的 fingerprint 算法对齐 (避免重复)
function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

interface SessionRegistryRow {
  id: string;
  session_uid: string;
  agent_id: string;
  source: string;
  source_id: string;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_message_at: string | null;
  message_count: number;
  raw_payload: string | null;
  payload_size: number;
  status: string;
  uploaded_at: string;
}

interface RawPayload {
  messages?: Array<{
    role: string;
    content: string;
    timestamp?: string;
  }>;
  metadata?: Record<string, any>;
}

/**
 * 把 SessionRegistry 一行转成 ParsedConversation
 * 关键映射:
 *   - sessionId  ← source_id (原始 source 的 id, 跟原来 conversationId 同名)
 *   - projectName ← "agent-{agent_id}/{source}" (虚拟 project, 跟原"项目"概念对齐)
 *   - projectPath ← "agent-registry://{agent_id}/{source}"
 *   - messages    ← raw_payload.messages
 *   - messageCount ← raw_payload 实际数量 (若 raw_payload 缺失, 用表里的 message_count)
 *   - startTime / endTime ← 表里时间戳
 *   - filePath    ← "session-registry://{session_uid}"
 */
export function convertToParsedConversation(
  row: SessionRegistryRow
): ParsedConversation {
  let messages: ConversationMessage[] = [];
  if (row.raw_payload) {
    try {
      const parsed: RawPayload = JSON.parse(row.raw_payload);
      if (Array.isArray(parsed.messages)) {
        messages = parsed.messages
          .filter((m) => m && typeof m.content === "string")
          .map((m) => ({
            role: (m.role === "assistant" ? "assistant" : "user") as
              | "user"
              | "assistant",
            content: m.content,
            timestamp: m.timestamp,
          }));
      }
    } catch (e) {
      console.warn(
        `[session-adapter] failed to parse raw_payload for ${row.session_uid}:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  return {
    sessionId: row.source_id,
    projectPath: `agent-registry://${row.agent_id}/${row.source.toLowerCase()}`,
    projectName: `agent-${row.agent_id}/${row.source.toLowerCase()}`,
    title: row.title || `${row.source}: ${row.source_id}`,
    messages,
    messageCount: messages.length || Number(row.message_count) || 0,
    startTime: row.started_at || undefined,
    endTime: row.ended_at || row.last_message_at || undefined,
    filePath: `session-registry://${row.session_uid}`,
  };
}

/**
 * 把 source 映射成 pipeline 的 sourceType (写 Mind.memory.sourceType 用)
 * 对齐 conversation-scanner 里的命名空间
 */
export function sourceToSourceType(
  source: string,
  agentId: string
): string {
  switch (source) {
    case "CLAUDE_CONVERSATION":
      return "PIPELINE_CLAUDE";
    case "HERMES_SESSION":
      return "PIPELINE_HERMES";
    case "OPENAI_THREAD":
      return "PIPELINE_OPENAI";
    case "CUSTOM":
    default:
      return `PIPELINE_${agentId.toUpperCase()}`;
  }
}

/**
 * 完整流程: claim → convert → extract → write → update
 * 这是 Session 管理服务的核心, 把中枢表和 pipeline 打通
 */
export async function processClaimedSessions(
  apiKey: string,
  options: {
    limit?: number;
    dryRun?: boolean;
    onProgress?: (progress: {
      claimed: number;
      processed: number;
      failed: number;
    }) => void;
  } = {}
): Promise<{
  claimed: number;
  processed: number;
  failed: number;
  skipped: number;
  results: Array<{
    session_uid: string;
    status: "PROCESSED" | "FAILED" | "SKIPPED";
    recordsCreated?: number;
    error?: string;
  }>;
}> {
  const limit = options.limit ?? 5;
  const dryRun = options.dryRun ?? false;
  const onProgress = options.onProgress;

  // 1. claim 一批 (用 Prisma 客户端通过 TRPC 风格调用内部方法, 但为简化直接用 raw SQL)
  const claimedRows = await prisma.$queryRawUnsafe<SessionRegistryRow[]>(
    `SELECT id, session_uid, agent_id, source, source_id, title,
            started_at, ended_at, last_message_at, message_count,
            raw_payload, payload_size, status, uploaded_at
     FROM SessionRegistry
     WHERE status = 'PENDING'
     ORDER BY uploaded_at ASC
     LIMIT ?`,
    limit
  );

  if (claimedRows.length === 0) {
    return { claimed: 0, processed: 0, failed: 0, skipped: 0, results: [] };
  }

  // 2. 原子 PENDING → PROCESSING
  const ids = claimedRows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  await prisma.$executeRawUnsafe(
    `UPDATE SessionRegistry
     SET status = 'PROCESSING', updated_at = ?
     WHERE id IN (${placeholders}) AND status = 'PENDING'`,
    new Date().toISOString(),
    ...ids
  );

  // 3. 逐条处理
  const { extractCognitiveData } = await import("./cognitive-extractor");
  const { writeToDatabase } = await import("./db-writer");

  const results: Array<{
    session_uid: string;
    status: "PROCESSED" | "FAILED" | "SKIPPED";
    recordsCreated?: number;
    error?: string;
  }> = [];

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of claimedRows) {
    const sessionUid = row.session_uid;
    try {
      // 跳过: raw_payload 没有有效 messages
      if (!row.raw_payload || row.payload_size === 0) {
        await updateSessionStatus(apiKey, sessionUid, "SKIPPED", "empty payload");
        results.push({ session_uid: sessionUid, status: "SKIPPED", error: "empty payload" });
        skipped++;
        onProgress?.({ claimed: claimedRows.length, processed, failed });
        continue;
      }

      const parsed = convertToParsedConversation(row);
      if (parsed.messages.length === 0) {
        await updateSessionStatus(apiKey, sessionUid, "SKIPPED", "no messages");
        results.push({ session_uid: sessionUid, status: "SKIPPED", error: "no messages" });
        skipped++;
        onProgress?.({ claimed: claimedRows.length, processed, failed });
        continue;
      }

      // 3a. LLM 提取
      const extracted = await extractCognitiveData(parsed);

      // 3b. 写入 mind DB
      if (!dryRun) {
        const sourceType = sourceToSourceType(row.source, row.agent_id);
        const writeResult = await writeToDatabase(parsed, extracted, {
          sourceType,
        });
        const totalRecords =
          writeResult.stats.memoriesCreated +
          writeResult.stats.knowledgeCreated +
          writeResult.stats.reflectionsCreated +
          writeResult.stats.practicesCreated +
          writeResult.stats.skillsCreated;

        await updateSessionStatus(apiKey, sessionUid, "PROCESSED");
        results.push({
          session_uid: sessionUid,
          status: "PROCESSED",
          recordsCreated: totalRecords,
        });
        processed++;
      } else {
        await updateSessionStatus(apiKey, sessionUid, "PROCESSED", "dry run");
        results.push({ session_uid: sessionUid, status: "PROCESSED", recordsCreated: 0 });
        processed++;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[session-adapter] process ${sessionUid} failed:`, errMsg);
      await updateSessionStatus(apiKey, sessionUid, "FAILED", errMsg);
      results.push({ session_uid: sessionUid, status: "FAILED", error: errMsg });
      failed++;
    }
    onProgress?.({ claimed: claimedRows.length, processed, failed });
  }

  return {
    claimed: claimedRows.length,
    processed,
    failed,
    skipped,
    results,
  };
}

/**
 * 更新 session 状态 (走 TRPC 端点 path: sessionRegistry.update)
 * 内部 helper, 复用端点逻辑
 */
async function updateSessionStatus(
  apiKey: string,
  sessionUid: string,
  status: "PROCESSED" | "FAILED" | "SKIPPED",
  error?: string
): Promise<void> {
  // 直接 SQL 更新 (避免 server-internal 调 TRPC 的繁琐, 且 adapter 跑在服务端)
  // 跟 session-registry.ts 端点里的更新逻辑保持一致
  const now = new Date().toISOString();
  const shouldSetProcessedAt = status === "PROCESSED" || status === "FAILED";
  await prisma.$executeRawUnsafe(
    `UPDATE SessionRegistry
     SET status = ?, processed_at = ?, processing_error = ?, updated_at = ?
     WHERE session_uid = ?`,
    status,
    shouldSetProcessedAt ? now : null,
    error ?? null,
    now,
    sessionUid
  );
}
