import { NextResponse } from "next/server";
import { openMind, q } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

/**
 * /api/mcp-summary — /tools/mcp 页数据（D1，2026-11-13）
 * 数据卡 card-tools-mcp.md：
 *   · 服务注册数 = count(*) from "AgentService"（含 ACTIVE 6 + DEPRECATED 1）
 *   · 可用服务数(ACTIVE) = count(*) where status='ACTIVE'
 *   · toolsCount / latencyMs / lastCheck = n/a（G-02/G-03：无列/通道超时）
 * 只用真实 DB 计数；连不上库 -> 503 fail-closed，不返回硬编码数字。
 */
export async function GET() {
  const db = openMind();
  if (!db) return NextResponse.json({ ok: false, reason: "mind 只读库不可用（MIND_DATABASE_URL/密码缺失）" }, { status: 503 });
  try {
    const rows = (await q(db, 'SELECT status, count(*)::int AS n FROM "AgentService" GROUP BY status')) || [];
    let total = 0, active = 0, deprecated = 0, disabled = 0, other = 0;
    for (const r of rows) {
      const n = Number(r.n) || 0;
      total += n;
      const s = String(r.status || "").toUpperCase();
      if (s === "ACTIVE") active += n;
      else if (s === "DEPRECATED") deprecated += n;
      else if (s === "DISABLED") disabled += n;
      else other += n;
    }
    return NextResponse.json({
      ok: true,
      total, active, deprecated, disabled, other,
      asOf: new Date().toISOString(),
      source: 'mind "AgentService".count(*) group by status',
      unavailable: [
        { field: "每服务工具数 toolsCount", reason: "G-02：「/api/mcp-proxy tools/list」发布树不可用/15s 超时，且字典无 toolsCount 列" },
        { field: "探测延迟 latencyMs / 最近探测 lastCheck", reason: "G-03：AgentService 无 latency/lastCheck 列，health_url 全空，无探测" },
        { field: "「在线」语义", reason: "G-01：/api/mcp/servers 不存在；按字典 :108 以 status='ACTIVE' 为可用，不另立 MCP 注册表条目" },
      ],
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, reason: "查询 AgentService 失败：" + String(e?.message || e) }, { status: 500 });
  }
}
