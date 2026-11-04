import { NextResponse } from "next/server";
import { asOf } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 通用讨论模块代理 (2026-09-10 追加需求)
// 把 console 前端的 /api/discussions 原样转发到 mind:
//   GET  /api/v1/flywheel/discussions?entityType=&entityId=&limit=
//   POST /api/v1/flywheel/discussions  { entityType, entityId, body, authorType?, authorId?, askAgentId? }
// 前端只调 console 自己的路由, 避免跨端口/跨域; 上游不可达时返回空结构 (不 500)。
const MIND_DISCUSSIONS = "http://localhost:3000/api/v1/flywheel/discussions";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const entityType = url.searchParams.get("entityType") || "";
  const entityId = url.searchParams.get("entityId") || "";
  const qs = url.searchParams.toString();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(MIND_DISCUSSIONS + (qs ? "?" + qs : ""), { cache: "no-store", signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      return NextResponse.json({
        ok: false, entityType, entityId, count: 0, rows: [], timeline: [], asOf: asOf(),
        warnings: ["mind discussions 接口返回 " + res.status],
      });
    }
    return NextResponse.json({
      ok: data.ok !== false,
      entityType: data.entityType ?? entityType,
      entityId: data.entityId ?? entityId,
      count: data.count ?? (Array.isArray(data.rows) ? data.rows.length : 0),
      rows: Array.isArray(data.rows) ? data.rows : [],
      timeline: Array.isArray(data.timeline) ? data.timeline : [],
      asOf: data.asOf || asOf(),
      warnings: [],
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false, entityType, entityId, count: 0, rows: [], timeline: [], asOf: asOf(),
      warnings: ["mind 服务 (3000) 不可达: " + String(e?.message || e).slice(0, 120)],
    });
  }
}

export async function POST(req: Request) {
  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  if (!body || !body.entityType || !body.entityId || !String(body.body || "").trim()) {
    return NextResponse.json({ ok: false, error: "需要 entityType + entityId + body" }, { status: 400 });
  }
  // 2026-09-14 修两处实测缺陷(用户反馈: 讨论区为什么还报 [ACTOR_MISLABELED] 自称人类但未声明):
  //   1) 本代理把请求转给 mind 时**丢掉了人类声明头** -> mind 的 resolveActor 判定"自称人类但未声明",
  //      于是记 ACTOR_MISLABELED 并**不计入人类干预**(指标被低估, 讨论区还显示一条吓人的红字);
  //   2) authorId 默认写成 "human:operator", 而 mind 侧还会再拼一次 "human:" 前缀
  //      -> 记录成 "human:human:operator"(讨论区显示的作者名也错)。
  //   现在: 人类身份由浏览器 UI 显式声明并转发(与 todos 代理同一套), authorId 传**裸 id**。
  const isHuman = req.headers.get("x-actor-kind") === "human";
  const actorId = req.headers.get("x-actor-id") || "operator";
  const payload = {
    entityType: String(body.entityType),
    entityId: String(body.entityId),
    body: String(body.body),
    authorType: body.authorType || (isHuman ? "human" : "unknown"),
    authorId: body.authorId || (isHuman ? actorId : undefined),
    askAgentId: body.askAgentId || undefined,
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(MIND_DISCUSSIONS, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isHuman ? { "x-actor-kind": "human", "x-actor-id": actorId } : {}),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      return NextResponse.json(
        { ok: false, error: (data && data.error) || "mind discussions 提交失败 (" + res.status + ")", asOf: asOf() },
        { status: 200 }
      );
    }
    return NextResponse.json({ ...data, asOf: data.asOf || asOf() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "mind 服务 (3000) 不可达: " + String(e?.message || e).slice(0, 120), asOf: asOf() });
  }
}
