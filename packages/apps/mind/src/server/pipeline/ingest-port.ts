/**
 * ingest-port.ts — IngestPort 只读 adapter（2026-10-27）
 *
 * 只读 SessionExtractionState，回答"这个会话采到哪一步"；真正的提取仍由
 * scripts/session-extract.ts 负责。用于替换采集实现前先切读侧。
 */
import { prisma } from "@/lib/prisma";

export type IngestStatus = {
  sessionUid: string;
  agentId: string | null;
  status: string | null;
  lastMessageAt: number | null;
  extractedAt: number | null;
  error: string | null;
};

export type IngestReadPort = {
  status(sessionUid: string): Promise<IngestStatus | null>;
};

export function createIngestReadPort(): IngestReadPort {
  return {
    async status(sessionUid: string): Promise<IngestStatus | null> {
      const rows: any[] = await (prisma as any).$queryRawUnsafe(
        'SELECT "sessionUid","agentId",status,"lastMessageAt","extractedAt",error FROM "SessionExtractionState" WHERE "sessionUid"=$1 LIMIT 1',
        sessionUid,
      );
      const r = rows[0];
      if (!r) return null;
      return {
        sessionUid: String(r.sessionUid),
        agentId: r.agentId ?? null,
        status: r.status ?? null,
        lastMessageAt: r.lastMessageAt == null ? null : Number(r.lastMessageAt),
        extractedAt: r.extractedAt == null ? null : Number(r.extractedAt),
        error: r.error ?? null,
      };
    },
  };
}
