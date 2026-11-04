/**
 * context-queried-event.ts — 检索入口的 CONTEXT_QUERIED 事件（2026-10-20，需求单
 *   docs/practices/2026-10-20-requirement-context-queried-event.md）
 *
 * 只做三件事：解析身份、去噪、fire-and-forget 写一条 FlywheelEvent。
 *   · 身份：body.agentId -> x-agent-id -> "unknown"（拿不到不 4xx）；
 *   · 去噪：同 agent+type+query 5 分钟内 1 条；每进程每分钟上限 200；空结果 1/10 采样；
 *   · 失败非致命：void + catch，绝不 await 在主路径，也不影响检索响应。
 *
 * 零 schema 变更：sourceId/sourceTitle 是必填 String，拿不到时用 ""（需求单里的 null 由该列约束改写）。
 * 事件写走 @/lib/prisma（mind 的 owner 连接 = 唯一 writer），不新开连接、不 checkpoint。
 */
import { prisma } from "@/lib/prisma";

const DEDUP_MS = 5 * 60 * 1000;
const PER_MINUTE_CAP = 200;
const EMPTY_SAMPLE_EVERY = 10;

const lastSeen = new Map<string, number>();
let minuteBucket = 0;
let minuteCount = 0;
let emptyCounter = 0;
let droppedOverCap = 0;

export function resolveAgentId(req: Request, body?: any): string {
  const fromBody = body && typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (fromBody) return fromBody;
  const fromHeader = (req.headers.get("x-agent-id") || "").trim();
  if (fromHeader) return fromHeader;
  return "unknown";
}

export interface ContextQueriedInput {
  agentId?: string | null;
  query?: string | null;
  targetType: "MEMORY" | "KNOWLEDGE";
  hits: number;
  firstHitId?: string | null;
  taskId?: string | null;
}

export function recordContextQueried(input: ContextQueriedInput): void {
  try {
    const agentId = (input.agentId || "unknown").trim() || "unknown";
    const query = String(input.query || "").slice(0, 120);
    const hits = Math.max(0, Number(input.hits) || 0);
    const now = Date.now();
    const key = agentId + "|" + input.targetType + "|" + query;

    const prev = lastSeen.get(key);
    if (prev && now - prev < DEDUP_MS) return;

    const bucket = Math.floor(now / 60000);
    if (bucket !== minuteBucket) { minuteBucket = bucket; minuteCount = 0; }
    if (minuteCount >= PER_MINUTE_CAP) { droppedOverCap++; return; }

    if (hits === 0) {
      emptyCounter++;
      if (emptyCounter % EMPTY_SAMPLE_EVERY !== 0) return;
    }

    minuteCount++;
    lastSeen.set(key, now);
    if (lastSeen.size > 5000) {
      for (const [k, t] of lastSeen) if (now - t > DEDUP_MS) lastSeen.delete(k);
    }

    void prisma.flywheelEvent.create({
      data: {
        stage: "CONTEXT_QUERIED",
        sourceType: "agent:" + agentId,
        sourceId: input.firstHitId || "",
        sourceTitle: query,
        targetStage: "hits=" + hits,
        targetType: input.targetType,
        targetId: null,
        taskId: input.taskId || null,
      },
    }).catch((e: any) =>
      console.warn("[context-queried] 写入失败(非致命): " + String(e?.message || "").slice(0, 100)),
    );
  } catch (e: any) {
    console.warn("[context-queried] 记录失败(非致命): " + String(e?.message || "").slice(0, 100));
  }
}

export function contextQueriedStats(): { droppedOverCap: number } {
  return { droppedOverCap };
}
