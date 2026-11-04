import { prisma } from "@/lib/prisma";
import { loadScanSources, scanSource, ScanSource } from "@/lib/scan-sources";

/**
 * 服务端多源 sync (2026-06-24 重写).
 *
 * 数据源由 LIONS_SYNC_SOURCES (JSON) 决定, 默认 2 个:
 *   1. agent-h  ← ~/00 ai agent/hermes work/state.db
 *   2. agent-g ← ~/.claude/projects
 *
 * 增量策略: 只处理 mtime > watermark 的文件 (claude) / started_at > watermark (hermes)
 * watermark 存 prisma SyncWatermark 表, 第一次跑全量.
 */

async function getWatermark(source: string): Promise<number> {
  const w = await prisma.syncWatermark.findUnique({ where: { source } });
  return w?.lastTs ? Math.floor(w.lastTs.getTime() / 1000) : 0;
}

async function setWatermark(source: string, ts: number, count: number, err?: string): Promise<void> {
  await prisma.syncWatermark.upsert({
    where: { source },
    update: { lastTs: new Date(ts * 1000), lastRunAt: new Date(), lastCount: count, lastError: err },
    create: { source, lastTs: new Date(ts * 1000), lastRunAt: new Date(), lastCount: count, lastError: err },
  });
}

function sessionDataId(agentId: string, sourceType: string, externalId: string): string {
  return `${sourceType}-${agentId}-${externalId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function messageDataId(sourceType: string, externalId: string): string {
  return `${sourceType}-msg-${externalId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const BATCH_SIZE = 500;

async function syncOneSource(src: ScanSource): Promise<{ sessions: number; messages: number }> {
  const watermarkKey = `${src.agentId}:${src.sourceType}`;
  const watermark = await getWatermark(watermarkKey);
  const t0 = Date.now();
  console.log(`[sync] ${watermarkKey}  watermark=${watermark}  path=${src.path}`);

  const result = scanSource(src, watermark);
  if (result.sessions.length === 0) {
    console.log(`[sync] ${watermarkKey}  no new sessions (${Date.now()-t0}ms)`);
    return { sessions: 0, messages: 0 };
  }

  let newSessions = 0;
  let newMessages = 0;
  let maxTs = watermark;
  let errMsg: string | undefined;

  try {
    // 1. 批量 upsert sessions (createMany + skipDuplicates 替代 prisma 慢 upsert)
    for (let i = 0; i < result.sessions.length; i += BATCH_SIZE) {
      const chunk = result.sessions.slice(i, i + BATCH_SIZE);
      await prisma.$transaction(
        chunk.map(ps => {
          const id = sessionDataId(src.agentId, src.sourceType, ps.externalId);
          return prisma.session.upsert({
            where: { id },
            create: {
              id,
              sessionUid: `${src.agentId}:${src.sourceType.toLowerCase()}:${ps.externalId}`.replace(/[^a-zA-Z0-9:_-]/g, "_"),
              agentId: src.agentId,
              agentName: src.agentName || src.agentId,
              source: src.source,
              sourceId: ps.externalId,
              title: ps.title,
              platform: src.sourceType,
              channel: src.sourceType,
              startedAt: new Date(ps.startedAt * 1000),
              lastMessageAt: ps.lastMsgTs ? new Date(ps.lastMsgTs * 1000) : null,
              endedAt: ps.endedAt ? new Date(ps.endedAt * 1000) : null,
              messageCount: ps.messageCount,
              model: ps.model,
              isActive: !ps.endedAt,
              fullSyncSource: "scan-local",
              fullSyncedAt: new Date(),
            },
            update: {
              title: ps.title || undefined,
              lastMessageAt: ps.lastMsgTs ? new Date(ps.lastMsgTs * 1000) : undefined,
              endedAt: ps.endedAt ? new Date(ps.endedAt * 1000) : undefined,
              messageCount: ps.messageCount,
              model: ps.model || undefined,
              isActive: !ps.endedAt,
              fullSyncedAt: new Date(),
            },
          });
        })
      );
      newSessions += chunk.length;
      for (const ps of chunk) {
        if (ps.lastMsgTs && ps.lastMsgTs > maxTs) maxTs = ps.lastMsgTs;
      }
      console.log(`[sync] ${watermarkKey}  sessions ${newSessions}/${result.sessions.length}`);
    }

    // 2. 批量写 messages (createMany + skipDuplicates)
    if (result.messages.length > 0) {
      const extIdToId = new Map<string, string>();
      for (const ps of result.sessions) {
        extIdToId.set(ps.externalId, sessionDataId(src.agentId, src.sourceType, ps.externalId));
      }

      const validMsgs = result.messages
        .filter(m => extIdToId.has(m.sessionExternalId))
        .map(m => ({
          id: messageDataId(src.sourceType, m.externalId),
          sessionId: extIdToId.get(m.sessionExternalId)!,
          role: m.role,
          content: m.content,
          timestamp: new Date(m.timestamp * 1000),
          toolCallId: m.toolCallId ?? null,
          toolName: m.toolName ?? null,
          toolCalls: m.toolCalls ?? null,
          tokenCount: m.tokenCount ?? null,
          reasoning: m.reasoning ?? null,
        }));

      for (let i = 0; i < validMsgs.length; i += BATCH_SIZE) {
        const chunk = validMsgs.slice(i, i + BATCH_SIZE);
        try {
          const r = await prisma.message.createMany({ data: chunk });
          newMessages += r.count;
        } catch (e: any) {
          // SQLite UNIQUE 冲突 = 已存在, 逐条 fallback (prisma sqlite 不支持 skipDuplicates)
          if (!String(e.message).includes("Unique")) throw e;
          for (const m of chunk) {
            try {
              await prisma.message.create({ data: m });
              newMessages++;
            } catch (e2: any) {
              if (!String(e2.message).includes("Unique")) throw e2;
            }
          }
        }
        if (i % (BATCH_SIZE * 5) === 0) {
          console.log(`[sync] ${watermarkKey}  messages ${newMessages}/${validMsgs.length}`);
        }
      }
    }

    if (maxTs > watermark) {
      await setWatermark(watermarkKey, maxTs, newMessages);
    }
    console.log(`[sync] ${watermarkKey}  +${newSessions} sessions, +${newMessages} messages, watermark → ${maxTs}  (${Date.now()-t0}ms)`);
  } catch (e: any) {
    errMsg = String(e).slice(0, 500);
    await setWatermark(watermarkKey, maxTs, newMessages, errMsg);
    throw e;
  }

  return { sessions: newSessions, messages: newMessages };
}

export async function syncSessions(): Promise<{ sessions: number; messages: number; perSource: Record<string, { sessions: number; messages: number }>; aggregate?: { groupsCreated: number; sessionsAssigned: number; errors: string[] } }> {
  const sources = loadScanSources();
  let totalSessions = 0;
  let totalMessages = 0;
  const perSource: Record<string, { sessions: number; messages: number }> = {};

  for (const src of sources) {
    try {
      const r = await syncOneSource(src);
      perSource[`${src.agentId}:${src.sourceType}`] = r;
      totalSessions += r.sessions;
      totalMessages += r.messages;
    } catch (e) {
      console.error(`[sync] ${src.agentId}:${src.sourceType} 失败:`, e);
      perSource[`${src.agentId}:${src.sourceType}`] = { sessions: 0, messages: 0 };
    }
  }

  // P4-5 (2026-07-12): sync 后自动归组 Session → SessionGroup
  // 之前 sync.ts 只 upsert Session, SessionGroup 表是空的
  // (虽然 session-aggregator.ts 有 aggregateAllSessions 函数, 但从来没人调用它)
  // 现在 sync 完顺手归组, 让飞轮能看到 PENDING group
  if (totalSessions > 0) {
    try {
      const { aggregateAllSessions } = await import("./session-aggregator");
      const aggResult = await aggregateAllSessions({ limit: 500 });
      console.log(`[sync] aggregate: groupsCreated=${aggResult.groupsCreated} sessionsAssigned=${aggResult.sessionsAssigned} errors=${aggResult.errors.length}`);
      return { sessions: totalSessions, messages: totalMessages, perSource, aggregate: aggResult };
    } catch (e) {
      console.error("[sync] aggregate 失败 (非阻塞):", e);
    }
  }

  return { sessions: totalSessions, messages: totalMessages, perSource };
}
