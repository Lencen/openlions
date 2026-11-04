import { NextResponse } from "next/server";
import { safeFetchJson, safeStatus } from "@/lib/server/proxy-fetch";
import { asOf, openSession, q, scalar } from "@/lib/server/lions-db";

// 2026-10-26 修（frontend-line-2 实测：同一页两个「会话总数」差 19,363）：
//   `GET /api/session-stats` 透传 mind `sessionRegistry.stats`，读的是 `lions_mind."SessionRegistry"`
//   —— 这张表**自 2026-08 起就没有新数据**（全仓无 create 写入点），实测 4,429 行、最新 2026-08-28；
//   而同页 `GET /api/session-list` 读的是活库 `lions_session."Session"`（23,700+ 行、当天仍在写）。
//   于是页面出现 total=4429(死库) 与 total=23792(活库) 并存，「已提炼 1,438」也是拿死库算的。
//
//   本接口改为**与 session-list 同源同口径**：直接读活库。
//   - status 口径与 list 完全一致：COALESCE(NULLIF("extractStatus",''),'PENDING')
//     （活库不少行 extractStatus 为空，list 已把它们归为 PENDING；stats 必须用同一判据，
//       否则两个数字又会不一致 —— 这台机器上"口径不统一"已经在今天制造过多次误判）
//   - 活库无 `payload_size` 概念（那是旧注册表的原始 payload 体积）：totalSizeKb 恒为 0 并带说明，
//     不拿死库的值冒充，也不用假数字充数。
//   - 响应结构保持 {result:{data:{...}}, asOf}；活库不可用时回退原 tRPC 透传（页面不塌），
//     且回退时显式标 sourceOfTruth，别让人把旧数据当活数据。
export const dynamic = "force-dynamic";

const STATUS_EXPR = `COALESCE(NULLIF("extractStatus", ''), 'PENDING')`;

async function liveStats() {
  const db = openSession();
  if (!db) return null;
  const total = await scalar(db, `SELECT COUNT(*) FROM "Session"`);
  if (!total) return null;

  const statusRows = await q(db, `SELECT ${STATUS_EXPR} AS status, COUNT(*) AS cnt FROM "Session" GROUP BY 1`);
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[String(r.status)] = Number(r.cnt);

  const sourceRows = await q(
    db,
    `SELECT COALESCE(NULLIF(source, ''), 'unknown') AS source, COUNT(*) AS cnt FROM "Session" GROUP BY 1`
  );
  const bySource: Record<string, number> = {};
  for (const r of sourceRows) bySource[String(r.source)] = Number(r.cnt);

  const agentRows = await q(
    db,
    `SELECT COALESCE(NULLIF("agentId", ''), 'unknown') AS agent_id, COUNT(*) AS cnt FROM "Session" GROUP BY 1 ORDER BY cnt DESC`
  );

  const pending24h = await scalar(
    db,
    `SELECT COUNT(*) FROM "Session" WHERE ${STATUS_EXPR} = 'PENDING' AND "updatedAt" >= (now() - interval '24 hours')`
  );

  return {
    total,
    byStatus,
    bySource,
    byAgent: agentRows.map((r: any) => ({ agent_id: String(r.agent_id), count: Number(r.cnt) })),
    pending24h,
    totalSizeKb: 0,
    totalSizeKbNote: "活库会话表不含原始 payload 体积，本项不适用（旧值来自已停更的 SessionRegistry）",
    sourceOfTruth: "live:session-db",
  };
}

export async function GET() {
  const live = await liveStats().catch(() => null);
  if (live) {
    return new NextResponse(JSON.stringify({ result: { data: live }, asOf: asOf() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 回退：原 tRPC 透传（数据可能是旧注册表的，但接口不塌）
  const r = await safeFetchJson("http://localhost:3000/api/trpc/sessionRegistry.stats");
  const data = r.ok && r.data !== null && r.data !== undefined ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : null;
  let body = data;
  if (body && typeof body === "string" && body.trim().startsWith("{")) {
    try {
      body = JSON.stringify({ ...JSON.parse(body), asOf: asOf(), sourceOfTruth: "fallback:mind-session-registry" });
    } catch { body = data; }
  }
  return new NextResponse(body, { status: safeStatus(r.status), headers: { "Content-Type": "application/json" } });
}
