import { NextResponse } from "next/server";
import { openMind, q, asOf } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-20 业务环（人类：首页只画了"生产"，没有"消费"，流程不完整）。
// 一条完整的业务环是：会话接入 → 认知落库 → 飞轮加工 → 任务派发
//                    → 上下文注入（认知被取用）→ 模型调用（消费算力）→ 产出回填（学到的东西回流）→ 人决策
// 本接口只做一件事：把这条环上每一环的**近 24 小时事件量**与**该环最后一条事件**查出来（只读）。
// 口径：以 FlywheelEvent.stage 计数；时间窗 = 近 24h（毫秒时间戳）。
// 缺表/缺列一律返回空结构，前端显示"暂无数据"，不显示 0（规范铁律 2）。
const WINDOW_MS = 24 * 3600 * 1000;

// 环上每一跳 -> 一个或多个事件 stage（业务说法见 label）
const HOPS: { id: string; label: string; stages: string[] }[] = [
  { id: "inject", label: "上下文注入（认知被取用）", stages: ["CONTEXT_INJECTED"] },
  { id: "llm", label: "模型调用（消费算力）", stages: ["CALL_LLM", "LLM_USE_REAL"] },
  { id: "backfill", label: "产出回填（学到的东西回流）", stages: ["LEARN", "REFLECT"] },
  { id: "task", label: "任务派发与执行", stages: ["TASK_REVIVED", "SUBMIT_EVIDENCE_REJECTED", "SUBMIT_CLAIMS_REJECTED"] },
  { id: "extract", label: "会话提炼", stages: ["SESSION_EXTRACT"] },
  { id: "decision", label: "人决策", stages: ["TODO_STATUS", "TODO_CLAIMED"] },
];

export async function GET() {
  const db = openMind();
  const since = Date.now() - WINDOW_MS;
  let rows: any[] = [];
  try {
    rows = await q(db, "SELECT stage, COUNT(*) AS c FROM FlywheelEvent WHERE createdAt >= ? GROUP BY stage", since);
  } catch {
    rows = [];
  }
  const counts: Record<string, number> = {};
  for (const r of rows) counts[String(r.stage)] = Number(r.c) || 0;

  let last: any = null;
  try {
    const one = await q(db, "SELECT stage, sourceType, sourceTitle, createdAt FROM FlywheelEvent ORDER BY createdAt DESC LIMIT 1");
    last = one[0] || null;
  } catch { last = null; }

  // 每个环节的"上一条数据"：该环涉及 stage 里最近的一条（前端显示在节点里，让人看到真实数据在动）
  // 推 / 拉 两侧：推=平台在 claim/开场时注入上下文；拉=agent 自己发起调用（sourceType=agent:*）
  let injected = 0, agentCalls = 0, platformCalls = 0, contextUsed = 0, outputsIngested = 0;
  try {
    const one = async (sql: string) => (await q(db, sql, since))[0];
    injected = Number((await one("SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CONTEXT_INJECTED' AND createdAt >= ?"))?.c) || 0;
    agentCalls = Number((await one("SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CALL_LLM' AND sourceType LIKE 'agent:%' AND createdAt >= ?"))?.c) || 0;
    platformCalls = Number((await one("SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CALL_LLM' AND sourceType LIKE 'platform:%' AND createdAt >= ?"))?.c) || 0;
    contextUsed = Number((await one("SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CONTEXT_USED' AND createdAt >= ?"))?.c) || 0;
    outputsIngested = Number((await one("SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='AGENT_OUTPUT_INGESTED' AND createdAt >= ?"))?.c) || 0;
  } catch { /* 字段缺失按 0，前端会显示"—" */ }
  let byAgent: { agent: string; n: number }[] = [];
  try {
    byAgent = (await q(db, "SELECT substr(sourceType,7) AS agent, COUNT(*) AS n FROM FlywheelEvent WHERE stage='CALL_LLM' AND sourceType LIKE 'agent:%' AND createdAt >= ? GROUP BY agent ORDER BY n DESC LIMIT 6", since))
      .map((r) => ({ agent: String(r.agent || ""), n: Number(r.n) || 0 }));
  } catch { byAgent = []; }

  const hops = await Promise.all(HOPS.map(async (h) => {
    let lastHop: any = null;
    try {
      const ph = h.stages.map(() => "?").join(",");
      const rows2 = await q(db, "SELECT stage, sourceType, sourceTitle, createdAt FROM FlywheelEvent WHERE stage IN (" + ph + ") ORDER BY createdAt DESC LIMIT 1", ...h.stages);
      lastHop = rows2[0] || null;
    } catch { lastHop = null; }
    return {
      id: h.id,
      label: h.label,
      stages: h.stages,
      n24: h.stages.reduce((acc, s) => acc + (counts[s] || 0), 0),
      last: lastHop
        ? {
            stage: lastHop.stage,
            sourceType: lastHop.sourceType,
            title: String(lastHop.sourceTitle || "").slice(0, 40),
            ageSec: lastHop.createdAt ? Math.max(0, Math.round((Date.now() - Number(lastHop.createdAt)) / 1000)) : null,
          }
        : null,
    };
  }));

  return NextResponse.json({
    ok: rows.length > 0,
    asOf: asOf(),
    windowHours: 24,
    hops,
    push: { injected },
    pull: { agentCalls, platformCalls, contextUsed, outputsIngested, byAgent },
    raw: counts,
    last: last
      ? { stage: last.stage, sourceType: last.sourceType, title: String(last.sourceTitle || "").slice(0, 60), at: Number(last.createdAt) || null, ageSec: last.createdAt ? Math.max(0, Math.round((Date.now() - Number(last.createdAt)) / 1000)) : null }
      : null,
  });
}