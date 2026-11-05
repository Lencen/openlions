/* eslint-disable @typescript-eslint/no-explicit-any, no-useless-escape */
// home-overview.ts —— 首页聚合一次查完（ord-20261104-046）
//
// 背景：首页原来发 8 条 Prisma 查询（5 聚合 + 3 findMany），每条都带
//   `sourceId::text NOT LIKE ...` 与 `id IN (SELECT sessionId FROM Message WHERE role='user')`，
//   EXPLAIN 实测每条 ~1.2s（Message 1.23M 行全扫 + 21k 次相关子查询），合计 8–12s。
//
// 这里改成一次 CTE 查询 + 60s 进程内缓存：
//   us  = 有 role=user 消息的 sessionId 集合（原 IN 子查询）
//   cs  = 有 user 消息且 content LIKE '[cron:%' 的 sessionId 集合（原 NOT IN 子查询）
//   base= 与原 SESSION_EXCLUDE_FILTER 等价的筛选结果
//   其余聚合（kpi/agents/status/sources/trend/hours/agent7d/recent）都在 SQL 里算，不再拉 2 万行进 Node。
// 口径等价：谓词逐条对应 SESSION_EXCLUDE_FILTER，未改任何统计含义。
import { prisma } from "./prisma";

export type Overview = {
  sessionCount: number;
  messageCount: number;
  byAgent: Array<{ agentId: string | null; _count: number }>;
  byStatus: Array<{ extractStatus: string | null; _count: number }>;
  recentSessions: Array<any>;
  trend: Array<{ date: string; sessions: number; messages: number }>;
  hourDist: number[];
  agent7d: Array<{ agentId: string; sessions: number; messages: number }>;
  sourceDist: Array<{ source: string; count: number }>;
};

const TTL_MS = 60_000;
let cache: { at: number; data: Overview } | null = null;

const SQL = `
WITH us AS MATERIALIZED (
  SELECT DISTINCT "sessionId" FROM "Message" WHERE "role" = 'user' AND "sessionId" IS NOT NULL
), cs AS MATERIALIZED (
  SELECT DISTINCT "sessionId" FROM "Message"
   WHERE "role" = 'user' AND "content"::text LIKE '[cron:%' AND "sessionId" IS NOT NULL
), base AS MATERIALIZED (
  SELECT s."id", s."title", s."agentId", s."agentName", s."source", s."channel",
         s."messageCount", s."lastMessageAt", s."extractStatus", s."startedAt"
  FROM "Session" s
  JOIN us ON us."sessionId" = s."id"
  WHERE s."sourceId"::text NOT LIKE 'cron:%'
    AND s."sourceId"::text NOT LIKE 'cron\_%'
    AND s."sourceId"::text NOT LIKE 'session\_cron\_%'
    AND s."messageCount" > 0
    AND NOT EXISTS (SELECT 1 FROM cs WHERE cs."sessionId" = s."id")
)
SELECT json_build_object(
  'kpi',      (SELECT count(*) FROM base),
  'messages', (SELECT count(*) FROM "Message"),
  'agents',   (SELECT json_agg(x) FROM (SELECT "agentId", count(*) c FROM base GROUP BY 1) x),
  'status',   (SELECT json_agg(x) FROM (SELECT "extractStatus", count(*) c FROM base GROUP BY 1) x),
  'sources',  (SELECT json_agg(x) FROM (SELECT "source", count(*) c FROM base GROUP BY 1) x),
  'trend',    (SELECT json_agg(x) FROM (
                 SELECT to_char(date_trunc('day', "startedAt") - interval '0 day', 'MM-DD') d,
                        count(*) c, sum("messageCount") m
                 FROM base WHERE "startedAt" IS NOT NULL GROUP BY date_trunc('day', "startedAt") ORDER BY 1) x),
  'hours',    (SELECT json_agg(x) FROM (
                 SELECT extract(hour from ("startedAt" + interval '8 hours')) h, count(*) c
                 FROM base WHERE "startedAt" IS NOT NULL GROUP BY 1) x),
  'agent7d',  (SELECT json_agg(x) FROM (
                 SELECT "agentId", count(*) c, sum("messageCount") m FROM base
                 WHERE "startedAt" >= now() - interval '7 days' GROUP BY 1) x),
  'recent',   (SELECT json_agg(x) FROM (
                 SELECT "id", "title", "agentId", "agentName", "source", "channel",
                        "messageCount", "lastMessageAt", "extractStatus"
                 FROM base ORDER BY "lastMessageAt" DESC NULLS LAST LIMIT 10) x)
) AS payload`;

export async function loadOverview(): Promise<Overview> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const rows = await prisma.$queryRawUnsafe<Array<{ payload: any }>>(SQL);
  const p = rows[0]?.payload || {};
  const toMap = (arr: any[], k: string) => (arr || []).map((r) => ({ [k]: r[k], _count: Number(r.c) }));
  const trend = (p.trend || []).map((r: any) => ({ date: r.d, sessions: Number(r.c), messages: Number(r.m) }));
  const hourDist = new Array(24).fill(0);
  for (const r of p.hours || []) hourDist[Number(r.h)] = Number(r.c);
  const data: Overview = {
    sessionCount: Number(p.kpi || 0),
    messageCount: Number(p.messages || 0),
    byAgent: toMap(p.agents, "agentId") as any,
    byStatus: toMap(p.status, "extractStatus") as any,
    // 2026-11-05 P0（首页 500 RangeError: Invalid time value）：json_build_object 返回的是**字符串**，
    // 页面里的 fmt() 用 Intl.DateTimeFormat.format(d) 只接受 Date；字符串/无效值都会抛。
    // 这里统一转成 Date | null（null 由页面显示 —），语义不变。
    recentSessions: (p.recent || []).map((r: any) => ({
      ...r,
      lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt) : null,
    })),
    trend,
    hourDist,
    agent7d: (p.agent7d || []).map((r: any) => ({
      agentId: r.agentId || "unknown",
      sessions: Number(r.c),
      messages: Number(r.m || 0),
    })),
    sourceDist: (p.sources || []).map((r: any) => ({ source: r.source || "UNKNOWN", count: Number(r.c) })),
  };
  cache = { at: Date.now(), data };
  return data;
}

