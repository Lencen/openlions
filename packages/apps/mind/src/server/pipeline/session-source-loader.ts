/**
 * session-source-loader via LionsSessionAdapter — V1 §15.2.1 阶段交付
 *
 * 替换 session-adapter.ts 的 processClaimedSessions 链路:
 *   - 之前: mind 直读 SessionRegistry 表
 *   - 现在: 走 LionsSessionAdapter HTTP 拉 lions-session
 *   - 优势: mind 不存原文, 单向同步, lions-session 数据量 >> mind 缓存
 *
 * 真验 (§15.2.1): lions-session 数据量 >> mind SessionRegistry
 *
 * 流程:
 *   1. scan() → 拉一批 PENDING session uid
 *   2. fetchDetail() → 拉原文 (messages)
 *   3. 走现有 extractCognitiveData + writeToDatabase
 *   4. markStatus(uid, 'DONE'|'FAILED') → 通知 lions-session
 */

import { LionsSessionAdapter } from "./lions-session-adapter";
import { fetchSourceText } from "./source-fetcher";
import type { ParsedConversation } from "./types";
import { sourceToSourceType } from "./session-adapter";
import { prisma } from "@/lib/prisma";

const adapter = new LionsSessionAdapter();

// 2026-07-02 STRUCTURED-V3 S5: 回写 mind 本地 SessionRegistry
// lions-session 服务端 markStatus 只更新远端 Session 表, mind 本地这张镜像表也要同步
// 保证 /pipeline UI 显示的 status 与真处理结果一致 (不再永远 PENDING)
async function syncMindRegistryStatus(
  sessionUid: string,
  status: "PROCESSED" | "FAILED" | "SKIPPED",
  opts?: { recordsCreated?: number; error?: string }
): Promise<void> {
  try {
    // 用 session_uid 定位; mind SessionRegistry.session_uid 和 lions-session s.sessionUid 一致
    const existing = await prisma.sessionRegistry.findUnique({
      where: { session_uid: sessionUid },
      select: { id: true },
    });
    if (!existing) return; // 本地无该镜像行 (S7 反向 sync 前是空的), 静默跳过
    await prisma.sessionRegistry.update({
      where: { session_uid: sessionUid },
      data: {
        status,
        processed_at: new Date(),
        processing_error: opts?.error ?? null,
      },
    });
  } catch (e) {
    // 回写失败不能拖垮主流程 (真处理已完成), 只 console.error
    console.error(`[session-source-loader] syncMindRegistryStatus ${sessionUid} → ${status} failed:`, e);
  }
}

interface ProcessOptions {
  limit?: number;
  dryRun?: boolean;
  agentId?: string;
  source?: string;
  onProgress?: (p: { claimed: number; processed: number; failed: number }) => void;
}

interface ProcessResult {
  claimed: number;
  processed: number;
  failed: number;
  skipped: number;
  results: Array<{
    sessionUid: string;
    status: "PROCESSED" | "FAILED" | "SKIPPED";
    recordsCreated?: number;
    error?: string;
  }>;
}

export async function processViaLionsSession(
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  const limit = options.limit ?? 5;
  const dryRun = options.dryRun ?? false;
  const onProgress = options.onProgress;

  // 1. 拉一批 PENDING + RETRYABLE (2026-09-01 NETWORK 死端修复:
  //    瞬时错误 FAILED 冷却后重新入队, 这里一起拉回来重试)
  const page = await adapter.scan({
    status: "PENDING",
    agentId: options.agentId,
    source: options.source,
    limit,
    minMessages: 1,
  });
  let summaries = page.items;
  if (summaries.length < limit) {
    try {
      const retryPage = await adapter.scan({
        status: "RETRYABLE",
        agentId: options.agentId,
        source: options.source,
        limit: limit - summaries.length,
        minMessages: 1,
      });
      const seen = new Set(summaries.map((s) => s.sessionUid));
      summaries = [...summaries, ...retryPage.items.filter((s) => !seen.has(s.sessionUid))];
    } catch {
      // RETRYABLE 扫描失败不阻塞主流程
    }
  }

  if (summaries.length === 0) {
    return { claimed: 0, processed: 0, failed: 0, skipped: 0, results: [] };
  }

  // 2-4. 逐条处理
  const { extractCognitiveData } = await import("./cognitive-extractor");
  const { writeToDatabase } = await import("./db-writer");

  const results: ProcessResult["results"] = [];
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  // 2026-09-01 合并提交优化: 收集待提取 session, 循环后统一 batch 调用 (减少 LLM 调用次数)
  const pendingExtracts: Array<{ s: (typeof summaries)[0]; parsed: ParsedConversation }> = [];

  for (const s of summaries) {
    try {
      // B14 (2026-07-01): 服务端已终态 (DONE/FAILED) 的 session 直接 skip,
      // 不再 mark PROCESSING (会被状态机拒绝). scan 理论上只返回 PENDING,
      // 但为兜底: 状态非 PENDING 一律 skip.
      // 2026-09-01 例外: RETRYABLE 扫描返回的 FAILED (瞬时错误) 允许重试 —
      //   状态机 FAILED→PROCESSING 合法, 直接 claim 继续处理 (NETWORK 死端修复)
      if (s.status && s.status !== "PENDING" && s.status !== "FAILED") {
        results.push({
          sessionUid: s.sessionUid,
          status: "SKIPPED",
          error: `already in terminal status: ${s.status}`,
        });
        skipped++;
        onProgress?.({ claimed: summaries.length, processed, failed });
        continue;
      }

      // 通知: 开始处理
      // P2-2 (2026-08-31): claim 语义 — markStatus 返回 skipped=true 说明服务端状态机 409
      //   (已被其他并发 worker claim 成 PROCESSING)。此前把 409 当幂等成功但继续 extract,
      //   导致同一 session 被 N 个并发 trace 重复 extract (额度烧光根因之一)。
      //   现在: 409 = 别人在处理, 直接 skip, 不重复拉原文/调 LLM。
      const claim = await adapter.markStatus(s.sessionUid, "PROCESSING", {
        processedBy: "mind-pull",
      });
      if (claim.skipped) {
        results.push({
          sessionUid: s.sessionUid,
          status: "SKIPPED",
          error: "claimed by another worker (状态机 409, 防重复 extract)",
        });
        skipped++;
        onProgress?.({ claimed: summaries.length, processed, failed });
        continue;
      }

      // 拉原文 — 三路 fallback (lions-session → claude transcript → hermes state)
      let detail = await adapter.fetchDetail(s.sessionUid);
      let usedFallback = false;
      if (detail.messages.length === 0) {
        // B14 兜底: lions-session 端没原文时, 走本地真源 fallback
        // 2026-07-14: 这是 1327→276 PENDING 积压 12 天的根因修复
        // bulkUpload / bulkSyncFromLocal 上传时只写 metadata, needsRefetch=true
        // 注释承诺 "走 session_uid 反向拉取" 但没实现, 这里补上
        console.warn(`[session-source-loader] lions-session empty for ${s.sessionUid}, fallback to source-fetcher`);
        const local = await fetchSourceText({
          sessionUid: s.sessionUid,
          agentId: s.agentId || "unknown",
          source: s.source || "CUSTOM",
          sourceId: s.sessionUid.split(":").slice(2).join(":"), // session_uid = agent:source:sourceId
        });
        if (!local || local.messages.length === 0) {
          await adapter.markStatus(s.sessionUid, "FAILED", {
            processedBy: "mind-pull",
            error: "no messages + source-fetcher fallback empty",
          });
          await syncMindRegistryStatus(s.sessionUid, "SKIPPED", {
            error: "no messages + source-fetcher fallback empty (12d-deadlock P1-2 fix)",
          });
          results.push({ sessionUid: s.sessionUid, status: "SKIPPED", error: "no messages + source-fetcher fallback empty" });
          skipped++;
          onProgress?.({ claimed: summaries.length, processed, failed });
          continue;
        }
        // 用 fallback 拉到的 messages 拼一个 detail-shape
        detail = {
          session: {
            sessionUid: s.sessionUid,
            agentId: s.agentId || null,
            source: s.source || null,
            sourceId: s.sessionUid.split(":").slice(2).join(":"),
            title: s.title || null,
            startedAt: s.startedAt || null,
            lastMessageAt: s.lastMessageAt || null,
            updatedAt: new Date().toISOString(),
            messageCount: local.messageCount,
            status: "PENDING",
            model: null,
            platform: null,
          },
          messages: local.messages.map((m, idx) => ({
            messageUid: `${s.sessionUid}_${idx}`,
            role: m.role,
            content: m.content,
            createdAt: m.timestamp || new Date().toISOString(),
            model: null,
            reasoning: null,
          })),
        };
        usedFallback = true;
        console.log(`[session-source-loader] ${s.sessionUid} fallback ${local.source} got ${local.messageCount} messages`);
      }

      // 转成 pipeline 的 ParsedConversation (复用 session-adapter 的逻辑)
      const parsed: ParsedConversation = {
        sessionId: detail.session.sourceId || s.sessionUid,
        projectPath: `lions-session://${s.agentId}/${(s.source || "unknown").toLowerCase()}`,
        projectName: `agent-${s.agentId}/${(s.source || "unknown").toLowerCase()}`,
        title: detail.session.title || s.title || s.sessionUid,
        messages: detail.messages.map((m) => ({
          role: m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "assistant",
          content: m.content || "",
          timestamp: m.createdAt,
        })),
        messageCount: detail.messages.length,
        startTime: detail.session.startedAt || undefined,
        endTime: detail.session.lastMessageAt || undefined,
        filePath: `lions-session://${s.sessionUid}`,
      };

      // 2026-09-01 合并提交: 不再逐 session 调 LLM, 收集后循环外统一 batch 提取
      pendingExtracts.push({ s, parsed });
      // 注意: 提取+写入在循环后统一处理 (见下方 batchExtractPending)
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const errStack = e instanceof Error ? (e.stack || "") : "";
      console.error(`[session-source-loader] ${s.sessionUid} failed:`, errMsg);
      console.error(`[session-source-loader] stack:`, errStack.split("\n").slice(0, 6).join(" | "));

      // B14 (2026-07-01): 区分数据坏账 vs 真处理失败.
      // 数据坏账 (JSON 解析失败 / 空 payload / 明确的格式错误) → SKIP,
      // 不占 FAILED 名额, 也不再反复重试.
      const isBadData =
        /Expected .* JSON at position/i.test(errMsg) ||
        /Invalid JSON/i.test(errMsg) ||
        /Unexpected token/i.test(errMsg) ||
        /no messages/i.test(errMsg);

      const targetStatus: "DONE" | "FAILED" = isBadData ? "DONE" : "FAILED";
      try {
        await adapter.markStatus(s.sessionUid, targetStatus, {
          processedBy: "mind-pull",
          error: errMsg,
        });
      } catch (markErr) {
        console.error(`[session-source-loader] markStatus also failed:`, markErr);
      }
      // 回写 mind 本地 SessionRegistry
      await syncMindRegistryStatus(
        s.sessionUid,
        isBadData ? "SKIPPED" : "FAILED",
        { error: errMsg }
      );

      if (isBadData) {
        results.push({ sessionUid: s.sessionUid, status: "SKIPPED", error: `bad-data: ${errMsg}` });
        skipped++;
      } else {
        results.push({ sessionUid: s.sessionUid, status: "FAILED", error: errMsg });
        failed++;
      }
    }
    onProgress?.({ claimed: summaries.length, processed, failed });
  }

  // ===== 2026-09-01 合并提交优化: 统一 batch 提取 (1 次调用处理多个 session) =====
  if (pendingExtracts.length > 0) {
    const { extractCognitiveDataBatch } = await import("./cognitive-extractor");
    // 分批: 每批最多 8 个 session (与主路径 MAX_SESSIONS_PER_BATCH 一致)
    const BATCH = 8;
    for (let bi = 0; bi < pendingExtracts.length; bi += BATCH) {
      const slice = pendingExtracts.slice(bi, bi + BATCH);
      const batchInputs = slice.map((p, idx) => ({
        conversation: p.parsed,
        newMessages: p.parsed.messages,
        lastProcessedCount: 0,
        sessionIndex: idx + 1,
      }));
      const extractedMap = new Map<string, any>();
      try {
        const batchResults = await extractCognitiveDataBatch(batchInputs);
        for (const r of batchResults) extractedMap.set(r.sessionId, r.extracted);
      } catch (e) {
        console.error(`[session-source-loader] batch extract failed (${slice.length} sessions):`, e instanceof Error ? e.message.slice(0, 150) : e);
        // batch 失败 -> 该批全部标记 FAILED (不逐个再调, 避免碎片化)
        for (const p of slice) {
          const errMsg = e instanceof Error ? e.message : String(e);
          await adapter.markStatus(p.s.sessionUid, "FAILED", { processedBy: "mind-pull", error: errMsg });
          await syncMindRegistryStatus(p.s.sessionUid, "FAILED", { error: errMsg });
          results.push({ sessionUid: p.s.sessionUid, status: "FAILED", error: errMsg });
          failed++;
        }
        continue;
      }
      // 逐个写库 + 标记 DONE
      for (const p of slice) {
        const extracted = extractedMap.get(p.parsed.sessionId);
        try {
          if (dryRun) {
            await adapter.markStatus(p.s.sessionUid, "DONE", { processedBy: "mind-pull", error: "dry run" });
            await syncMindRegistryStatus(p.s.sessionUid, "PROCESSED", { recordsCreated: 0 });
            results.push({ sessionUid: p.s.sessionUid, status: "PROCESSED", recordsCreated: 0 });
            processed++;
            continue;
          }
          if (!extracted) {
            throw new Error("batch 未返回该 session 的提取结果");
          }
          const sourceType = sourceToSourceType(p.s.source || "CUSTOM", p.s.agentId || "unknown");
          const writeResult = await writeToDatabase(p.parsed, extracted, { sourceType });
          const totalRecords =
            writeResult.stats.memoriesCreated +
            writeResult.stats.knowledgeCreated +
            writeResult.stats.reflectionsCreated +
            writeResult.stats.practicesCreated +
            writeResult.stats.skillsCreated;
          await adapter.markStatus(p.s.sessionUid, "DONE", { processedBy: "mind-pull" });
          await syncMindRegistryStatus(p.s.sessionUid, "PROCESSED", { recordsCreated: totalRecords });
          results.push({ sessionUid: p.s.sessionUid, status: "PROCESSED", recordsCreated: totalRecords });
          processed++;
        } catch (err: any) {
          console.error(`[session-source-loader] ${p.s.sessionUid} write failed:`, err.message?.slice(0, 120));
          await adapter.markStatus(p.s.sessionUid, "FAILED", { processedBy: "mind-pull", error: err.message });
          await syncMindRegistryStatus(p.s.sessionUid, "FAILED", { error: err.message });
          results.push({ sessionUid: p.s.sessionUid, status: "FAILED", error: err.message });
          failed++;
        }
      }
    }
  }

  return {
    claimed: summaries.length,
    processed,
    failed,
    skipped,
    results,
  };
}

export { adapter as default, LionsSessionAdapter };