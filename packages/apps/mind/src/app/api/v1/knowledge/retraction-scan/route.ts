import { openMindDb } from "@/server/lib/open-mind-db";
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  buildScanTargets,
  scanSessionsForRetractions,
  type SqliteLikeDb,
} from "@/server/pipeline/knowledge-retraction";

/**
 * /api/v1/knowledge/retraction-scan — 已提炼会话的"后续显式推翻"自动扫描 (2026-09-15)
 *
 * 为什么需要: session-extract 有水位线, 同一会话后续出现的"我收回刚才那条结论"不会再被读到;
 *   被推翻的旧结论继续留在活性集合污染检索/注入。本路由绕过水位线重读原文做自动撤回。
 *
 * POST /api/v1/knowledge/retraction-scan
 *   Body: { days?: 14, limit?: 50, sessionUid?: "...", dry?: false, actor?: "session-extract" }
 * GET  -> 默认参数跑一次 dry-run(不改库), 便于巡检
 */
const MIND_DB = process.env.MIND_DB_PATH || path.join(process.cwd(), "prisma", "dev.db");
const SESSION_DB = process.env.LIONS_SESSION_DB || "" + (process.env.LIONS_HOME || process.cwd()) + "/packages/apps/session/prisma/dev.db";

async function openDbs(): Promise<{ mind: SqliteLikeDb; session: SqliteLikeDb }> {
  const mod: any = await import("better-sqlite3");
  const Database = mod.default ?? mod;
  const mind = openMindDb({ role: "direct-rw", dbPath: MIND_DB, caller: "route", busyTimeoutMs: 15000, fileMustExist: true }) as SqliteLikeDb & { pragma: (s: string) => void };

  const session = new Database(SESSION_DB, { readonly: true, fileMustExist: true }) as SqliteLikeDb & {
    pragma: (s: string) => void;
  };
  session.pragma("busy_timeout = 15000");
  return { mind, session };
}

async function run(opts: { days: number; limit: number; sessionUid: string | null; dry: boolean; actor: string }) {
  if (!fs.existsSync(SESSION_DB)) {
    return NextResponse.json({ ok: false, error: "SESSION_DB_NOT_FOUND", path: SESSION_DB }, { status: 503 });
  }
  const { mind, session } = await openDbs();
  try {
    const targets = buildScanTargets(mind, session, { days: opts.days, limit: opts.limit, sessionUid: opts.sessionUid });
    const result = scanSessionsForRetractions(mind, session, targets, { actor: opts.actor, dry: opts.dry });
    return NextResponse.json({ ok: true, dry: opts.dry, targets: targets.length, ...result });
  } finally {
    (mind as unknown as { close: () => void }).close();
    (session as unknown as { close: () => void }).close();
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  return run({
    days: Math.max(1, parseInt(searchParams.get("days") || "14", 10) || 14),
    limit: Math.max(1, parseInt(searchParams.get("limit") || "50", 10) || 50),
    sessionUid: searchParams.get("sessionUid") || null,
    dry: searchParams.get("dry") !== "0",
    actor: "session-extract",
  });
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* 允许空 body */
  }
  return run({
    days: Math.max(1, Number(body.days ?? 14) || 14),
    limit: Math.max(1, Number(body.limit ?? 50) || 50),
    sessionUid: body.sessionUid ? String(body.sessionUid) : null,
    dry: body.dry === true,
    actor: String(body.actor || "session-extract"),
  });
}
