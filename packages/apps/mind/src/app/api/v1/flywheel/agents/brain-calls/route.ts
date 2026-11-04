/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * /api/v1/flywheel/agents/brain-calls — 盲区兜底: responder 上报"真实大脑调用次数"
 *
 * 落地来源 (2026-09-16, todo_7r2gqo8bzm3ib967):
 *   平台 FlywheelEvent.stage='CALL_LLM' 原本只覆盖: 平台内部 pipeline (cognitive-extractor 等)
 *   + agent 在 task_submit 时自报的 usage。**盲区** = responder 在 handle_inbound / 任务路径
 *   调 brain_hermes / brain_openclaw / brain_llm / brain_exec / brain_spool 时的真实调用 —
 *   这些根本没进 CALL_LLM, 平台对配额是"瞎的"。
 *   实测 llm-usage-real.cjs: 真实 652 次 vs 平台可见 143 次, 盲区 509 次 (78%)。
 *
 * 设计:
 *   - responder 在 call_brain() 后本地累加 (ok/empty/errors/calls), 每 ~60s 批量 POST 上报
 *   - 后端只做一件事: 把 batch 折成 N 条 FlywheelEvent(stage='CALL_LLM', sourceType='agent:<id>'
 *     sourceTitle 携带 entry/ok/empty 标记, targetStage OK|FAIL:EMPTY|FAIL:ERROR)
 *   - 字段最小化, 不存 prompt 内容, 不存 token 估算(用户可在 caller 后续追加 token)
 *
 * 安全:
 *   - 仅写自家表, 限速: 单次 batch 上限 500 条
 *   - agentId 仅作 sourceType 标识, 不做权限校验 (responder 已在 bridge 鉴权过)
 */

import { prisma } from "@/lib/prisma";
import { expandBrainCallEntries } from "@/server/pipeline/llm-calls-5h";

const MAX_BATCH = 500;

export async function POST(req: Request) {
  let body: {
    agentId?: string;
    /** 2026-10-11 PL-COST: responder 上报的本轮累计真实调用数(见 batch 汇总占位) */
    calls?: number;
    batch?: Array<{
      ts?: number;
      brainType?: string;
      ok?: boolean;
      empty?: boolean;
      error?: boolean;
      taskId?: string;
    }>;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "INVALID_JSON" }, { status: 400 });
  }
  const agentId = String(body.agentId || "").trim();
  if (!agentId) {
    return Response.json({ ok: false, error: "MISSING_AGENT_ID" }, { status: 400 });
  }
  const batch = Array.isArray(body.batch) ? body.batch.slice(0, MAX_BATCH) : [];
  // 2026-10-11 PL-COST 机制修复(任务 cmv2wvi5u02y9rbs1yj6o57v2):
  //   responder flush_brain_call_stat() 把**本轮累计真实调用数**放在 top-level `calls`
  //   (macs_responder.py:154; batch 只带 1 条汇总占位), 而旧实现只遍历 batch
  //   => 每次 flush 只写 1 条 CALL_LLM, 聚合次数被丢弃。实测: journalctl 每轮
  //   "brain_call_stat flush OK: written=1"(与真实 calls 无关); 真实 666 次/5h vs 平台可见 58 次。
  //   修复: 显式 `calls` 存在时按其值落 N 条(每次调用 1 条), 使 PL-COST 的 COUNT(*) 口径与真实
  //   用量对齐, 并回报 declared/truncated 便于对账。无 `calls` 时保持旧的逐条语义(向后兼容)。
  const declared = Number.isFinite(Number(body.calls)) ? Math.trunc(Number(body.calls)) : 0;
  const { entries, truncated } = expandBrainCallEntries(batch, declared, MAX_BATCH);
  if (entries.length === 0) {
    return Response.json({ ok: true, written: 0, note: "空 batch" });
  }

  const sourceType = "agent:" + agentId;
  let written = 0;
  let failed = 0;
  // 单条失败不阻塞整批; 但也不把整批回滚 — FlywheelEvent 是 append-only 观测流
  for (const e of entries) {
    const ts = Number(e.ts || Date.now());
    const brainType = String(e.brainType || "unknown").slice(0, 40);
    const ok = e.ok === true;
    const empty = e.empty === true;
    const error = e.error === true;
    const targetStage = ok ? "OK" : (empty ? "FAIL:EMPTY" : (error ? "FAIL:ERROR" : "FAIL:UNKNOWN"));
    const title = "brain=" + brainType + " ok=" + String(ok) + " empty=" + String(empty) + " err=" + String(error) + " entry=agent-brain-call";
    try {
      await prisma.flywheelEvent.create({
        data: {
          stage: "CALL_LLM",
          sourceType,
          sourceId: String(ts),
          sourceTitle: title.slice(0, 300),
          targetStage,
        },
      });
      written += 1;
    } catch (e: any) {
      failed += 1;
      // 单条失败继续, 不抛错
      console.warn("[brain-calls] write failed: " + String(e?.message || e).slice(0, 80));
    }
  }
  return Response.json({ ok: true, written, failed, total: entries.length, declared, truncated });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agentId = (url.searchParams.get("agentId") || "").trim();
  const hours = Math.min(Math.max(parseInt(url.searchParams.get("hours") || "5", 10), 1), 168);
  const since = Date.now() - hours * 3600 * 1000;
  try {
    const where: any = { stage: "CALL_LLM", createdAt: { gte: since } };
    if (agentId) where.sourceType = "agent:" + agentId;
    const rows = await prisma.flywheelEvent.findMany({
      where,
      select: { sourceType: true, targetStage: true, createdAt: true, sourceTitle: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const byAgent: Record<string, { calls: number; ok: number; empty: number; error: number }> = {};
    for (const r of rows) {
      const k = r.sourceType;
      const b = byAgent[k] || { calls: 0, ok: 0, empty: 0, error: 0 };
      b.calls += 1;
      if (r.targetStage === "OK") b.ok += 1;
      else if (r.targetStage === "FAIL:EMPTY") b.empty += 1;
      else if (r.targetStage === "FAIL:ERROR") b.error += 1;
      byAgent[k] = b;
    }
    return Response.json({
      ok: true,
      hours,
      totalRows: rows.length,
      byAgent,
      sample: rows.slice(0, 10),
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
