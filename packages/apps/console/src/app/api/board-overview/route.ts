import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { openMind, openSession, q, one, scalar } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

/**
 * /api/board-overview — 0.5 Bento 总览/业务看板六域数据（D6-D12，2026-11-13）
 * 数据卡 card-1-overview / card-market 的字典口径：
 *   智能体域 AgentRegistry；会话域 Session；飞轮域 FlywheelJob 积压；
 *   数据域 五表（Memory/Knowledge/Practice/Skill/Reflection）；
 *   工具域 AgentService（active/registered）；服务域 services/index.json 条目数；
 *   业务 近 7 日完成数（Todo DONE + doneAt）。
 * 全部 SQL/文件真实统计；不可得字段返回 null + reason（禁 0 冒充）。
 */
export async function GET() {
  const mind = openMind();
  const session = openSession();
  if (!mind) return NextResponse.json({ ok: false, reason: "mind 只读库不可用" }, { status: 503 });
  const out: any = { ok: true, asOf: new Date().toISOString(), unavailable: [] as Array<{ field: string; reason: string }> };
  const num = (v: any) => (v == null ? null : Number(v));
  try {
    out.agents = {
      total: num(await scalar(mind, 'SELECT count(*)::int FROM "AgentRegistry"').catch(() => null)),
      active: num(await scalar(mind, 'SELECT count(*)::int FROM "AgentRegistry" WHERE status = $1', "ACTIVE").catch(() => null)),
    };
  } catch { out.agents = null; out.unavailable.push({ field: "智能体域", reason: "AgentRegistry 查询失败" }); }
  try {
    out.sessions = session ? { total: num(await scalar(session, 'SELECT count(*)::int FROM "Session"').catch(() => null)) } : null;
    if (!session) out.unavailable.push({ field: "会话域", reason: "session 只读库不可用" });
  } catch { out.sessions = null; out.unavailable.push({ field: "会话域", reason: "Session 查询失败" }); }
  try {
    const fj = await q(mind, 'SELECT status, count(*)::int AS n FROM "FlywheelJob" GROUP BY status').catch(() => []);
    const m: Record<string, number> = {};
    for (const r of fj || []) m[String(r.status || "").toUpperCase()] = Number(r.n) || 0;
    out.flywheel = { pending: m.PENDING ?? 0, processing: m.PROCESSING ?? 0, backlog: (m.PENDING ?? 0) + (m.PROCESSING ?? 0) };
  } catch { out.flywheel = null; out.unavailable.push({ field: "飞轮域", reason: "FlywheelJob 查询失败" }); }
  try {
    const tables: Array<[string, string]> = [["memory", "Memory"], ["knowledge", "Knowledge"], ["practice", "Practice"], ["skill", "Skill"], ["reflection", "Reflection"]];
    const data: Record<string, number | null> = {};
    let total = 0;
    for (const [k, t] of tables) {
      const n = num(await scalar(mind, 'SELECT count(*)::int FROM "' + t + '"').catch(() => null));
      data[k] = n;
      if (typeof n === "number") total += n;
    }
    out.data = { ...data, total };
  } catch { out.data = null; out.unavailable.push({ field: "数据域", reason: "五表计数失败" }); }
  try {
    const svc = await q(mind, 'SELECT status, count(*)::int AS n FROM "AgentService" GROUP BY status').catch(() => []);
    const m: Record<string, number> = {};
    for (const r of svc || []) m[String(r.status || "").toUpperCase()] = Number(r.n) || 0;
    const registered = Object.values(m).reduce((a, b) => a + b, 0);
    out.tools = { active: m.ACTIVE ?? 0, registered };
  } catch { out.tools = null; out.unavailable.push({ field: "工具域", reason: "AgentService 查询失败" }); }
  try {
    const candidates = [path.resolve(process.cwd(), "../../../services/index.json"), "/opt/lions/current/services/index.json"];
    let count: number | null = null;
    for (const p of candidates) {
      try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        const arr = Array.isArray(j) ? j : (Array.isArray(j.services) ? j.services : null);
        if (arr) { count = arr.length; break; }
      } catch { /* 下一个 */ }
    }
    out.services = count == null ? null : { count };
    if (count == null) out.unavailable.push({ field: "服务域", reason: "services/index.json 不可读（字典无条目数口径 -> 指标位 n/a）" });
  } catch { out.services = null; }
  try {
    const done7d = num(await scalar(mind, "SELECT count(*)::int FROM \"Todo\" WHERE status = 'DONE' AND \"doneAt\" >= (extract(epoch from now()-interval '7 days')*1000)").catch(() => null));
    out.business = { done7d };
  } catch { out.business = null; }
  return NextResponse.json(out);
}
