import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { asOf } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// 2026-09-10 TODO 独立实体: console 代理 (前端只调 /api/todos)
//   GET   /api/todos?status=&ownerType=&ownerId=&source=&limit=
//   POST  /api/todos { title, detail?, source?, sourceRefId?, ownerType?, ownerId?, priority?, dueAt?, evidence?, createdBy? }
//   PATCH /api/todos { id, status?, ownerType?, ownerId?, priority?, dueAt?, note?, doneBy? }
// 上游: mind /api/v1/flywheel/todos。上游不可达时 GET 返回空结构 (不 500), POST/PATCH 返回 ok:false + error。
const MIND_TODOS = "http://localhost:3000/api/v1/flywheel/todos";

async function callMind(method: "GET" | "POST" | "PATCH", query: string, body?: any, extraHeaders?: Record<string, string>) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), method === "GET" ? 8000 : 15000);
  try {
    const res = await fetch(MIND_TODOS + (query ? "?" + query : ""), {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(extraHeaders || {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

const EMPTY = { ok: false, count: 0, counts: [], humanOpen: 0, rows: [], relatedTasks: [] };
// 2026-09-11: mind 的 GET /todos 现在自带 meta(每行) 与 relatedTasks(全响应级, meta.taskIds 的任务摘要),
// 因此原先"只读绕过补 meta"的兜底已删除 (避免双份维护)。

export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    const { status, data } = await callMind("GET", url.searchParams.toString());
    if (!data || status >= 500) {
      return NextResponse.json({
        ...EMPTY, asOf: asOf(),
        error: data?.error || "mind todos 接口返回 " + status,
      });
    }
    const rows = Array.isArray(data.rows) ? data.rows : [];
    return NextResponse.json({
      ok: data.ok !== false,
      count: data.count ?? rows.length,
      counts: Array.isArray(data.counts) ? data.counts : [],
      humanOpen: data.humanOpen ?? 0,
      // 2026-09-24 验收可见性: rows 内已含 acceptance/taskAcceptance/acceptanceState, 这里透传汇总
      acceptanceCounts: data.acceptanceCounts || { PASS: 0, FAIL: 0, PENDING: 0 },
      doneWithFailedTask: data.doneWithFailedTask ?? 0,
      rows,
      // 关联任务摘要 (全响应级 union, 前端按各待办 meta.taskIds 过滤)
      relatedTasks: Array.isArray(data.relatedTasks) ? data.relatedTasks : [],
      error: data.error,
      asOf: data.asOf || asOf(),
    });
  } catch (e: any) {
    return NextResponse.json({ ...EMPTY, asOf: asOf(), error: "mind 服务 (3000) 不可达: " + String(e?.message || e).slice(0, 120) });
  }
}

export async function POST(req: Request) {
  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  if (!body || !String(body.title || "").trim()) {
    return NextResponse.json({ ok: false, error: "需要 title" }, { status: 400 });
  }
  try {
    // 2026-09-11 (任务 cmtw9qgcq00jg1j7603hr98ed): 不再无条件写 createdBy=human:operator ——
    //   脚本经本代理写入时会被记成"人类操作", 污染 PL-AUTONOMY。只有浏览器 UI 显式声明
    //   x-actor-kind: human 时才按人类记名, 否则按 system 记名。
    const isHuman = req.headers.get("x-actor-kind") === "human";
    const { status, data } = await callMind("POST", "", {
      ...body,
      createdBy: isHuman ? "human:operator" : "system:console",
      authorType: isHuman ? "human" : "system",
    }, isHuman ? { "x-actor-kind": "human" } : undefined);
    if (!data) return NextResponse.json({ ok: false, error: "mind 返回空响应 (" + status + ")" });
    return NextResponse.json({ ...data, asOf: data.asOf || asOf() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "mind 服务 (3000) 不可达: " + String(e?.message || e).slice(0, 120) });
  }
}

export async function PATCH(req: Request) {
  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  if (!body || !body.id) return NextResponse.json({ ok: false, error: "需要 id" }, { status: 400 });
  try {
    // 2026-09-11: 同 POST —— 人类记名必须是浏览器 UI 的显式声明, 不能是代理的默认值
    const isHuman = req.headers.get("x-actor-kind") === "human";
    // 2026-09-14: 人类身份带真实 id (原来写死 human:operator, 记不出"是哪个人")
    const actorId = req.headers.get("x-actor-id") || "operator";
    const { status, data } = await callMind("PATCH", "", {
      ...body,
      by: isHuman ? "human:" + actorId : "system:console",
      doneBy: isHuman ? "human:" + actorId : undefined,
    }, isHuman ? { "x-actor-kind": "human" } : undefined);
    if (!data) return NextResponse.json({ ok: false, error: "mind 返回空响应 (" + status + ")" });
    return NextResponse.json({ ...data, asOf: data.asOf || asOf() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "mind 服务 (3000) 不可达: " + String(e?.message || e).slice(0, 120) });
  }
}
