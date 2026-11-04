/**
 * GET /api/v1/session-groups/[groupKey] — Group detail with ordered messages
 *
 * 返回 group 元信息 + 全部 member session 的有序 messages
 * 供 mind pipeline global-organizer 拉取完整主题对话
 *
 * Query:
 *   maxMessages=5000     最多返回多少条 message (默认 5000, 防超大 group)
 *
 * Response 200:
 *   {
 *     group: { id, groupKey, titleBase, agentType, ... },
 *     sessions: [{ sessionId, title, startedAt, messageCount }],
 *     messages: [{ id, sessionId, role, content, toolName, timestamp, seq }]
 *   }
 *
 * 鉴权: X-API-Key
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// D-13 (2026-09-07): 双轨鉴权
import { authorizeApiKey } from "@/lib/routeAuth";

const DEFAULT_MAX_MESSAGES = 5000;

export async function GET(
  req: Request,
  { params }: { params: { groupKey: string } },
) {
  const auth = await authorizeApiKey(req.headers.get("x-api-key"));
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
  }
  const agentIdScope = auth.ok && auth.via === "mind" ? auth.agentId : null;

  try {
    const groupKey = decodeURIComponent(params.groupKey);
    const url = new URL(req.url);
    const maxMessagesRaw = url.searchParams.get("maxMessages");
    const maxMessages = maxMessagesRaw
      ? Math.min(parseInt(maxMessagesRaw, 10) || DEFAULT_MAX_MESSAGES, 50000)
      : DEFAULT_MAX_MESSAGES;

    // 1. 找 group
    const group = await prisma.sessionGroup.findUnique({
      where: { groupKey },
      include: {
        members: {
          orderBy: { seq: "asc" },
          select: {
            seq: true,
            session: {
              select: {
                id: true,
                sessionUid: true,
                title: true,
                agentId: true,
                source: true,
                startedAt: true,
                lastMessageAt: true,
                messageCount: true,
              },
            },
          },
        },
      },
    });

    if (!group) {
      return NextResponse.json({ success: false, error: `Group not found: ${groupKey}` }, { status: 404 });
    }
    // sk-mind key: 组内须含自己的 session, 否则 403 (数据隔离)
    if (agentIdScope && !group.members.some((m) => m.session.agentId === agentIdScope)) {
      return NextResponse.json({ success: false, error: "无权访问其他 agent 的 group" }, { status: 403 });
    }

    // 2. 按 member seq 顺序, 逐 session 拉 messages
    const sessionIds = group.members.map((m) => m.session.id);
    const sessions = group.members.map((m) => ({
      sessionId: m.session.id,
      sessionUid: m.session.sessionUid,
      title: m.session.title,
      agentId: m.session.agentId,
      source: m.session.source,
      startedAt: m.session.startedAt,
      lastMessageAt: m.session.lastMessageAt,
      messageCount: m.session.messageCount,
      seq: m.seq,
    }));

    // 按 member seq 顺序拉 messages (跨 session 有序)
    const allMessages: Array<{
      id: string; sessionId: string; role: string; content: string | null;
      model: string | null; toolCallId: string | null; toolName: string | null;
      toolCalls: string | null; toolInput: string | null; toolOutput: string | null;
      timestamp: Date; tokenCount: number | null; reasoning: string | null;
      _sessionSeq: number;
    }> = [];

    for (const m of group.members) {
      const msgs = await prisma.message.findMany({
        where: { sessionId: m.session.id },
        orderBy: { timestamp: "asc" },
        take: Math.ceil(maxMessages / group.members.length) + 50, // 均分上限
        select: {
          id: true, sessionId: true, role: true, content: true,
          model: true, toolCallId: true, toolName: true,
          toolCalls: true, toolInput: true, toolOutput: true,
          timestamp: true, tokenCount: true, reasoning: true,
        },
      });
      for (const msg of msgs) {
        allMessages.push({ ...msg, _sessionSeq: m.seq });
        if (allMessages.length >= maxMessages) break;
      }
      if (allMessages.length >= maxMessages) break;
    }

    // 已按 session seq + timestamp 有序
    const messages = allMessages.map(({ _sessionSeq, ...m }) => m);
    const truncated = allMessages.length >= maxMessages;

    return NextResponse.json({
      success: true,
      group: {
        id: group.id,
        groupKey: group.groupKey,
        titleBase: group.titleBase,
        agentType: group.agentType,
        cronJobId: group.cronJobId,
        workdir: group.workdir,
        sessionCount: group.sessionCount,
        messageCount: group.messageCount,
        firstMessageAt: group.firstMessageAt,
        lastMessageAt: group.lastMessageAt,
        extractStatus: group.extractStatus,
      },
      sessions,
      messages,
      truncated,
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}
