import { NextResponse } from "next/server";
import { entityLabel } from "@/config/artifactTypes";
import { openMind, one } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// GET /api/flywheel-health — 平台自我提升体检(诊断卡) 2026-09-08
// 2026-10-21 Phase 2: 改走 PG 连接池（lions-db）
export async function GET() {
  try {
    const mind = openMind();
    const now = Date.now();
    const h24 = now - 86400000;
    const sevenD = now - 7 * 86400000;
    const TABLES = ["Memory", "Knowledge", "Reflection", "Practice", "Skill"];
    const five24: Record<string, number> = {};
    const seven: Record<string, number> = {};
    let lastWriteMs = 0;
    for (const t of TABLES) {
      five24[t] = (await one(mind, "SELECT COUNT(*) c FROM " + t + " WHERE createdAt > $1", h24))?.c ?? 0;
      seven[t] = (await one(mind, "SELECT COUNT(*) c FROM " + t + " WHERE createdAt > $1", sevenD))?.c ?? 0;
      const m = (await one(mind, "SELECT MAX(createdAt) m FROM " + t))?.m || 0;
      if (m > lastWriteMs) lastWriteMs = m;
    }
    if (lastWriteMs > 0 && lastWriteMs < 1e11) lastWriteMs = lastWriteMs * 1000;
    const oneRow = async (sql: string) => (await one(mind, sql)) || {};
    const tasks = {
      pending: (await oneRow("SELECT COUNT(*) c FROM Task WHERE status='PENDING'")).c || 0,
      done: (await oneRow("SELECT COUNT(*) c FROM Task WHERE status='DONE'")).c || 0,
      failed: (await oneRow("SELECT COUNT(*) c FROM Task WHERE status='FAILED'")).c || 0,
      inprogress: (await oneRow("SELECT COUNT(*) c FROM Task WHERE status IN ('IN_PROGRESS','PROCESSING')")).c || 0,
    };
    const execTotal = (await oneRow("SELECT COUNT(*) c FROM TaskExecution")).c || 0;
    const execOk = (await oneRow("SELECT COUNT(*) c FROM TaskExecution WHERE status='COMPLETED'")).c || 0;
    const execFail = execTotal - execOk;
    const execLastRaw = ((await oneRow("SELECT MAX(startedAt) m FROM TaskExecution")).m as any) || 0;
    const execLastMs = execLastRaw > 1e11 ? execLastRaw : execLastRaw * 1000;
    const gapDays = Math.round((now - execLastMs) / 86400000);
    const reflTotal = (await oneRow("SELECT COUNT(*) c FROM Reflection")).c || 0;
    const reflOk = (await oneRow("SELECT COUNT(*) c FROM Reflection WHERE score >= 0.6")).c || 0;
    const reflFail = reflTotal - reflOk;
    const fiveSum = Object.values(five24).reduce((a: number, b: any) => a + (b || 0), 0);
    const verdict: { level: string; text: string }[] = [];
    const fmtT = (ms: number) => { try { return new Date(ms).toLocaleString("zh-CN", { hour12: false }); } catch { return "-"; } };
    if (gapDays > 7) verdict.push({ level: "crit", text: "改进任务执行器已停 " + gapDays + " 天(最后一次执行 " + fmtT(execLastMs) + ") — PENDING 任务堆积 " + tasks.pending.toLocaleString() + " 条" });
    else if (gapDays > 1) verdict.push({ level: "warn", text: "任务执行近 " + gapDays + " 天无活动(PENDING " + tasks.pending.toLocaleString() + ")" });
    else verdict.push({ level: "ok", text: "任务执行链近 " + gapDays + " 天活跃(成功 " + execOk + "/" + execTotal + ")" });
    if (tasks.pending > 10000) verdict.push({ level: "warn", text: "改进任务墙 PENDING " + tasks.pending.toLocaleString() + " 条 — 执行器处理不过来" });
    if (fiveSum < 10) verdict.push({ level: "warn", text: "近 24h 产物仅 " + fiveSum + " 条 — 提炼链路可能停了" });
    return NextResponse.json({
      asOf: new Date().toISOString(),
      five24, seven, lastWriteMs, tasks, exec: { total: execTotal, ok: execOk, fail: execFail, gapDays, lastMs: execLastMs },
      reflection: { total: reflTotal, ok: reflOk, fail: reflFail },
      verdict,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
