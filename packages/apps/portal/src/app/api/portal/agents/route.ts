import { NextResponse } from "next/server";
// 2026-10-15 架构收口(DB-ACCESS-RULE §3.1): 读走**驱动级只读**句柄, 不再用 Prisma 读写打开生产库。
// asDate: AgentRegistry.last_seen_at 是 DATETIME 列 —— Prisma 曾把它解成 Date(JSON = ISO 字符串),
//   better-sqlite3 返回毫秒整数, 故在出口显式还原, 保证对外 JSON 与改造前逐字一致(见 mind-read.ts)。
import { q as mindQuery, asDate } from "@/lib/mind-read";
import { silentQuery } from "@/lib/dbLog";

// GET /api/portal/agents
// 列出所有已注册 agent 及在线状态。
// 2026-09-22 改 silentQuery: prisma 失败时落 logs/portal-dev.log 并返回 warning,
//   避免历史(2026-09-17~22 stale-WAL fd 期间 HTTP 200 + agents=[]) 的盲点。
// 2026-10-15 修(实测): 本路由被 Next **静态缓存**了 —— 带 `x-nextjs-cache: HIT` 返回,
//   两次采样字节完全相同, `last_seen_at`/`online` 冻结在**构建时刻**(~04:11Z), 于是页面把一个
//   几分钟前的"在线状态"当成实时状态展示(实测与 sqlite3 直读差 48~70 分钟)。
//   修法: 强制动态渲染(与 readyz 同口径) —— 这类"在线状态"端点一旦被缓存就是**在骗人**,
//   与"守门全绿但链路已断"是同一类错误, 必须显式关掉缓存。
export const dynamic = "force-dynamic";

export async function GET() {
  let warning: string | null = null;
  const rows = await silentQuery<any[]>(
    () => mindQuery(`
      SELECT agent_id, display_name, channel, host, status, last_seen_at, profile
      FROM AgentRegistry
      ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, last_seen_at DESC
    `),
    [],
    "agents.list",
    () => { warning = "data_unavailable"; },
  );

  const now = Date.now();
  // 2026-10-15 round-78 修正: `last_seen_at` 已被收口为**唯一真心跳写者**(POST /api/v1/agents/seen),
  //   而真心跳周期是 **1 小时**(macs_responder.py 的 GUIDE_INTERVAL_S=3600), 原来 5 分钟的窗口
  //   会让"一小时里 55 分钟都显示离线"(假死) —— 与收口前的"谁调接口谁就算在线"(假活) 一样不可信。
  //   这里把窗口放宽到 **1.5 倍心跳周期**, 并让字段语义与实现一致(heartbeat_alive, 不是"此刻在线")。
  //   注: 这只是止血; 更正确的做法是把"心跳存活"与"最近接口活动"
  //   (AgentServicePermission.last_used_at) 拆成两个指标分别展示。
  const HEARTBEAT_ALIVE_MS = 5400000; // 1.5h > 1h 心跳周期
  const result = (rows as any[]).map((a) => {
    const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
    const online = a.status === "ACTIVE" && (now - lastSeen) < HEARTBEAT_ALIVE_MS;
    return {
      agent_id: a.agent_id,
      display_name: a.display_name,
      channel: a.channel,
      host: a.host,
      status: a.status,
      online,
      heartbeat_alive: online,
      heartbeat_alive_window_ms: HEARTBEAT_ALIVE_MS,
      last_seen_at: asDate(a.last_seen_at),
      profile: a.profile ? (typeof a.profile === "string" ? JSON.parse(a.profile) : a.profile) : null,
    };
  });

  return NextResponse.json({
    ok: true,
    warning,
    total: result.length,
    active: result.filter((r) => r.status === "ACTIVE").length,
    online: result.filter((r) => r.online).length,
    agents: result,
  });
}
