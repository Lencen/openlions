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

// 2026-11-20（AGENTS 115 单提交）：失败形状与空形状必须可区分。
//   旧版失败时 spread 这个 EMPTY，于是 count:0/rows:[] 与「真的没有待办」逐字段相同，
//   前端只能靠 HTTP 码猜；而 5 处消费方都写着 Array.isArray(j.rows) -> 失败被渲染成「0 条」。
//   新版：失败时这些字段一律为 **null**（不是 0 / 不是 []），并带 state:"error"。
// 旧的 EMPTY 常量已删除（2026-11-20）：它正是「失败形状 = 空形状」的来源，留着就会被下一个人再 spread 一次。
const FAIL_SHAPE = { ok: false, state: "error" as const, count: null, counts: null, humanOpen: null, rows: null, relatedTasks: null };
// 实测（2026-11-20 04:0x，3004）上游接受的 status 取值只有这几个大写枚举；
//   status=open/all 会**静默返回 count:0**（上游按大写比较），这比 503 更危险：看起来像「没有待办」。
//   => 不在枚举内的取值一律 400，并把允许值打出来（fail-closed，AGENTS 21 同族）。
const STATUS_ENUM = ["ALL", "OPEN", "DOING", "DONE", "CANCELLED", "DROPPED", "BLOCKED"];
// 2026-09-11: mind 的 GET /todos 现在自带 meta(每行) 与 relatedTasks(全响应级, meta.taskIds 的任务摘要),
// 因此原先"只读绕过补 meta"的兜底已删除 (避免双份维护)。

export async function GET(req: Request) {
  const url = new URL(req.url);
  const askedStatus = url.searchParams.get("status");
  if (askedStatus && !STATUS_ENUM.includes(askedStatus)) {
    return NextResponse.json({
      ...FAIL_SHAPE,
      error: "status 取值不在允许集内: " + askedStatus,
      // 2026-11-24 06:17（[team] 裁 a）：**展示层不能当契约层**。
      //   detail 是给人看的（保留，不改），allowed[] 是给机器/判据读的（新增）。
      //   为什么必须分开：detail 会为了人改文案，而改文案的人不知道有个判据在解析它；
      //   判据解析 detail 等于把文案当 API —— 文案一改，判据就静默失效或误红。
      allowed: STATUS_ENUM.slice(),
      detail: "允许值: " + STATUS_ENUM.join(",") + "（小写会被上游静默当作空集，故在此拒绝）",
      asOf: asOf(),
    }, { status: 400 });
  }
  try {
    const { status, data } = await callMind("GET", url.searchParams.toString());
    // F-06 fail-closed（运营团队 2026-11-17 20:40）：上游不可得时**不能返回 200 + count:0**
    //   （前端会把 200 当"空列表"渲染，与"接口坏了"无法区分）。改 503，让 or.ok=false 生效。
    if (!data || status >= 500) {
      return NextResponse.json({
        ...FAIL_SHAPE, asOf: asOf(),
        upstream_status: status,
        // 上游的 detail 带「哪个字段、哪一行」（实测：invalid_timestamp:updatedAt:todo_pltrust_mw32ixux=1794912771280000000）。
        // 旧版把它丢掉，页面只能显示「加载失败」，无法定位 -> 代理层不得吞诊断信息（AGENTS 12）。
        error: data?.error || "mind todos 接口返回 " + status,
        detail: data?.detail,
      }, { status: 503 });
    }
    // 上游返回 ok:false（数据不可得但 HTTP 200）同样视为失败，一并 fail-closed
    if (data.ok === false) {
      return NextResponse.json({
        ...FAIL_SHAPE, asOf: asOf(), upstream_status: status,
        error: data.error || "mind todos 返回 ok:false",
        detail: data.detail,
      }, { status: 503 });
    }
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const counts = Array.isArray(data.counts) ? data.counts : [];
    // count 与 counts 必须同源自洽：过滤到 0 行而 counts 里该状态有 N>0 条 = 上游自相矛盾。
    // 实测（2026-11-20）status=open -> count:0 而 counts 里 OPEN=84，页面会渲染成「没有待办」。
    if (askedStatus && askedStatus !== "ALL" && rows.length === 0) {
      const hit = counts.find((c: any) => String(c?.status) === askedStatus);
      const c = Number(hit?.c || 0);
      if (c > 0) {
        return NextResponse.json({
          ...FAIL_SHAPE, asOf: asOf(),
          error: "上游自相矛盾：status=" + askedStatus + " 返回 0 行，但 counts 说该状态有 " + c + " 条",
          detail: "count=0 / counts[" + askedStatus + "]=" + c,
        }, { status: 502 });
      }
    }
    return NextResponse.json({
      ok: data.ok !== false,
      state: "ok",
      count: data.count ?? rows.length,
      counts,
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
    // F-06 fail-closed：上游不可达同样 503（不是 200+空结构）
    return NextResponse.json({ ...FAIL_SHAPE, asOf: asOf(), error: "mind 服务 (3000) 不可达: " + String(e?.message || e).slice(0, 120) }, { status: 503 });
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
