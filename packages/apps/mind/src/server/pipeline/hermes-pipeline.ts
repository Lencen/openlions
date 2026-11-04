import { prisma } from "@/lib/prisma";
import { PrismaClient } from "../../../node_modules/.prisma/mind-client";
import { scanHermesSessions, getHermesMessages, markSessionProcessed } from "./hermes-session-scanner";
import { extractCognitiveData } from "./cognitive-extractor";
import { writeToDatabase } from "./db-writer";
import type { ParsedConversation, PipelineResult } from "./types";

export interface HermesPipelineResult {
  processed: number;
  errors: string[];
  summary: Array<{
    sessionId: string;
    title: string;
    stats: PipelineResult["stats"];
  }>;
}

function hermesToParsedConversation(
  session: { id: string; source: string; title: string | null; startedAt: Date; endedAt: Date | null; messageCount: number },
  messages: Array<{ role: string; content: string | null; timestamp: Date; toolName: string | null }>
): ParsedConversation {
  return {
    sessionId: session.id,
    projectPath: session.source,
    projectName: session.source || "hermes",
    title: session.title || undefined,
    messages: messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .filter((m) => m.content && m.content.trim().length > 5)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content || "",
        timestamp: m.timestamp.toISOString(),
      })),
    messageCount: session.messageCount,
    startTime: session.startedAt.toISOString(),
    endTime: session.endedAt?.toISOString(),
    filePath: `hermes://${session.id}`,
  };
}

export async function runHermesPipeline(options: {
  maxSessions?: number;
  dryRun?: boolean;
  sessionIds?: string[];
} = {}): Promise<HermesPipelineResult> {
  const { maxSessions = 5, dryRun = false, sessionIds } = options;

  const scanResult = await scanHermesSessions();

  let targetSessions;
  if (sessionIds && sessionIds.length > 0) {
    // 2026-09-15 f-002 复核实测缺陷: 原写法 `(s as any).sessionId` —— HermesSession 暴露的是 `id`
    // (scanner.ts:15-23), `sessionId` 恒为 undefined, 于是 pipeline.runHermes 传 sessionIds 时
    // `filter` 恒为空 -> 一个 session 都不处理, 且静默返回 processed=0(调用方无法区分"没命中"与"没传入")。
    // 该静默 no-op 使 f-002 的定位复跑(sessionIds=['20260728_195048_baef32'])无法验证, 一并修正。
    targetSessions = scanResult.allSessions.filter((s) => sessionIds.includes(s.id));
  } else {
    const candidates = [...scanResult.newSessions, ...scanResult.updatedSessions];
    targetSessions = candidates.slice(0, maxSessions);
  }

  const result: HermesPipelineResult = {
    processed: 0,
    errors: [],
    summary: [],
  };

  for (const session of targetSessions) {
    try {
      const messages = await getHermesMessages(session.id);
      if (messages.length < 2) {
        await markSessionProcessed(session.id, session.messageCount, prisma);
        continue;
      }

      const conversation = hermesToParsedConversation(session, messages);
      const extracted = await extractCognitiveData(conversation);

      if (dryRun) {
        result.processed++;
        result.summary.push({
          sessionId: session.id,
          title: session.title || extracted.summary || "无标题",
          stats: {
            memoriesCreated: extracted.memories.length,
            knowledgeCreated: extracted.knowledge.length,
            reflectionsCreated: extracted.reflections.length,
            practicesCreated: extracted.practices.length,
            skillsCreated: extracted.skills.length,
            flywheelEventsCreated: 0,
          },
        });
        continue;
      }

      const writeResult = await writeToDatabase(conversation, extracted, {
        sourceType: "PIPELINE_HERMES", // 2026-06-06 SHARED-BRAIN-V2: 区分 pipeline 来源
        runMode: "HERMES_PIPELINE",
      });

      await markSessionProcessed(session.id, session.messageCount, prisma);

      result.processed++;
      result.summary.push({
        sessionId: session.id,
        title: conversation.title || extracted.summary || "无标题",
        stats: writeResult.stats,
      });
    } catch (err) {
      result.errors.push(`${session.id}: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  // P2 修复 2026-08-28: 删除 prisma.$disconnect()
  // runHermesPipeline 被 tRPC pipeline.run / auto-rotation 调用 (Next.js 服务进程内),
  // disconnect 全局共享 PrismaClient 会让后续调用报 "Engine is not yet connected"。
  // 进程退出时连接自动清理。
  return result;
}