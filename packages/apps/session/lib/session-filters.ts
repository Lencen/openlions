// session-filters.ts — 统一过滤: 在 session/group 列表上隐藏自动化会话, 但保留真实对话 (含 agent-h 历史沟通)
// 设计原则: "在页面上过滤, 不显示" (不删数据, 不改写 sourceId)
// 排除 1: 0-消息会话 (hermes 启动即中断的空壳)
// 排除 2 (自动化/定时任务的标记, 2026-09-03 扩展):
//   a. sourceId 以 'cron:' 开头 (openclaw cron run 格式, 如 operator 的定时扫描)
//   b. sourceId 以 'cron_' / 'session_cron_' 开头 (hermes cron 格式)
//   c. 没有任何 role=user 消息的会话 (纯自动化产出: openclaw cron isolated 扫描 / hook / heartbeat)
//   d. 首条/任一条 user 消息是系统注入 (旧客户端未规范化前的老数据兜底):
//      '[cron:' / 'Task: Hook | Job ID:' / '[OpenClaw heartbeat' / '[IMPORTANT' / 'Continue the OpenClaw runtime event'
// 不排除: agent-h 历史对话 (1651 条真实沟通, 是好的飞轮养料)
// 2026-10-14: 类型必须取自本应用**自己的**生成客户端 (与 lib/prisma.ts 同一个)。
//   "@prisma/client" 在根 node_modules 里解析到的是 mind schema 生成的客户端,
//   其中没有 Session 模型 → Prisma.SessionWhereInput 不存在 (TS2694)。
//   仅换类型来源, 不涉及运行期 (import type 编译后完全擦除)。
import type { Prisma } from "../node_modules/.prisma/session-client";

// 给 list_sessions / overview / search 用
// 注: openclaw cron isolated / hook / heartbeat 会话经上传规范化后无任何 role=user 消息 → 被 c 排除;
//     '[cron:' 前缀是老客户端未规范化前的兜底 (独立 session 包装 cron, sourceId 是 UUID)
export const SESSION_EXCLUDE_FILTER: Prisma.SessionWhereInput = {
  AND: [
    { sourceId: { not: { startsWith: "cron:" } } },
    { sourceId: { not: { startsWith: "cron_" } } },
    { sourceId: { not: { startsWith: "session_cron_" } } },
    // 必须有至少一条 user 消息 (纯自动化产出无真实 user)
    { messages: { some: { role: "user" } } },
    { NOT: { messages: { some: { role: "user", content: { startsWith: "[cron:" } } } } },
  ],
  messageCount: { gt: 0 },
};

export function buildSessionWhere(userWhere: Prisma.SessionWhereInput = {}): Prisma.SessionWhereInput {
  return { AND: [userWhere, SESSION_EXCLUDE_FILTER] };
}

// group 列表页: 排除 messageCount=0 的空壳 group, 同时排除全部成员都是 cron 任务的 group
// 全部成员都是 cron 的判定: 存在 member 的 session 不满足 cron-utility 排除条件
// (NOT EXISTS 反向判断: 不存在"非 cron 成员"则全 cron)
export const GROUP_EXCLUDE_FILTER = {
  messageCount: { gt: 0 },
} as const;

export function buildGroupWhere(userWhere: Record<string, unknown> = {}): Record<string, unknown> {
  return { AND: [userWhere, GROUP_EXCLUDE_FILTER] };
}

// 找出"有至少一个非 cron 成员"的 group id 集合
// 业务逻辑:
//   - 全部成员都是 cron 的 group 不该显示 (699 个 ut-cron-group + 22 个 cron_ 前缀)
//   - 至少有一个真实对话成员的 group 应该显示
// 实现: 一次原始 SQL 查 groupId 集合 (Prisma 关系 NOT EXISTS 表达繁琐, 用 raw 更清晰)
//
// 用法: /groups 页面拿到 nonCronGroupIds 后, 把 group.id 不在 set 里的 group 过滤掉
import { prisma } from "./prisma";

export async function getNonCronGroupIds(): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`
    SELECT DISTINCT sg.id
    FROM SessionGroup sg
    JOIN SessionGroupMember sgm ON sgm.groupId = sg.id
    JOIN Session s ON s.id = sgm.sessionId
    WHERE sg.sessionCount > 0
      AND s.messageCount > 0
      AND (
        s.sourceId NOT LIKE 'cron:%'
        AND s.sourceId NOT LIKE 'cron\\_%' ESCAPE '\\'
        AND s.sourceId NOT LIKE 'session\\_cron\\_%' ESCAPE '\\'
        AND NOT EXISTS (
          SELECT 1 FROM Message m
          WHERE m.sessionId = s.id AND m.role = 'user' AND m.content LIKE '[cron:%'
        )
      )
  `);
  return new Set(rows.map((r) => r.id));
}