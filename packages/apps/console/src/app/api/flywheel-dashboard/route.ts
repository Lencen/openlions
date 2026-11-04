import { NextResponse } from "next/server";
import fs from "node:fs";
import { q, one, openMind } from "@/lib/server/lions-db";

// 2026-10-15 round-78: 本路由原用 better-sqlite3 只读打开 mind 库, 会被 build 期预渲染成冻结快照。
// 2026-10-21 Phase 2: 改为 PG 连接池（lions-db），并保留 force-dynamic。
export const dynamic = "force-dynamic";

export async function GET() {
  const db = openMind();
  try {
    const now = Date.now();
    const h1ago = now - 3600000;
    const h24ago = now - 86400000;
    const m5ago = now - 300000;

    // 1. 5 表数据量 + 24h 新增（2026-09-15 F6: 有 stale 字段的表排除撤回行）
    const tables = ["Memory", "Knowledge", "Reflection", "Practice", "Skill"];
    const activeWhere: Record<string, string> = {
      Memory: "supersededBy IS NULL",
      Knowledge: "supersededBy IS NULL AND COALESCE(stale,0)=0",
      Reflection: "supersededBy IS NULL",
      Practice: "supersededBy IS NULL AND COALESCE(stale,0)=0",
      Skill: "supersededBy IS NULL AND COALESCE(stale,0)=0",
    };
    const tableStats = await Promise.all(tables.map(async (t) => {
      const total = await one(db, `SELECT COUNT(*) as c FROM ${t} WHERE ${activeWhere[t]}`);
      const recent = await one(db, `SELECT COUNT(*) as c FROM ${t} WHERE createdAt > $1`, h24ago);
      const h1 = await one(db, `SELECT COUNT(*) as c FROM ${t} WHERE createdAt > $1`, h1ago);
      // 2026-10-21：PG 的 COUNT(*) 是 bigint，node-postgres 返回**字符串**；前端做加法会变字符串拼接
      //   （0+841+557+… → "0841557106…"，飞轮 KPI 出现过这种 16 位怪数）。这里统一转数字。
      const N = (v: any) => (v == null ? 0 : Number(v) || 0);
      return { table: t, active: N(total?.c), h24: N(recent?.c), h1: N(h1?.c) };
    }));

    // 2. 主题分布 (top 15)
    const themes = await q(db, `
      SELECT theme, COUNT(*) as cnt FROM Memory WHERE supersededBy IS NULL AND theme IS NOT NULL
      GROUP BY theme ORDER BY cnt DESC LIMIT 15
    `);

    // 3. 质量分分布 (分类型)
    const qualityByType = {
      memory: await q(db, `SELECT CASE WHEN qualityScore>=0.7 THEN 'high' WHEN qualityScore>=0.4 THEN 'mid' WHEN qualityScore>0 THEN 'low' ELSE 'zero' END as b, COUNT(*) as c FROM Memory WHERE ${activeWhere["Memory"]} GROUP BY b`),
      practice: await q(db, `SELECT CASE WHEN qualityScore>=0.7 THEN 'high' WHEN qualityScore>=0.4 THEN 'mid' WHEN qualityScore>0 THEN 'low' ELSE 'zero' END as b, COUNT(*) as c FROM Practice WHERE ${activeWhere["Practice"]} GROUP BY b`),
      knowledge: await q(db, `SELECT CASE WHEN confidence>=0.7 THEN 'high' WHEN confidence>=0.4 THEN 'mid' WHEN confidence>0 THEN 'low' ELSE 'zero' END as b, COUNT(*) as c FROM Knowledge WHERE ${activeWhere["Knowledge"]} GROUP BY b`),
      reflection: await q(db, `SELECT CASE WHEN score>=0.7 THEN 'high' WHEN score>=0.4 THEN 'mid' WHEN score>0 THEN 'low' ELSE 'zero' END as b, COUNT(*) as c FROM Reflection WHERE ${activeWhere["Reflection"]} GROUP BY b`),
    };
    const qualityDims = [
      { type: "Memory", dim: "决策性+经验性", desc: "有决策词+0.3, 经验词+0.2, 具体+0.2, valueScore+0.2, JSON dump惩罚-0.3" },
      { type: "Knowledge", dim: "准确性+完整性", desc: "confidence+0.3, title+content完整+0.2, 结构化+0.2, 具体性+0.2" },
      { type: "Reflection", dim: "可执行性", desc: "improvements有内容+0.4, lesson具体+0.2, 优先级P1+0.3/P2+0.2/P3+0.1" },
      { type: "Practice", dim: "可重复性+结果", desc: "outcome有值+0.3, 命令/步骤+0.3, type明确+0.2, difficulty+0.2" },
      { type: "Skill", dim: "数据干净度", desc: "level标准值+0.4(非标准归零), 描述完整+0.3, 有category+0.3" },
    ];

    // 4. 错误分类 (24h)
    const errors = await q(db, `
      SELECT errorType, COUNT(*) as cnt
      FROM FlywheelErrorLog WHERE occurredAt > $1
      GROUP BY errorType ORDER BY cnt DESC
    `, h24ago);

    // 5. 最近 cron tick (从 FlywheelEvent)
    const lastTick = await one(db, `
      SELECT stage, sourceType, sourceTitle, createdAt
      FROM FlywheelEvent
      ORDER BY createdAt DESC LIMIT 1
    `);

    // 6. 最近 5 分钟 FlywheelEvent
    const recentEvents = await q(db, `
      SELECT stage, sourceType, COUNT(*) as cnt
      FROM FlywheelEvent WHERE createdAt > $1
      GROUP BY stage, sourceType
    `, m5ago);

    // 7. cron 调度信息 (静态)
    const cronSchedule = [
      { time: "*/30 min", task: "flywheel-cron", desc: "scan + extract + write (max 5)" },
      { time: ":05", task: "reflectWorker", desc: "跨会话主题聚合反思" },
      { time: ":15", task: "improving-tasks", desc: "反思 -> 任务转化" },
      { time: ":25", task: "structuredCron", desc: "碎片结构化整理" },
      { time: "*/10 min", task: "sync-cron", desc: "会话增量同步" },
    ];

    // 8. resolver 决策统计 (最近 1h, 从 CognitiveCandidate)
    let resolverStats: any[] = [];
    try {
      resolverStats = await q(db, `
        SELECT resolverAction, COUNT(*) as cnt
        FROM CognitiveCandidate WHERE resolvedAt > $1
        GROUP BY resolverAction
      `, h1ago);
    } catch { /* table might not exist */ }

    // 9. 日志文件大小 (运行状态)
    let logSize = 0, jsonlSize = 0;
    try { logSize = fs.statSync("/tmp/lions-flywheel.log").size; } catch {}
    try { jsonlSize = fs.statSync("/tmp/lions-flywheel.jsonl").size; } catch {}

    // 10. 读取 jsonl 最后几条 (当前运行状态)
    let recentLogEntries: any[] = [];
    try {
      const lines = fs.readFileSync("/tmp/lions-flywheel.jsonl", "utf-8").trim().split("\n").slice(-20);
      recentLogEntries = lines.map((l: string) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {}

    // 11. ImprovementAction 统计
    const actionStats: any = { total: 0, completed: 0, pending: 0 };
    try {
      actionStats.total = (await one(db, "SELECT COUNT(*) as c FROM ImprovementAction"))?.c ?? 0;
      actionStats.completed = (await one(db, "SELECT COUNT(*) as c FROM ImprovementAction WHERE status='completed'"))?.c ?? 0;
      actionStats.pending = (await one(db, "SELECT COUNT(*) as c FROM ImprovementAction WHERE status='pending'"))?.c ?? 0;
    } catch {}

    // 12. FlywheelReflection 统计
    const reflectionStats: any = { total: 0, avgCoverage: 0 };
    try {
      // 同上：bigint 字符串要转数字，否则前端求和会变拼接
      reflectionStats.total = Number((await one(db, "SELECT COUNT(*) as c FROM FlywheelReflection"))?.c ?? 0) || 0;
      const avg = await one(db, "SELECT AVG(coverageScore) as a FROM FlywheelReflection");
      reflectionStats.avgCoverage = Number(avg?.a ?? 0) || 0;
    } catch {}

    // 13.5 LLM 调用观测 (CALL_LLM stage, 24h)
    const llmStats: any = { total24h: 0, ok24h: 0, fail24h: 0, byEntry: [], trend: [] };
    try {
      llmStats.total24h = (await one(db, "SELECT COUNT(*) as c FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt > $1", h24ago))?.c ?? 0;
      llmStats.ok24h = (await one(db, "SELECT COUNT(*) as c FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt > $1 AND targetStage='OK'", h24ago))?.c ?? 0;
      llmStats.fail24h = llmStats.total24h - llmStats.ok24h;
      llmStats.byEntry = await q(db, `
        SELECT sourceType as entry, COUNT(*) as calls,
          SUM(CASE WHEN targetStage='OK' THEN 1 ELSE 0 END) as ok,
          AVG(CAST(sourceId AS INTEGER)) as avgMs
        FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt > $1
        GROUP BY sourceType ORDER BY calls DESC
      `, h24ago);
      llmStats.trend = await q(db, `
        SELECT (createdAt/3600000) as hb, COUNT(*) as c FROM FlywheelEvent
        WHERE stage='CALL_LLM' AND createdAt > $1 GROUP BY hb ORDER BY hb
      `, h24ago);
    } catch {}

    // 13. 24h 趋势 (按小时桶, 供 sparkline)
    const trend: any = { events: [], writes: [], errors: [] };
    try {
      trend.events = await q(db, `
        SELECT (createdAt/3600000) as hb, COUNT(*) as c FROM FlywheelEvent
        WHERE createdAt > $1 GROUP BY hb ORDER BY hb
      `, h24ago);
      trend.writes = await q(db, `
        SELECT (createdAt/3600000) as hb, COUNT(*) as c FROM (
          SELECT createdAt FROM Memory WHERE createdAt > $1
          UNION ALL SELECT createdAt FROM Knowledge WHERE createdAt > $1
          UNION ALL SELECT createdAt FROM Reflection WHERE createdAt > $1
          UNION ALL SELECT createdAt FROM Practice WHERE createdAt > $1
          UNION ALL SELECT createdAt FROM Skill WHERE createdAt > $1
        ) t GROUP BY hb ORDER BY hb
      `, h24ago, h24ago, h24ago, h24ago, h24ago);
      trend.errors = await q(db, `
        SELECT (occurredAt/3600000) as hb, COUNT(*) as c FROM FlywheelErrorLog
        WHERE occurredAt > $1 GROUP BY hb ORDER BY hb
      `, h24ago);
    } catch {}

    return NextResponse.json({
      tableStats,
      themes,
      qualityByType,
      qualityDims,
      errors,
      lastTick,
      recentEvents,
      cronSchedule,
      resolverStats,
      logInfo: { logSize, jsonlSize },
      recentLogEntries,
      actionStats,
      reflectionStats,
      llmStats,
      trend,
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
