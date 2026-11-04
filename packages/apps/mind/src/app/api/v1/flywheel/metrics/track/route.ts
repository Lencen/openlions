/**
 * V1.8 业务指标真实埋点 - POST /api/v1/flywheel/metrics/track
 *
 * 客户端 (Hermes Agent 等) 调用此接口记录真实指标事件:
 *   { event: "question_asked", theme: "任务调度", contentHash: "abc123" }
 *   { event: "answer_feedback", theme: "任务调度", positive: true }
 *   { event: "context_missing", theme: "任务调度", missingItems: ["skill_X"] }
 *   { event: "preference_applied", preference: "concise_response", source: "auto" }
 *
 * 数据存入 MetricEvent 表 (raw SQL 创建, 无需 Prisma migration)
 */
import { prisma } from "@/lib/prisma";

// 建表 (幂等)
const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS MetricEvent (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  theme TEXT,
  contentHash TEXT,
  positive INTEGER,
  missingItems TEXT,
  preference TEXT,
  source TEXT,
  metadata TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_metric_event_type ON MetricEvent(event);
CREATE INDEX IF NOT EXISTS idx_metric_event_created ON MetricEvent(createdAt);
`;

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(CREATE_TABLE);
  tableReady = true;
}

export async function POST(req: Request) {
  try {
    await ensureTable();
    const body = await req.json();
    const { event, theme, contentHash, positive, missingItems, preference, source, metadata } = body;

    if (!event) {
      return Response.json({ error: "event 必填" }, { status: 400 });
    }

    const id = `me_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO MetricEvent (id, event, theme, contentHash, positive, missingItems, preference, source, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, event, theme || null, contentHash || null,
      positive ? 1 : (positive === false ? 0 : null),
      missingItems ? JSON.stringify(missingItems) : null,
      preference || null, source || null,
      metadata ? JSON.stringify(metadata) : null
    );

    return Response.json({ ok: true, id });
  } catch (e: any) {
    console.error("[metrics-track]", e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
