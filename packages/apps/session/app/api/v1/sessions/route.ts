/**
 * GET /api/v1/sessions — V1 §15.2.1 HTTP contract for mind puller
 *
 * 让 mind 走 HTTP 拉 session 列表 (不再本地存 SessionRegistry 原文)
 *
 * Query:
 *   since=<iso>           只返回 updatedAt > since 的
 *   status=PENDING        筛 extractStatus
 *   agentId=<id>          筛 agentId
 *   limit=100             默认 100, 最大 500
 *   cursor=<id>           分页游标 (上一页 nextCursor)
 *
 * Response 200:
 *   {
 *     items: SessionSummary[],
 *     nextCursor: string | null,
 *     watermark: string  // 当前批次最新的 updatedAt
 *   }
 *
 * 鉴权: X-API-Key — 双轨 (2026-09-02):
 *   ① 固定 key 白名单 (LIONS_UPLOAD_API_KEYS, 默认 lions-session-dev-key) — mind puller, 跨 agent
 *   ② sk-mind-* agent key (查 mind AgentServicePermission) — agent 自读, 结果限定为本人数据
 *
 * 错误:
 *   401 — api key 缺失或无效
 *   422 — 参数非法
 *   503 — DB 不可用
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeApiKey, canReadAll } from "@/lib/routeAuth";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

export async function GET(req: Request) {
  // 1. auth — 双轨: 白名单 key (跨 agent) / sk-mind-* agent key (只读本人)
  const auth = await authorizeApiKey(req.headers.get("x-api-key"));
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const since = url.searchParams.get("since");
    const status = url.searchParams.get("status");
    const agentId = url.searchParams.get("agentId");
    const cursor = url.searchParams.get("cursor");
    const limitRaw = url.searchParams.get("limit");

    let limit = DEFAULT_LIMIT;
    if (limitRaw) {
      const n = parseInt(limitRaw, 10);
      if (isNaN(n) || n < 1) {
        return NextResponse.json(
          { success: false, error: "limit 必须是正整数" },
          { status: 422 }
        );
      }
      limit = Math.min(n, MAX_LIMIT);
    }

    const where: Record<string, unknown> = {
      sessionUid: { not: null },
    };
    // 2026-09-16: 平台过滤 — ?platform=macs 只看某来源; ?excludePlatform=task-exec 排除自动生成记录
    const platform = url.searchParams.get("platform");
    const excludePlatform = url.searchParams.get("excludePlatform");
    if (platform) where.platform = platform;
    if (excludePlatform) where.platform = { not: excludePlatform };
    if (since) {
      const d = new Date(since);
      if (isNaN(d.getTime())) {
        return NextResponse.json(
          { success: false, error: "since 必须是 ISO 时间" },
          { status: 422 }
        );
      }
      where.updatedAt = { gt: d };
    }
    let retryCooldown: Date | null = null;
    if (status) {
      // PENDING includes NULL (never-processed) + explicit PENDING
      if (status === "PENDING") {
        where.OR = [{ extractStatus: "PENDING" }, { extractStatus: null }];
      } else if (status === "RETRYABLE") {
        // 2026-09-01 修复 NETWORK 死端: 瞬时错误(网络/限流/超时/服务端5xx) 的 FAILED 会话,
        //   冷却期(15min)后重新进入扫描队列, 避免 API 抖动导致数据永久丢失。
        //   状态机 FAILED→PROCESSING 本就允许重试, 缺的只是让 scan 能再次拉到它。
        retryCooldown = new Date(Date.now() - 15 * 60 * 1000);
        // 瞬时错误关键词匹配 (兼容两种落库形式: 分类类型 "NETWORK" 或原始消息
        //   "Minimax API fetch failed: fetch failed"), SQLite LIKE 默认大小写不敏感
        // Prisma 标量过滤器不支持 OR, 必须把条件提到 where 顶层合并
        where.extractStatus = "FAILED";
        where.OR = [
          { extractError: { contains: "NETWORK" } },
          { extractError: { contains: "fetch failed" } },
          { extractError: { contains: "RATE_LIMIT" } },
          { extractError: { contains: "429" } },
          { extractError: { contains: "SERVER_ERROR" } },
          { extractError: { contains: "TIMEOUT" } },
          { extractError: { contains: "ABORTED" } },
        ];
        // 瞬时错误冷却后再试 (updatedAt = 上次失败时间, 由 PATCH status 更新)
        // 注意: updatedAt 下界在 cursor 分支统一合并, 避免覆盖
      } else {
        where.extractStatus = status;
      }
    }
    // Only return sessions with actual messages (skip metadata-only syncs)
    const minMessages = url.searchParams.get("minMessages");
    if (minMessages) {
      const n = parseInt(minMessages, 10);
      if (!isNaN(n) && n > 0) {
        where.messageCount = { gte: n };
      }
    }
    // ② sk-mind-* agent key: 默认只读本人; lions_session perm 含 read:all (管理员授权) 时可跨 agent 读
    if (auth.via === "mind") {
      const readAll = canReadAll(auth);
      if (agentId) {
        if (readAll || agentId === auth.agentId) {
          where.agentId = agentId;
        } else {
          return NextResponse.json(
            { success: false, error: `agent key 只能读取本人 (agentId=${auth.agentId}), 需 read:all 授权才能查他 agent` },
            { status: 403 }
          );
        }
      } else if (!readAll) {
        where.agentId = auth.agentId;
      }
      // readAll 且未指定 agentId → 不设过滤 (查全部)
    } else if (agentId) {
      where.agentId = agentId;
    }
    // B15 (2026-07-02): source 过滤 — 让 mind 定向拉某 channel, 避免老坑堵队
    const source = url.searchParams.get("source");
    if (source) where.source = source;
    if (cursor || retryCooldown) {
      // cursor = base64(updatedAt iso), DESC 排序时用 updatedAt < cursor 往前翻
      const ltBounds: Date[] = [];
      const gtBounds: Date[] = [];
      if (cursor) {
        let decoded = cursor;
        try {
          decoded = Buffer.from(cursor, "base64").toString("utf8");
        } catch {
          // 不是 base64, 当原文用
        }
        // DESC 排序: cursor 之前的 (更旧的), 如果有 since 则同时保持 > since
        const cursorDate = new Date(decoded);
        if (!isNaN(cursorDate.getTime())) ltBounds.push(cursorDate);
      }
      if (since) gtBounds.push(new Date(since));
      if (retryCooldown) ltBounds.push(retryCooldown);
      // 合并上下界: updatedAt > max(gt), updatedAt < min(lt)
      const cond: Record<string, unknown> = {};
      if (gtBounds.length > 0) cond.gt = new Date(Math.max(...gtBounds.map(d => d.getTime())));
      if (ltBounds.length > 0) cond.lt = new Date(Math.min(...ltBounds.map(d => d.getTime())));
      where.updatedAt = cond;
    }

    const rows = await prisma.session.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1, // 多取一条判断 nextCursor
      select: {
        id: true,
        sessionUid: true,
        agentId: true,
        source: true,
        // 2026-09-24 补(agent-i 上报): 列表此前不回显 sourceId, 调用方看到的是 None,
        //   无法核对"重传是否会覆盖而非新建"。sourceId 是 upload 的必填项且**已落库**
        //   (实测 agent-i 224 条里 217 条有值), upsert 键 sessionUid = agentId:source:sourceId,
        //   即重传本就按 sourceId 覆盖 —— 但接口不返回, 这个保证就无法被外部验证。
        sourceId: true,
        title: true,
        startedAt: true,
        updatedAt: true,
        lastMessageAt: true,
        messageCount: true,
        extractStatus: true,
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && items.length > 0
        ? Buffer.from(items[items.length - 1].updatedAt.toISOString()).toString("base64")
        : null;
    const watermark =
      items.length > 0
        ? items[items.length - 1].updatedAt.toISOString()
        : new Date(0).toISOString();

    return NextResponse.json({
      items: items.map((r: typeof items[number]) => ({
        sessionUid: r.sessionUid,
        agentId: r.agentId,
        source: r.source,
        sourceId: r.sourceId,
        title: r.title,
        startedAt: r.startedAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
        lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
        messageCount: r.messageCount,
        status: r.extractStatus ?? "PENDING",
      })),
      nextCursor,
      watermark,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[GET /api/v1/sessions] error:", msg);
    return NextResponse.json(
      { success: false, error: "服务暂不可用", detail: msg },
      { status: 503 }
    );
  }
}
