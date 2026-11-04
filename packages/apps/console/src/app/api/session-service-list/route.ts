import { sessionApiKey } from "@/lib/secret";
import { NextRequest, NextResponse } from "next/server";
import { openSession, scalar, safeClose } from "@/lib/server/lions-db";

/**
 * Session 服务 list proxy
 * 直接调用 session 服务 :3002 (避开 mind sessionRegistry)
 * 用 ?agentId= 过滤
 *
 * P0 [todo_zowi9ayu1m2kkuyw] 2026-09-15 修复: session 浏览器只显示 100 条无 total 无排序
 *   - 新增: total (从本地 session DB COUNT(*) 拿真值, 不再写死 = items.length)
 *   - 新增: sortBy=last_message_at 时, 客户端按 lastMessageAt desc 重排 (session 服务硬编码 updatedAt desc, 没法直接调)
 *   - 新增: limit 透传 (前端 cursor 翻页用, 服务 max 500)
 */
export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get("agentId") || "";
  const limit = req.nextUrl.searchParams.get("limit") || "50";
  const cursor = req.nextUrl.searchParams.get("cursor") || "";
  const sortBy = req.nextUrl.searchParams.get("sortBy") || "last_message_at";

  const params = new URLSearchParams({ limit });
  if (agentId) params.set("agentId", agentId);
  if (cursor) params.set("cursor", cursor);
  // 2026-09-16: 默认排除自动生成的任务执行记录(platform=task-exec, 2353 条), 避免刷屏;
  //   这些记录仍在 session 服务里可查(?excludePlatform= 或会话归档页按来源过滤)。
  params.set("excludePlatform", "task-exec");

  try {
    const res = await fetch(
      `http://localhost:3002/api/v1/sessions?${params.toString()}`,
      {
        headers: { "X-API-Key": sessionApiKey(/* SESSION_SERVICE_API_KEY */) },
      }
    );

    if (!res.ok) {
      return NextResponse.json(
        { error: `session 服务 HTTP ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();

    // 转成 mind sessionRegistry 兼容格式 (前端可无缝切换)
    let items = (data.items || []).map((s: any) => ({
      id: s.sessionUid,
      sourceId: s.sessionUid,
      agentId: s.agentId,
      source: s.source,
      title: s.title,
      startedAt: s.startedAt,
      lastMessageAt: s.lastMessageAt,
      messageCount: s.messageCount,
      status: s.status || "ACTIVE",
    }));

    // 客户端按 last_message_at desc 重排 (待办要求排序; session 服务硬编码 updatedAt desc)
    //   - 无 cursor (首页) 时: 排整页
    //   - 有 cursor: items 来自服务端单页, 重排后倒序不破坏分页语义 (cursor 是 updatedAt base64,
    //     但前端请求是无 cursor/有 cursor 顺序加载, 用户期望按活动时间 desc 看)
    if (sortBy === "last_message_at") {
      items.sort((a: any, b: any) => {
        const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
        const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
        return tb - ta;
      });
    }

    // 总数真值: 从本地 session DB 拿 COUNT (库在主库, 只读)
    //   - 带 agentId 过滤时, total 也按 agentId 算, 与 items 一致 (避免前端显示"已加载 100 / 总 100"假象)
    //   - 库/表不可用时退化 = items.length (跟改前一样, 不挂前端)
    let total = items.length;
    const db = openSession();
    try {
      if (db) {
        const params: any[] = [];
        let where = "sessionUid IS NOT NULL";
        if (agentId) {
          where += " AND agentId = ?";
          params.push(agentId);
        }
        total = await scalar(
          db,
          `SELECT COUNT(*) AS total FROM Session WHERE ${where}`,
          ...params
        );
      }
    } finally {
      safeClose(db);
    }

    return NextResponse.json({
      items,
      nextCursor: data.nextCursor,
      total,
      limit: Number(limit),
      sortBy,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: `session 服务连接失败: ${e.message}` },
      { status: 503 }
    );
  }
}