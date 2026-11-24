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

/**
 * 0.6.5（devops 06:52 诊断）：上面的 SQL 是 **PG-only**（json_build_object / to_char / date_trunc /
 * interval / ::text / now()），SQLite 下直跑报 `unrecognized token: ":"` -> dev 首页 500。
 * prod :3002 / test :14102 用 PG 正常，所以**不是 prod 缺陷**，只影响 dev(SQLite) 预览。
 *
 * 修法（devops 选项 a）：**加 SQLite 分支（JS 聚合），PG 路径一行不改**。
 *   · PG     -> 仍走原来的单条 CTE 大 SQL（零改动）
 *   · SQLite -> 用 Prisma ORM 取数 + 在 Node 里做同样口径的聚合（dev 库小，可全量）
 * 口径与 PG 版逐条对应：us/cs/base 三个集合、trend 按日、hours +8h、agent7d 近 7 天。
 */
const IS_PG = (process.env.SESSION_DB_DRIVER || "").toLowerCase() === "pg";

export async function loadOverview(): Promise<Overview> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const data = IS_PG ? await loadOverviewPg() : await loadOverviewSqlite();
  cache = { at: Date.now(), data };
  return data;
}

async function loadOverviewPg(): Promise<Overview> {
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
  return data;
}

/** SQLite 分支：与 PG 版同口径的 JS 聚合（不改 PG 路径；dev 库小，全量取数可接受） */
async function loadOverviewSqlite(): Promise<Overview> {
  const db = prisma as any;
  // us / cs：有 user 消息的 sessionId 集合 / 其中 content 以 [cron: 开头的集合（对应 PG 的 us / cs CTE）
  const msgs: Array<{ sessionId: string | null; content: any }> = await db.message.findMany({
    where: { role: "user" },
    select: { sessionId: true, content: true },
  });
  const us = new Set<string>();
  const cs = new Set<string>();
  for (const m of msgs) {
    if (!m.sessionId) continue;
    us.add(m.sessionId);
    const c = typeof m.content === "string" ? m.content : "";
    if (c.startsWith("[cron:")) cs.add(m.sessionId); // PG: content::text LIKE '[cron:%'
  }
  const all: any[] = await db.session.findMany({
    where: { messageCount: { gt: 0 } },
    select: {
      id: true, title: true, agentId: true, agentName: true, source: true, channel: true,
      messageCount: true, lastMessageAt: true, extractStatus: true, startedAt: true, sourceId: true,
    },
    take: 50000,
  });
  // base：等价于 PG 的 SESSION_EXCLUDE_FILTER（sourceId 排除 cron / cron_ / session_cron_）
  const isCronSource = (v: any) => {
    const s = v == null ? "" : String(v);
    return s.startsWith("cron:") || s.startsWith("cron_") || s.startsWith("session_cron_");
  };
  const base = all.filter((s) => us.has(s.id) && !cs.has(s.id) && !isCronSource(s.sourceId));

  const byAgent = new Map<string | null, number>();
  const byStatus = new Map<string | null, number>();
  const bySource = new Map<string | null, number>();
  const trendMap = new Map<string, { sessions: number; messages: number }>();
  const hourDist = new Array(24).fill(0);
  const agent7dMap = new Map<string, { sessions: number; messages: number }>();
  const now = Date.now();
  const sevenDayAgo = now - 7 * 24 * 3600 * 1000;
  for (const s of base) {
    byAgent.set(s.agentId ?? null, (byAgent.get(s.agentId ?? null) || 0) + 1);
    byStatus.set(s.extractStatus ?? null, (byStatus.get(s.extractStatus ?? null) || 0) + 1);
    bySource.set(s.source ?? null, (bySource.get(s.source ?? null) || 0) + 1);
    if (s.startedAt == null) continue;
    const d = new Date(s.startedAt);
    if (isNaN(d.getTime())) continue;
    const mmdd = String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const t = trendMap.get(mmdd) || { sessions: 0, messages: 0 };
    t.sessions += 1;
    t.messages += Number(s.messageCount || 0);
    trendMap.set(mmdd, t);
    // PG: extract(hour from (startedAt + interval '8 hours')) -> 本地小时 +8 取模
    hourDist[(d.getHours() + 8) % 24] += 1;
    if (d.getTime() >= sevenDayAgo) {
      const k = s.agentId || "unknown";
      const a = agent7dMap.get(k) || { sessions: 0, messages: 0 };
      a.sessions += 1;
      a.messages += Number(s.messageCount || 0);
      agent7dMap.set(k, a);
    }
  }
  const messageCount = await db.message.count();
  const recentSessions = base
    .slice()
    .sort((a, b) => {
      const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 10)
    .map((s) => ({
      id: s.id, title: s.title, agentId: s.agentId, agentName: s.agentName, source: s.source,
      channel: s.channel, messageCount: s.messageCount, extractStatus: s.extractStatus,
      lastMessageAt: s.lastMessageAt ? new Date(s.lastMessageAt) : null,
    }));
  return {
    sessionCount: base.length,
    messageCount: Number(messageCount || 0),
    byAgent: Array.from(byAgent.entries()).map(([agentId, c]) => ({ agentId, _count: c })) as any,
    byStatus: Array.from(byStatus.entries()).map(([extractStatus, c]) => ({ extractStatus, _count: c })) as any,
    recentSessions,
    trend: Array.from(trendMap.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, v]) => ({ date, sessions: v.sessions, messages: v.messages })),
    hourDist,
    agent7d: Array.from(agent7dMap.entries()).map(([agentId, v]) => ({ agentId, sessions: v.sessions, messages: v.messages })),
    sourceDist: Array.from(bySource.entries()).map(([source, count]) => ({ source: source || "UNKNOWN", count })),
  };
}

