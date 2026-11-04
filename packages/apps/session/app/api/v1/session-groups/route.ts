/**
 * GET /api/v1/session-groups — Scan SessionGroups
 *
 * Query:
 *   status=PENDING        筛 extractStatus (PENDING includes NULL)
 *   agentType=hermes      筛 agentType
 *   minSessions=3         最少 session 数
 *   limit=100             默认 100, 最大 500
 *   cursor=<id>           分页游标
 *   since=<ISO timestamp> 2026-07-13 修 §12.5 偏差 #1: 过滤 lastMessageAt >= since
 *                         (让 mind 端 getLatencyMetrics 拿 24h 窗口内的 SessionGroup)
 *
 * Response 200:
 *   { items: GroupSummary[], nextCursor: string|null }
 *
 * 鉴权: X-API-Key
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// D-13 (2026-09-07): 双轨鉴权 (whitelist + sk-mind key, 对齐 v1/sessions)
import { authorizeApiKey } from "@/lib/routeAuth";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export async function GET(req: Request) {
  const auth = await authorizeApiKey(req.headers.get("x-api-key"));
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
  }
  // 双轨: whitelist 可跨 agent; sk-mind key 限定自身 agentType (agentId 前缀 agent-{id}:)
  const agentIdScope = auth.ok && auth.via === "mind" ? auth.agentId : null;

  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const agentType = url.searchParams.get("agentType");
    const minSessionsRaw = url.searchParams.get("minSessions");
    const cursor = url.searchParams.get("cursor");
    const limitRaw = url.searchParams.get("limit");
    const sinceRaw = url.searchParams.get("since");

    let limit = DEFAULT_LIMIT;
    if (limitRaw) {
      const n = parseInt(limitRaw, 10);
      if (isNaN(n) || n < 1) {
        return NextResponse.json({ success: false, error: "limit 必须是正整数" }, { status: 422 });
      }
      limit = Math.min(n, MAX_LIMIT);
    }

    const where: Record<string, unknown> = {};
    if (status) {
      if (status === "PENDING") {
        where.OR = [{ extractStatus: "PENDING" }, { extractStatus: null }];
      } else {
        where.extractStatus = status;
      }
    }
    if (agentType) where.agentType = agentType;
    // sk-mind key: 只读自己 agent 的 group (经 member session 反查)
    if (agentIdScope) where.members = { some: { session: { agentId: agentIdScope } } };
    if (minSessionsRaw) {
      const n = parseInt(minSessionsRaw, 10);
      if (!isNaN(n) && n > 0) where.sessionCount = { gte: n };
    }
    if (cursor) {
      let decoded = cursor;
      try { decoded = Buffer.from(cursor, "base64").toString("utf8"); } catch {
        // 非法 base64: 退回使用原始 cursor 文本(与修复前的行为一致, 不抛给调用方)
      }
      where.id = { gt: decoded };
    }
    // §12.5 主体评估偏差 #1 (2026-07-13): add since filter on lastMessageAt
    // 设计预期: 24h window 应只返回 24h 内活跃的 SessionGroup (按 lastMessageAt)
    // 注意: 用 lastMessageAt 而不是 extractedAt 是因为 SessionGroup 还在 PENDING 时 lastMessageAt 一直更新
    if (sinceRaw) {
      const sinceDate = new Date(sinceRaw);
      if (!isNaN(sinceDate.getTime())) {
        // 跟现有 lastMessageAt desc 排序配合, 用 gte 即可
        where.lastMessageAt = { gte: sinceDate };
      }
    }

    const rows = await prisma.sessionGroup.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        groupKey: true,
        titleBase: true,
        agentType: true,
        cronJobId: true,
        workdir: true,
        sessionCount: true,
        messageCount: true,
        firstMessageAt: true,
        lastMessageAt: true,
        extractStatus: true,
        extractedAt: true,
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length > 0
      ? Buffer.from(items[items.length - 1].id).toString("base64")
      : null;

    return NextResponse.json({ success: true, items, nextCursor });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}
