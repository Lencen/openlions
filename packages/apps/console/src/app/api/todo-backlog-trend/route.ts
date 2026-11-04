import { NextResponse } from "next/server";
import { openMind, q, asOf } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-10-20 B7 收尾：/todo 积压趋势。
// 交接文档原判「/todo 没有时序数据，所以不做趋势」—— 复核后**不成立**：
//   Todo 表有 createdAt / doneAt / updatedAt / status，可直接按天复算，
//   不需要 mind 线另开一个时序接口（那条待办可以关掉了）。
//
// 口径（写进响应里的 basis 字段，前端原样展示，避免"看着像却对不上"）：
//   · 新增 = createdAt 落在该日；
//   · 关闭 = doneAt 落在该日；已放弃(DROPPED)且无 doneAt 时用 updatedAt 近似
//     （实测 4079 条 DROPPED 里 4074 条没有 doneAt，只能用 updatedAt）；
//   · 期末积压 = 该日 24:00 之前创建、且当时仍未关闭的条数；
//   · 全程只读（openMind 是 readonly:true），库不可达 -> days=[]，
//     前端显示"暂无时序数据"，**不显示 0**（规范铁律 2：缺失与真的 0 必须分得开）。
const DAY = 86400000;
const WINDOW = 14;
const BASIS =
  "新增=createdAt；关闭=doneAt（终态 DONE/DROPPED 缺 doneAt 时用 updatedAt 近似）；期末积压=该日 24:00 前创建且当时仍未关闭";

export async function GET() {
  const db = openMind();
  let rows: { c: number; d: number | null }[] = [];
  try {
    rows = (await q(db, "SELECT createdAt AS c, doneAt AS d, updatedAt AS u, status AS s FROM Todo"))
      .map((r) => {
        const c = Number(r.c) || 0;
        let d: number | null = null;
        if (r.d != null) d = Number(r.d) || null;
        // 终态但缺 doneAt 的（实测 DROPPED 4074 条、DONE 2 条）用 updatedAt 近似，
        // 否则它们会被当成"永远没关闭"而虚增积压（曾实测虚增 2 条：57 vs 页面活跃 55）。
        else if (String(r.s) === "DROPPED" || String(r.s) === "DONE") d = Number(r.u) || null;
        return { c, d };
      })
      .filter((r) => r.c > 0);
  } catch {
    rows = [];
  }

  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const start = today0.getTime() - (WINDOW - 1) * DAY;

  if (!rows.length) {
    return NextResponse.json({ ok: false, asOf: asOf(), windowDays: WINDOW, days: [], totals: null, basis: BASIS });
  }

  let backlog = rows.filter((r) => r.c < start && (r.d === null || r.d >= start)).length;
  const backlogStart = backlog;
  let addedTotal = 0;
  let closedTotal = 0;
  const days: { date: string; added: number; closed: number; backlog: number }[] = [];
  for (let i = 0; i < WINDOW; i++) {
    const s = start + i * DAY;
    const e = s + DAY;
    const added = rows.filter((r) => r.c >= s && r.c < e).length;
    const closed = rows.filter((r) => r.d !== null && r.d >= s && r.d < e).length;
    backlog = Math.max(0, backlog + added - closed);
    addedTotal += added;
    closedTotal += closed;
    const dd = new Date(s);
    days.push({ date: dd.getMonth() + 1 + "-" + String(dd.getDate()).padStart(2, "0"), added, closed, backlog });
  }

  return NextResponse.json({
    ok: true,
    asOf: asOf(),
    windowDays: WINDOW,
    days,
    totals: { added: addedTotal, closed: closedTotal, backlogStart, backlogEnd: backlog },
    basis: BASIS,
  });
}
