import { extractLlmText } from "@/server/llm/extract-text";
import { prisma } from "@/lib/prisma";
import { sessionQuery } from "@/server/lib/session-pg";
import { parseStructuredFindings } from "./findings-parse";

// 2026-09-09 每日 00:00 日结反思 — 固定大纲结构(无数据也有键, 页面按框架渲染)
const OFF = 8 * 3600 * 1000; // Asia/Shanghai +8
function dayWindow(): { start: number; end: number; dateKey: string } {
  const nowUtc = Date.now();
  const todayLocalStart = Math.floor((nowUtc + OFF) / 86400000) * 86400000 - OFF;
  const start = todayLocalStart - 86400000;
  const end = todayLocalStart;
  const d = new Date(start + OFF);
  const dateKey = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  return { start, end, dateKey };
}
function safe<T>(s: string | null, fb: T): T { try { return JSON.parse(s || "") as T; } catch { return fb; } }

// 2026-10-26 SQLite 退役(P3): 改为只读 lions_session（PG）。
async function readSessionWindow(startMs: number, endMs: number): Promise<{ count: number; messages: number; byAgent: Array<{ agentId: string; sessions: number; messages: number }> }> {
  try {
    const rows = await sessionQuery<any>(
      'SELECT "agentId", COUNT(*)::int AS sessions, COALESCE(SUM("messageCount"),0)::int AS messages ' +
      'FROM "Session" WHERE "updatedAt" >= $1 AND "updatedAt" < $2 GROUP BY "agentId" ORDER BY sessions DESC',
      [new Date(startMs), new Date(endMs)]
    );
    const count = rows.reduce((a, r) => a + Number(r.sessions || 0), 0);
    const messages = rows.reduce((a, r) => a + Number(r.messages || 0), 0);
    return { count, messages, byAgent: rows.map((r) => ({ agentId: r.agentId || "?", sessions: Number(r.sessions), messages: Number(r.messages) })) };
  } catch (e: any) {
    console.warn("[reflect-daily] session PG 读取失败: " + (e?.message || e));
    return { count: 0, messages: 0, byAgent: [] };
  }
}
function jStr(v: unknown): string { try { return JSON.stringify(v); } catch { return ""; } }

const EMPTY_STATS = {
  meta: { date: "", windowStartUtc: 0, windowEndUtc: 0, tz: "Asia/Shanghai", generatedAtUtc: "" },
  why: { kind: "daily", trigger: "每日00:00定时" },
  source: { themesReflected: [] as any[], themesReflectedCount: 0, sessions: { active: 0, messages: 0 } },
  summary: { text: "" },
  products: { memory: { created: 0, qualityBuckets: { high: 0, mid: 0, low: 0, unscored: 0 }, superseded: 0 }, knowledge: { created: 0 }, practice: { created: 0 } },
  findings: { total: 0, recurring: 0, resolved: 0, byActionType: {} as Record<string, number>, byPriority: {} as Record<string, number> },
  tasks: { created: { total: 0, byType: {} as Record<string, number> }, done: { total: 0, byType: {} as Record<string, number> }, failed: { total: 0, byType: {} as Record<string, number>, samples: [] as any[] }, executions: 0 },
  produced: { memory: 0, knowledge: 0, practice: 0 },
  quality: { avgMemoryQuality: null as number | null },
  leftover: [] as any[],
  suggested: [] as any[],
};

export async function runDailyReflection() {
  const { start, end, dateKey } = dayWindow();
  const theme = "DAILY·" + dateKey;
  const D = (ms: number) => new Date(ms);
  const stats: any = JSON.parse(JSON.stringify(EMPTY_STATS));
  stats.meta = { date: dateKey, windowStartUtc: start, windowEndUtc: end, tz: "Asia/Shanghai", generatedAtUtc: new Date().toISOString() };
  stats.why = { kind: "daily", trigger: "每日00:00定时" };

  // 1) 昨日被反思的主题 (含 findings 聚合)
  const refls: any[] = await prisma.flywheelReflection.findMany({
    where: { updatedAt: { gte: D(start), lt: D(end) }, theme: { not: { startsWith: "DAILY·" } } },
    select: { theme: true, coverageScore: true, coverageDelta: true, structuredFindings: true, status: true },
  });
  const themeDetails = refls.map((r) => ({ theme: r.theme, coverage: r.coverageScore, delta: r.coverageDelta ?? null, findingsCount: parseStructuredFindings(r.structuredFindings).length }));
  stats.source.themesReflected = themeDetails.slice(0, 30);
  stats.source.themesReflectedCount = refls.length;
  const covs = themeDetails.map((t) => t.coverage).filter((c: number) => c != null);
  const avgCov = covs.length ? covs.reduce((a: number, b: number) => a + b, 0) / covs.length : null;
  stats.quality.avgMemoryQuality = avgCov != null ? Number(avgCov.toFixed(4)) : null;

  // findings 聚合 (跨昨日全部主题反思)
  const fav = stats.findings;
  for (const r of refls) {
    const fs = parseStructuredFindings(r.structuredFindings);
    for (const f of fs) {
      fav.total++;
      if (f.status === "RECURRING") fav.recurring++;
      if (f.status === "RESOLVED") fav.resolved++;
      fav.byActionType[f.actionType || "?"] = (fav.byActionType[f.actionType || "?"] || 0) + 1;
      fav.byPriority[f.priority || "?"] = (fav.byPriority[f.priority || "?"] || 0) + 1;
    }
  }

  // 2) 会话 (2026-09-10 遗留修复: 原读 mind.SessionRegistry — 该表自 08-28 起已停写, 窗口恒 0;
  //    真实会话在 session 服务 DB(Session 表), 改为只读直查该库, 口径与 flow/看板一致)
  const sessionSessions = await readSessionWindow(start, end);
  stats.source.sessions = { active: sessionSessions.count, messages: sessionSessions.messages };
  stats.source.sessionsByAgent = sessionSessions.byAgent;

  // 3) 产物
  const mems: any[] = await prisma.memory.findMany({ where: { createdAt: { gte: D(start), lt: D(end) } }, select: { qualityScore: true } });
  const memSup = await prisma.memory.count({ where: { supersededAt: { gte: D(start), lt: D(end) } } }).catch(() => 0);
  const knoN = await prisma.knowledge.count({ where: { createdAt: { gte: D(start), lt: D(end) } } });
  const praN = await prisma.practice.count({ where: { createdAt: { gte: D(start), lt: D(end) } } });
  const buckets = { high: 0, mid: 0, low: 0, unscored: 0 };
  let qSum = 0, qN = 0;
  for (const m of mems) {
    const q = m.qualityScore;
    if (q == null) buckets.unscored++;
    else { qSum += q; qN++; if (q >= 0.7) buckets.high++; else if (q >= 0.4) buckets.mid++; else buckets.low++; }
  }
  stats.products.memory = { created: mems.length, qualityBuckets: buckets, superseded: memSup };
  stats.products.knowledge = { created: knoN };
  stats.products.practice = { created: praN };
  stats.quality.avgMemoryQuality = qN ? Number((qSum / qN).toFixed(3)) : null;

  // 4) 任务 byType (昨日创建 / 昨日完成 / 昨日失败)
  const byType = async (status: string, col: string, wStart: number, wEnd: number): Promise<Record<string, number>> => {
    const rows: any = await prisma.$queryRawUnsafe(
      "SELECT improvementType t, COUNT(*) c FROM Task WHERE improvementType IS NOT NULL AND status=? AND " + col + " >= ? AND " + col + " < ? GROUP BY improvementType",
      status, D(wStart), D(wEnd)
    ).catch(() => []);
    const o: Record<string, number> = {};
    for (const r of rows || []) o[r.t || "NULL"] = Number(r.c);
    return o;
  };
  stats.tasks.created.byType = await byType("PENDING", "createdAt", start, end);
  stats.tasks.created.total = Object.values(stats.tasks.created.byType).reduce((a: number, b: any) => a + Number(b), 0);
  stats.tasks.done.byType = await byType("DONE", "updatedAt", start, end);
  stats.tasks.done.total = Object.values(stats.tasks.done.byType).reduce((a: number, b: any) => a + Number(b), 0);
  stats.tasks.failed.byType = await byType("FAILED", "updatedAt", start, end);
  stats.tasks.failed.total = Object.values(stats.tasks.failed.byType).reduce((a: number, b: any) => a + Number(b), 0);
  const failedSamples: any[] = await prisma.task.findMany({
    where: { improvementType: { not: null }, status: "FAILED", updatedAt: { gte: D(start), lt: D(end) } },
    select: { id: true, theme: true, title: true, improvementType: true },
    orderBy: { updatedAt: "desc" as const },
    take: 5,
  }).catch(() => []);
  stats.tasks.failed.samples = failedSamples.map((t) => ({ id: t.id, theme: t.theme, title: String(t.title || "").slice(0, 80), type: t.improvementType }));
  stats.tasks.executions = await prisma.taskExecution.count({ where: { createdAt: { gte: D(start), lt: D(end) } } });

  // 5) 改进落库产物
  const [pm, pk, pp] = await Promise.all([
    prisma.memory.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: D(start), lt: D(end) } } }),
    prisma.knowledge.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: D(start), lt: D(end) } } }),
    prisma.practice.count({ where: { sourceType: "FLYWHEEL_STRUCTURED", createdAt: { gte: D(start), lt: D(end) } } }),
  ]);
  stats.produced = { memory: pm, knowledge: pk, practice: pp };

  // 6) 遗留与建议 (规则生成, 结构化)
  const leftover: any[] = [];
  for (const s of failedSamples.slice(0, 3)) leftover.push({ type: "task_failed", ref: s.id, detail: "改进任务失败: " + (s.theme || "") + " · " + String(s.title || "").slice(0, 40) });
  const recThemes = themeDetails.filter((t) => {
    const rf = refls.find((x: any) => x.theme === t.theme);
    const fs = parseStructuredFindings(rf?.structuredFindings);
    return fs.some((f) => f.status === "RECURRING");
  });
  for (const t of recThemes.slice(0, 3)) leftover.push({ type: "recurring", ref: t.theme, detail: "复发未解决发现: " + t.theme });
  for (const t of themeDetails.filter((t: any) => (t.coverage ?? 1) < 0.35).slice(0, 3)) leftover.push({ type: "low_coverage", ref: t.theme, detail: "低覆盖主题(" + (t.coverage ?? 0).toFixed(2) + "): " + t.theme });
  stats.leftover = leftover;
  stats.suggested = themeDetails.slice().sort((a: any, b: any) => (a.coverage ?? 1) - (b.coverage ?? 1)).slice(0, 5).map((t: any) => ({ theme: t.theme, coverage: t.coverage }));

  // 7) LLM 日结总结 (M3, 失败规则兜底)
  let summaryText = "";
  try {
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
    const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.MINIMAX_API_KEY || "";
    if (apiKey) {
      const promptText = "你是 LIONS 平台日结引擎。昨日(" + dateKey + ")飞轮数据(JSON):\n" + jStr(stats) + "\n\n输出≤450字中文'昨日总结与反思': 1)整体概况; 2)亮点与异常(覆盖/失败任务/产物质量); 3)值得注意的遗留问题。只输出正文, 不要JSON。";
      const res = await fetch(baseUrl + "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: process.env.REFLECT_MODEL || process.env.ANTHROPIC_MODEL || "MiniMax-M3", max_tokens: 1000, system: "你是严谨的平台日结分析引擎。", messages: [{ role: "user", content: promptText }] }),
        signal: AbortSignal.timeout(150000),
      });
      if (res.ok) { const data: any = await res.json(); summaryText = String(extractLlmText(data)).trim().slice(0, 600); }
    }
  } catch (e: any) {
    console.warn("[reflect-daily] LLM 总结失败, 用规则摘要: " + ((e?.message || "").slice(0, 80)));
  }
  if (!summaryText) {
    summaryText = "昨日(" + dateKey + ")飞轮运行: 反思主题 " + stats.source.themesReflectedCount + " 个, 活跃会话 " + stats.source.sessions.active + "(消息 " + stats.source.sessions.messages + "), 新增产物 Memory " + stats.products.memory.created + "/Knowledge " + stats.products.knowledge.created + "/Practice " + stats.products.practice.created + ", 改进落库 " + (pm + pk + pp) + " 条, 任务新增 " + stats.tasks.created.total + "/完成 " + stats.tasks.done.total + "/失败 " + stats.tasks.failed.total + ", 执行 " + stats.tasks.executions + " 次。";
  }
  stats.summary.text = summaryText;

  const saved = await prisma.flywheelReflection.upsert({
    where: { theme },
    create: {
      theme, missedTopics: "[]", improvements: "[]", conflicts: "[]",
      coverageScore: avgCov ?? 0, productCounts: jStr({ memory: stats.products.memory.created, knowledge: stats.products.knowledge.created, practice: stats.products.practice.created }),
      status: "OK", attempts: 1, reflectionGranularity: "day", dayStats: jStr(stats), summary: summaryText,
      triggerReason: jStr({ kind: "daily", date: dateKey }),
    },
    update: {
      coverageScore: avgCov ?? 0, productCounts: jStr({ memory: stats.products.memory.created, knowledge: stats.products.knowledge.created, practice: stats.products.practice.created }),
      status: "OK", dayStats: jStr(stats), summary: summaryText, triggerReason: jStr({ kind: "daily", date: dateKey }), updatedAt: new Date(),
    },
  });
  console.log("[reflect-daily] " + dateKey + " done: themes=" + refls.length + " mem=" + mems.length + " tasksDone=" + stats.tasks.done.total + " summaryLen=" + summaryText.length);
  return { ok: true, theme, dateKey, stats: { themesReflected: stats.source.themesReflectedCount, sessionsActive: stats.source.sessions.active, productsCreated: stats.products.memory.created, tasks: stats.tasks }, summary: summaryText.slice(0, 300) };
}
