import { openMindDb } from "@/server/lib/open-mind-db";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import {
  retractKnowledge,
  resolveRetractTargets,
  type RetractParams,
  type SqliteLikeDb,
} from "@/server/pipeline/knowledge-retraction";

/**
 * /api/v1/knowledge/retract — 人工撤回入口 (2026-09-15, 待办 todo_c4869259208d4a748fb9)
 *
 * 背景: Knowledge 有 stale/staleReason/supersededBy 字段(通道), 但没有撤回入口(流程);
 *       实测只能人肉 UPDATE, 还写出一条悬空 supersededBy(cmu1cbbl8... -> cmu1enk0n..., 目标不存在)。
 *
 * GET  /api/v1/knowledge/retract?id=xxx          -> 精确看一行
 * GET  /api/v1/knowledge/retract?q=ingest&limit=20 -> 预览候选(含 stale 状态)
 * POST /api/v1/knowledge/retract
 *   Body: { id? | ids?: string[], query?, sourceId?, reason, actor, supersededBy?, markVerification?, dry? }
 *   200  -> { ok:true, retracted:[], skipped:[] }
 *   400  -> 参数缺失 / supersededBy 不存在(拒绝写悬空指针)
 */
const DB_PATH = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");

async function openDb(): Promise<SqliteLikeDb> {

  const db = openMindDb({ role: "direct-rw", dbPath: DB_PATH, caller: "route", busyTimeoutMs: 10000, fileMustExist: true }) as SqliteLikeDb & { pragma: (s: string) => void };

  return db;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") || "";
  const q = searchParams.get("q") || "";
  const sourceId = searchParams.get("sourceId") || "";
  const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10) || 20, 100);

  if (!id && !q && !sourceId) {
    return NextResponse.json({ ok: false, error: "需要 id / q / sourceId 之一" }, { status: 400 });
  }
  const db = await openDb();
  try {
    if (id) {
      const row = db
        .prepare(
          "SELECT id, title, content, confidence, sourceType, sourceId, stale, staleReason, supersededBy, supersededAt, verification, updatedAt FROM Knowledge WHERE id = ?"
        )
        .get(id);
      if (!row) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
      return NextResponse.json({ ok: true, knowledge: row });
    }
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (q) {
      clauses.push("(title LIKE ? OR content LIKE ?)");
      args.push(`%${q}%`, `%${q}%`);
    }
    if (sourceId) {
      clauses.push("sourceId = ?");
      args.push(sourceId);
    }
    const rows = db
      .prepare(
        `SELECT id, title, confidence, sourceType, sourceId, stale, staleReason, supersededBy, verification, createdAt
         FROM Knowledge WHERE ${clauses.join(" AND ")} ORDER BY createdAt DESC LIMIT ${limit}`
      )
      .all(...args);
    return NextResponse.json({ ok: true, total: rows.length, results: rows });
  } finally {
    (db as unknown as { close: () => void }).close();
  }
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }

  const ids: string[] = Array.isArray(body.ids) ? body.ids.map((x: unknown) => String(x)) : [];
  if (body.id) ids.push(String(body.id));
  const reason = String(body.reason || "").trim();
  const actor = String(body.actor || "").trim();
  if (!ids.length && !body.query && !body.sourceId) {
    return NextResponse.json({ ok: false, error: "需要 id/ids/query/sourceId 之一" }, { status: 400 });
  }
  if (!reason) return NextResponse.json({ ok: false, error: "reason 必填" }, { status: 400 });
  if (!actor) return NextResponse.json({ ok: false, error: "actor 必填(谁撤回的)" }, { status: 400 });

  const params: RetractParams = {
    ids,
    query: body.query ? String(body.query) : undefined,
    sourceId: body.sourceId ? String(body.sourceId) : undefined,
    reason,
    actor,
    actorType: body.actorType ? String(body.actorType) : "AGENT",
    supersededBy: body.supersededBy ? String(body.supersededBy) : null,
    markVerification: body.markVerification !== false,
    dry: body.dry === true,
  };

  const db = await openDb();
  try {
    const targets = resolveRetractTargets(db, params);
    if (!targets.length) return NextResponse.json({ ok: false, error: "NO_TARGETS" }, { status: 404 });
    const result = retractKnowledge(db, params);
    return NextResponse.json({ ok: true, targets: targets.map((t) => t.id), ...result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 400 });
  } finally {
    (db as unknown as { close: () => void }).close();
  }
}
