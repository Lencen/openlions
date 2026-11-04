import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson, safeStatus } from "@/lib/server/proxy-fetch";
import { asOf, openSession, q, one } from "@/lib/server/lions-db";

/**
 * /api/session-list —— 会话中心列表
 *
 * 2026-10-26 修复（前端线报「默认排序不可用 / 第 1 页全是两三个月前」）：
 *   真因不是排序，是**数据源过期**。原实现透传 mind `sessionRegistry.list`，读的是
 *   `lions_mind."SessionRegistry"`；这张表在全仓已**没有任何 create 写入点**
 *   （只有 session-source-loader 的 update，注释明写"本地无该镜像行则静默跳过"），
 *   实测 4,429 行全部停在 2026-08-28，按月分布 2026-07:4,428 / 2026-08:1。
 *   而活会话在 `lions_session."Session"`：23,763 行，最新 updatedAt 当天仍在写。
 *   => 排序本身是对的（mind 默认就是 updated_at DESC），换成任何排序都救不了空数据。
 *
 * 因此本接口直接读**活库**（console 只读层早已导出 SESSION_DB / openSession）。
 *
 * 同时补上前端指出的**分页稳定性**缺陷（这一条是真的）：
 *   `ORDER BY "updatedAt" DESC, "sessionUid" ASC` —— 单一键在并列值上翻页会重复/漏行。
 *   `sessionUid` 实测唯一（23,763/23,763），是合格的稳定第二键。
 *
 * 容错（本文件所在只读层的第一条约束）：活库不可用（库/表缺失、连接失败）时
 *   自动回退到原 tRPC 路径，页面不 500、只是数据仍旧。
 * 响应结构保持不变：{result:{data:{items,total,limit,offset}}, asOf}
 *   —— 7 个消费者读 result.data.*，字段名与顺序与原 tRPC item 完全一致。
 */

// 与 mind sessionRegistry.list 的 item 字段一一对应（前端已按这些键渲染）
const FIELDS = `
  id,
  "sessionUid"    AS session_uid,
  "agentId"       AS agent_id,
  source,
  "sourceId"      AS source_id,
  title,
  "startedAt"     AS started_at,
  "endedAt"       AS ended_at,
  "lastMessageAt" AS last_message_at,
  "messageCount"  AS message_count,
  COALESCE(NULLIF("extractStatus", ''), 'PENDING') AS status,
  "extractedAt"   AS processed_at,
  "extractError"  AS processing_error,
  NULL::text      AS fingerprint,
  0               AS payload_size,
  "createdAt"     AS uploaded_at,
  "updatedAt"     AS updated_at`;

// 稳定排序：主键与并列值时都不重复/不漏行（前端 2026-10-26 明确要求第二键）
const ORDER = `ORDER BY "updatedAt" DESC, "sessionUid" ASC`;

async function liveList(page: number, pageSize: number, agentId: string) {
  const db = openSession();
  if (!db) return null;
  const offset = (page - 1) * pageSize;
  const items = agentId
    ? await q(db, `SELECT ${FIELDS} FROM "Session" WHERE "agentId" = $1 ${ORDER} LIMIT $2 OFFSET $3`, agentId, pageSize, offset)
    : await q(db, `SELECT ${FIELDS} FROM "Session" ${ORDER} LIMIT $1 OFFSET $2`, pageSize, offset);
  const tot = agentId
    ? await one(db, `SELECT COUNT(*)::int AS c FROM "Session" WHERE "agentId" = $1`, agentId)
    : await one(db, `SELECT COUNT(*)::int AS c FROM "Session"`);
  const total = Number((tot && (tot.c ?? Object.values(tot)[0])) || 0);
  // total=0 既可能是"活库不可用"也可能是"真的空"，但这张表实测 23,763 行 ——
  //   为 0 视为不可用，交给上层回退（宁可数据旧，也不要给前端一个空列表 + 假 asOf）。
  if (total === 0 && items.length === 0) return null;
  return { items, total, limit: pageSize, offset };
}

export async function GET(req: NextRequest) {
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page")) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.nextUrl.searchParams.get("pageSize")) || 10));
  const agentId = (req.nextUrl.searchParams.get("agent_id") || "").trim();

  // ① 优先活库
  const live = await liveList(page, pageSize, agentId).catch(() => null);
  if (live) {
    // 2026-10-26 修「靠推断判断数据源」：原来只有回退路径带 `source`，活库路径什么都不带，
    //   于是"字段缺失"被当成"走活库"——那是代码约定，不是响应证据。两条路径现在都**显式**给 source。
    return new NextResponse(
      JSON.stringify({ result: { data: live }, asOf: asOf(), source: "live:session-list" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // ② 回退：原 tRPC 透传（数据可能是旧的，但接口不塌）
  const inputObj: Record<string, unknown> = { limit: pageSize, offset: (page - 1) * pageSize };
  if (agentId) inputObj.agent_id = agentId;
  const input = encodeURIComponent(JSON.stringify(inputObj));
  const r = await safeFetchJson(`http://localhost:3000/api/trpc/sessionRegistry.list?input=${input}`);
  const data = r.ok && r.data !== null && r.data !== undefined ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : null;
  let body = data;
  if (typeof body === "string" && body.trim().startsWith("{")) {
    try { body = JSON.stringify({ ...JSON.parse(body), asOf: asOf(), source: "fallback:mind-session-registry" }); } catch { /* 原样 */ }
  }
  return new NextResponse(body, { status: safeStatus(r.status), headers: { "Content-Type": "application/json" } });
}
