/**
 * GET /api/flywheel/assets/trend —— 30 天趋势（0.6.4 批次 A U-56b B-02/B-03）
 *
 * 契约来源：[team] 06:43 交付（FOUR-BOARDS-MAPPING §3 + STATS-SPEC §4）
 *   GET /api/flywheel/assets/trend?asset=<asset>&days=30
 *   成功  : { trend: [{ day:"MM-DD", n:int }], asset, days, asOf }
 *   无数据: { trend: null, reason:"30 天趋势未采集…", asset, days, asOf }   <- 不返回 0 数组
 *   失败  : { trend: null, reason:"<错误原文>", asset, days, asOf }        <- 不静默吞
 *
 * 口径（flywheel §4）：
 *   · 窗口 = 滚动 30 天（>= now() at time zone 'UTC' - interval '30 days'）
 *   · 按 UTC 自然日分组（跨 UTC 0 点归次日）
 *   · 缺日不补 0（缺日就是无数据；页面不得画假 0 线）
 *
 * 资产映射（flywheel §3；时间列各不相同，Practice 用 startedAt、ErrorLog 用 occurredAt）：
 */
import { NextResponse } from "next/server";
import { openMind, openSession, qStrict } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

interface AssetSpec { db: "mind" | "session"; table: string; ts: string; label: string }

const ASSETS: Record<string, AssetSpec> = {
  // 板④ 飞轮吞吐 / 任务
  flywheel_event: { db: "mind", table: "FlywheelEvent", ts: "createdAt", label: "飞轮事件吞吐" },
  flywheel_job: { db: "mind", table: "FlywheelJob", ts: "createdAt", label: "飞轮任务数" },
  // 板④ 断点（时间列是 occurredAt，不是 createdAt）
  error_log: { db: "mind", table: "FlywheelErrorLog", ts: "occurredAt", label: "断点数" },
  // 板① 会话流入（**另一个库** lions_session）
  session: { db: "session", table: "Session", ts: "createdAt", label: "会话流入" },
  // 板② 六域趋势（Practice 用 startedAt）
  memory: { db: "mind", table: "Memory", ts: "createdAt", label: "记忆" },
  knowledge: { db: "mind", table: "Knowledge", ts: "createdAt", label: "知识" },
  practice: { db: "mind", table: "Practice", ts: "startedAt", label: "实践" },
  skill: { db: "mind", table: "Skill", ts: "createdAt", label: "技能" },
  reflection: { db: "mind", table: "Reflection", ts: "createdAt", label: "反思" },
};

/** 只接受白名单 asset；days 限 1..90（防注入，days 直接进 SQL interval） */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = String(url.searchParams.get("asset") || "flywheel_event").trim();
  const daysRaw = Number(url.searchParams.get("days") || 30);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(90, Math.floor(daysRaw))) : 30;
  const asOf = new Date().toISOString();

  const spec = ASSETS[asset];
  if (!spec) {
    return NextResponse.json({
      trend: null,
      asset,
      days,
      asOf,
      reason: "未知资产（可用：" + Object.keys(ASSETS).join(" / ") + "）",
    }, { status: 400 });
  }

  const db = spec.db === "session" ? openSession() : openMind();
  if (!db) {
    return NextResponse.json({
      trend: null, asset, days, asOf,
      reason: (spec.db === "session" ? "会话库" : "认知库") + "连接不可用（未配置连接串）",
    });
  }

  // 表名/时间列来自上面的白名单常量（非用户输入），days 已钳制为整数 -> 无注入面
  const sql = 'SELECT to_char("' + spec.ts + '" at time zone \'UTC\', \'MM-DD\') AS day, count(*)::int AS n '
    + 'FROM "' + spec.table + '" '
    + 'WHERE "' + spec.ts + '" >= (now() at time zone \'UTC\') - interval \'' + days + ' days\' '
    + 'GROUP BY 1 ORDER BY 1';

  try {
    const rows = await qStrict(db, sql);
    const trend = rows
      .map((r) => ({ day: String(r.day || ""), n: Number(r.n) || 0 }))
      .filter((r) => r.day);
    if (trend.length === 0) {
      return NextResponse.json({
        trend: null, asset, days, asOf, label: spec.label,
        reason: "30 天趋势未采集（该资产近 " + days + " 天无任何记录）",
      });
    }
    return NextResponse.json({ trend, asset, days, asOf, label: spec.label, source: spec.db + "." + spec.table + "." + spec.ts });
  } catch (e) {
    // 不静默吞：把错误原文回给页面（设计 判据⑤：无数据必须 na + 原因；失败也要有原因）
    return NextResponse.json({
      trend: null, asset, days, asOf, label: spec.label,
      reason: "趋势查询失败：" + String((e as Error)?.message || e).slice(0, 160),
    });
  }
}
