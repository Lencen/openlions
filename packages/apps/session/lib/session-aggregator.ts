/**
 * session-aggregator.ts — SessionGroup 归组逻辑
 *
 * 把碎片 session 按主题归组 (SESSION-AGGREGATION-LAYER §4)
 *
 * 聚合键优先级:
 *   P0: titleBase (从 title 去掉 #N 后缀)
 *   P0: cronJobId (如有, 与 titleBase 同级)
 *   P1: workdir (如有)
 *   P2: fallback → agentId:untitled
 */

import { prisma } from "./prisma";

// ─── 类型 ───

export interface GroupHint {
  groupKey: string;
  titleBase: string | null;
  agentType: string | null;
  cronJobId: string | null;
  workdir: string | null;
}

// ─── titleBase 提取 ───

/**
 * 从 session title 提取基础主题
 *
 * 规则:
 * 1. 去掉末尾 #N 后缀 (如 "lions V3 #3" → "lions V3")
 * 2. 去掉末尾 (N) 后缀 (如 "lions V3 (3)" → "lions V3")
 * 3. 去掉 cron 时间戳 (如 "cron-2026-06-29T10:00" → "cron")
 * 4. trim 空格
 * 5. null/空 → null
 */
export function extractTitleBase(title: string | null): string | null {
  if (!title || !title.trim()) return null;
  let base = title.trim();

  // 去掉 #N 后缀 (允许连续多个, 如 "topic #3 #4")
  base = base.replace(/(\s*#\d+\s*)+$/g, "").trim();

  // 去掉 (N) 后缀
  base = base.replace(/\s*\(\d+\)\s*$/g, "").trim();

  // 去掉 cron 时间戳后缀 (ISO 格式)
  base = base.replace(/\s*\d{4}-\d{2}-\d{2}T[\d:]+.*$/g, "").trim();

  // 去掉末尾日期 (如 "topic 2026-06-29")
  base = base.replace(/\s*\d{4}-\d{2}-\d{2}\s*$/g, "").trim();

  return base || null;
}

// ─── agentType 推断 ───

/**
 * 从 source / agentId 推断 agent 类型
 */
export function inferAgentType(source: string | null, agentId: string | null): string | null {
  if (agentId) {
    if (agentId.includes("claude")) return "claude";
    if (agentId.includes("codex")) return "codex";
    if (agentId.includes("opencode")) return "opencode";
    if (agentId.includes("openclaw")) return "openclaw";
    if (agentId.includes("agent-x") || agentId.includes("agent-x")) return "hermes";
    if (agentId.includes("agent-h")) return "hermes";
  }
  if (source) {
    if (source.includes("CLAUDE")) return "claude";
    if (source === "HERMES_SESSION") return "hermes";
    if (source === "mcp") return "mcp";
  }
  return null;
}

// ─── workdir 提取 (从 messages 里的 terminal tool call) ───

/**
 * 尝试从 session 的 message 内容中提取 workdir
 * Phase A 简化: 从前 10 条 message 的 content/toolInput 里找路径
 */
export function extractWorkdir(messages: Array<{ content?: string | null; toolInput?: string | null }>): string | null {
  for (const msg of messages.slice(0, 10)) {
    const text = msg.content || msg.toolInput || "";
    // 匹配 workdir 参数
    const m = text.match(/"workdir"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

// ─── 归组键计算 ───

/**
 * 计算 session 的归组键
 * 优先级: titleBase > cronJobId > workdir > fallback
 */
export function computeGroupKey(
  title: string | null,
  source: string | null,
  agentId: string | null,
  workdir: string | null,
): GroupHint {
  const titleBase = extractTitleBase(title);
  const agentType = inferAgentType(source, agentId);

  // P0: titleBase (最强信号)
  if (titleBase) {
    return {
      groupKey: titleBase,
      titleBase,
      agentType,
      cronJobId: null,
      workdir,
    };
  }

  // P1: workdir
  if (workdir) {
    return {
      groupKey: `workdir:${workdir}`,
      titleBase: null,
      agentType,
      cronJobId: null,
      workdir,
    };
  }

  // P2: fallback → agentId:untitled
  const fallback = `${agentId || agentType || "unknown"}:untitled`;
  return {
    groupKey: fallback,
    titleBase: null,
    agentType,
    cronJobId: null,
    workdir: null,
  };
}

// ─── 归组操作 ───

/**
 * 把单个 session 归入 SessionGroup (upsert group + create member)
 * 如果 session 已在某 group 里, 跳过
 */
export async function assignSessionToGroup(
  sessionId: string,
  hint: GroupHint,
): Promise<{ groupId: string; created: boolean }> {
  // 检查 session 是否已在某个 group
  const existing = await prisma.sessionGroupMember.findFirst({
    where: { sessionId },
    include: { group: true },
  });
  if (existing) {
    return { groupId: existing.groupId, created: false };
  }

  // upsert group
  const group = await prisma.sessionGroup.upsert({
    where: { groupKey: hint.groupKey },
    create: {
      groupKey: hint.groupKey,
      titleBase: hint.titleBase,
      agentType: hint.agentType,
      cronJobId: hint.cronJobId,
      workdir: hint.workdir,
      extractStatus: "PENDING",
    },
    update: {},  // 已存在不更新 (统计在 rebuildStats 里做)
  });

  // 计算 seq (当前组内最大 seq + 1)
  const maxSeqRow = await prisma.sessionGroupMember.findFirst({
    where: { groupId: group.id },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const seq = (maxSeqRow?.seq ?? -1) + 1;

  // create member
  await prisma.sessionGroupMember.create({
    data: {
      groupId: group.id,
      sessionId,
      seq,
    },
  });

  return { groupId: group.id, created: true };
}

// ─── 重建 group 统计 ───

/**
 * 重新计算 group 的聚合统计 (sessionCount, messageCount, first/lastMessageAt)
 */
export async function rebuildGroupStats(groupId: string): Promise<void> {
  const members = await prisma.sessionGroupMember.findMany({
    where: { groupId },
    include: {
      session: {
        select: {
          messageCount: true,
          startedAt: true,
          lastMessageAt: true,
        },
      },
    },
    orderBy: { seq: "asc" },
  });

  if (members.length === 0) {
    // 空 group, 删除
    await prisma.sessionGroup.delete({ where: { id: groupId } });
    return;
  }

  const sessionCount = members.length;
  const messageCount = members.reduce((sum, m) => sum + (m.session.messageCount || 0), 0);
  const timestamps = members
    .map((m) => m.session.lastMessageAt || m.session.startedAt)
    .filter(Boolean) as Date[];
  const firstMessageAt = members.length > 0 ? members[0].session.startedAt : null;
  const lastMessageAt = timestamps.length > 0
    ? timestamps.reduce((max, t) => (t > max ? t : max), timestamps[0])
    : null;

  await prisma.sessionGroup.update({
    where: { id: groupId },
    data: { sessionCount, messageCount, firstMessageAt, lastMessageAt },
  });
}

// ─── 批量归组 ───

/**
 * 遍历所有未归组的 session, 执行归组
 * 返回新建的 group 数和归组的 session 数
 */
export async function aggregateAllSessions(
  opts?: { limit?: number; agentId?: string },
): Promise<{ groupsCreated: number; sessionsAssigned: number; errors: string[] }> {
  const errors: string[] = [];
  let groupsCreated = 0;
  let sessionsAssigned = 0;

  // 找所有有 sessionUid 但未归组的 session
  const where: Record<string, unknown> = {
    sessionUid: { not: null },
    groupMembers: { none: {} },
  };
  if (opts?.agentId) where.agentId = opts.agentId;

  const sessions = await prisma.session.findMany({
    where,
    take: opts?.limit || 500,
    orderBy: { startedAt: "asc" },
    select: {
      id: true,
      title: true,
      source: true,
      agentId: true,
      startedAt: true,
      messages: {
        take: 10,
        select: { content: true, toolInput: true },
        orderBy: { timestamp: "asc" },
      },
    },
  });

  // 按 groupKey 批量处理
  const groupMap = new Map<string, string[]>();

  for (const s of sessions) {
    const workdir = extractWorkdir(s.messages);
    const hint = computeGroupKey(s.title, s.source, s.agentId, workdir);

    if (!groupMap.has(hint.groupKey)) {
      groupMap.set(hint.groupKey, []);
    }
    groupMap.get(hint.groupKey)!.push(s.id);
  }

  // 执行归组 (D-24 2026-09-07: 建 id→session 索引, 消除每 sessionId 一次 find 的 O(N²))
  const idMap = new Map<string, (typeof sessions)[number]>();
  for (const s of sessions) idMap.set(s.id, s);
  for (const [, sessionIds] of groupMap) {
    for (const sessionId of sessionIds) {
      try {
        const s = idMap.get(sessionId);
        if (!s) continue;
        const hint = computeGroupKey(
          s.title ?? null, s.source ?? null, s.agentId ?? null,
          null, // workdir 已在前面提取, 这里简化
        );
        const result = await assignSessionToGroup(sessionId, hint);
        if (result.created) sessionsAssigned++;
      } catch (e) {
        errors.push(`${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 重建所有涉及的 group 统计
  const affectedGroups = new Set<string>();
  for (const [, sessionIds] of groupMap) {
    for (const sessionId of sessionIds) {
      const member = await prisma.sessionGroupMember.findFirst({
        where: { sessionId },
        select: { groupId: true },
      });
      if (member) affectedGroups.add(member.groupId);
    }
  }
  for (const groupId of affectedGroups) {
    await rebuildGroupStats(groupId);
  }

  groupsCreated = await prisma.sessionGroup.count();

  return { groupsCreated, sessionsAssigned, errors };
}
