/**
 * GET /api/v1/sessions/:sessionUid — V1 §15.2.1 HTTP contract
 *
 * 返回 session 详情 + 全部 messages (mind puller 拉原文用)
 *
 * Response 200:
 *   {
 *     session: SessionDetail,
 *     messages: Message[]
 *   }
 *
 * 错误:
 *   401 — api key 缺失或无效
 *   404 — sessionUid 不存在
 *   503 — DB 不可用
 *
 * PATCH /api/v1/sessions/:sessionUid/status — 由 ./status/route.ts 实现
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authorizeApiKey, canReadAll } from "@/lib/routeAuth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionUid: string }> }
) {
  // auth — 双轨: 白名单 key (跨 agent) / sk-mind-* agent key (只读本人)
  const auth = await authorizeApiKey(req.headers.get("x-api-key"));
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
  }

  try {
    const { sessionUid } = await params;
    if (!sessionUid) {
      return NextResponse.json(
        { success: false, error: "sessionUid 必填" },
        { status: 422 }
      );
    }

    // 2026-09-10 遗留#11 修复: maxMessages 之前被忽略 -> 大会话整包(实测 9401 条/10.8MB)回传,
    //   反思侧只能靠 chunk 预算截断(truncatedChunks 增大, 成本虚高)。现支持尾部截取:
    //   maxMessages=N -> 取最近 N 条(保持时间正序返回), 并回传 totalMessages/messagesTruncated 供消费方审计。
    const { searchParams } = new URL(req.url);
    const maxMessages = Math.max(0, parseInt(searchParams.get("maxMessages") || "0", 10) || 0);
    const msgSelect = {
      id: true,
      role: true,
      content: true,
      timestamp: true,
      model: true,
      reasoning: true,
    } as const;

    const session = await prisma.session.findUnique({ where: { sessionUid } });
    // 2026-10-14: content 改为 string | null —— 与 schema 的真实语义对齐 (prisma/schema.prisma
    //   `model Message { content String? }`), 之前声明成 string 才是错的一边 (TS2322)。
    //   运行期不变: 类型擦除后原样返回 DB 值, 库里有 NULL 时本就在返回 null;
    //   下游 console 会话详情页已按可空处理 (sessions/detail/page.tsx: `m.content || "(空消息)"`,
    //   InspectorPanel.tsx: `(m.content || "").length`)。
    let messages: Array<{ id: string; role: string; content: string | null; timestamp: Date; model: string | null; reasoning: string | null }> = [];
    if (session) {
      messages = maxMessages > 0
        ? (await prisma.message.findMany({
            where: { sessionId: session.id },
            orderBy: { timestamp: "desc" },
            take: maxMessages,
            select: msgSelect,
          })).reverse()
        : await prisma.message.findMany({
            where: { sessionId: session.id },
            orderBy: { timestamp: "asc" },
            select: msgSelect,
          });
    }

    if (!session) {
      return NextResponse.json(
        { success: false, error: `session ${sessionUid} 不存在` },
        { status: 404 }
      );
    }

    // ② sk-mind-* agent key: 只能读本人会话; lions_session perm 含 read:all 时可读他人
    if (auth.via === "mind" && session.agentId !== auth.agentId && !canReadAll(auth)) {
      return NextResponse.json(
        { success: false, error: `agent key 只能读取本人 (agentId=${auth.agentId}), 需 read:all 授权` },
        { status: 403 }
      );
    }

    return NextResponse.json({
      session: {
        sessionUid: session.sessionUid,
        agentId: session.agentId,
        source: session.source,
        sourceId: session.sourceId,
        title: session.title,
        startedAt: session.startedAt?.toISOString() ?? null,
        lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
        updatedAt: session.updatedAt.toISOString(),
        messageCount: session.messageCount,
        status: session.extractStatus ?? "PENDING",
        model: session.model,
        platform: session.platform,
      },
      totalMessages: session.messageCount,
      messagesTruncated: maxMessages > 0 && messages.length < (session.messageCount ?? messages.length),
      messages: messages.map((m) => ({
        messageUid: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.timestamp.toISOString(),
        model: m.model,
        reasoning: m.reasoning,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[GET /api/v1/sessions/:uid] error:", msg);
    return NextResponse.json(
      { success: false, error: "服务暂不可用", detail: msg },
      { status: 503 }
    );
  }
}
