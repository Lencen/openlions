import { openMindDb } from "@/server/lib/open-mind-db";
import { runtimeRepo } from "@/server/lib/runtime-repo";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import {
  CONSUMER_TABLE, TODO_CONSUMER_VERSION, consumerStates, ensureConsumerTable, recordHeartbeat,
  HEARTBEAT_FRESH_MS, OWNED_OPEN_TIMEOUT_MS, CONSUMERLESS_GRACE_MS,
} from "@/server/pipeline/todo-consumer";

export const dynamic = "force-dynamic";

/**
 * 待办消费者心跳 (2026-09-15)
 *
 * 背景: 「指派给一个活着但没有 todo_worker 的身份」的待办会静默死掉(实测 49 条/20.1h)。要能**在指派前**
 *   判断某身份有没有待办消费通道, 就必须有一个消费者自报在场的信号 —— 此前平台没有任何地方记录
 *   "谁在轮询待办"。本接口就是那个信号: todo_worker.py 每轮(起手 + 每次 poll)POST 一次。
 *
 *   POST /api/v1/flywheel/todos/consumer-heartbeat { agentId, host?, pid?, worker? }
 *   GET  /api/v1/flywheel/todos/consumer-heartbeat           -> { consumers:[...], consumerless:[...] }
 *
 * 判据(见 @/server/pipeline/todo-consumer): consumer := 心跳新鲜(<=30min) || 近 24h 有真实消费活动。
 * 本接口只写心跳; 指派闸门在 todos/route.ts, 超时释放/巡检在 scripts/todo-consumer-guard.cjs。
 */
const DB_PATH = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");

async function openDb() {

  const db = openMindDb({ role: "direct-rw", dbPath: DB_PATH, caller: "route" });

  return db;
}

export async function GET() {
  let db: any = null;
  try {
    db = await openDb();
    ensureConsumerTable(db);
    const all = await consumerStates(db);
    db.close();
    db = null;
    const consumers = all.filter((s) => s.active && s.consumer);
    const consumerless = all.filter((s) => s.active && !s.consumer);
    return NextResponse.json({
      ok: true, version: TODO_CONSUMER_VERSION, table: CONSUMER_TABLE,
      thresholds: { heartbeatFreshMinutes: HEARTBEAT_FRESH_MS / 60000, ownedOpenTimeoutMinutes: OWNED_OPEN_TIMEOUT_MS / 60000, consumerlessGraceMinutes: CONSUMERLESS_GRACE_MS / 60000 },
      consumers, consumerless, asOf: new Date().toISOString(),
    });
  } catch (e: any) {
    try { db?.close(); } catch {}
    return NextResponse.json({ ok: false, error: (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let b: any = {};
  try { b = await req.json(); } catch { return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 }); }
  const agentId = String(b.agentId || "").trim();
  if (!agentId) return NextResponse.json({ ok: false, error: "need agentId" }, { status: 400 });
  let db: any = null;
  try {
    db = await openDb();
    const r = await recordHeartbeat(db, {
      agentId,
      host: b.host != null ? String(b.host).slice(0, 120) : null,
      pid: b.pid != null ? Number(b.pid) : null,
      worker: b.worker != null ? String(b.worker).slice(0, 120) : "todo_worker",
    });
    const row: any = await runtimeRepo.get("SELECT * FROM " + CONSUMER_TABLE + " WHERE agent_id = ?", agentId);
    db.close();
    db = null;
    return NextResponse.json({ ok: true, consumer: { agentId: r.agentId, lastHeartbeatAt: Number(row.last_heartbeat_at), heartbeatCount: Number(row.heartbeat_count) }, asOf: new Date(r.at).toISOString() });
  } catch (e: any) {
    try { db?.close(); } catch {}
    return NextResponse.json({ ok: false, error: (e?.message || String(e)).slice(0, 300) }, { status: 500 });
  }
}
