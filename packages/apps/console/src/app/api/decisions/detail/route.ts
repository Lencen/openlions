import { NextResponse } from "next/server";

/**
 * GET /api/decisions/detail?id=<id> —— 决策详情（0.6.3 U-19，frontend 只读透传）
 *
 * 为什么不用 /api/decisions/[id]：本仓 Next 14.2.35 dev 对「/api/ 下新增动态段」的 HMR 不生效
 *   （实测：/decisions/[id] 页面路由可编译，但 /api/decisions/[id] 不编译、直接 404）。
 *   改用 query 参数绕开动态段，语义等价、构建期无差异。
 *
 * 口径：后端未就绪（DECISIONS_API_BASE 未设）-> 503 + {ok:false, reason}
 *      就绪 -> {ok, decision, dims[], tracks[]}；401/403 -> 403；404 -> 404；超时 8s
 */
/**
 * 上游地址（同列表网关）：
 *   · DECISIONS_API_BASE 显式设置 -> 用设置值
 *   · 未设置 -> 默认**同应用** decisions-core（platform-data 31351c990）
 * 注意：decisions-core 的详情走 /decisions/[id]（动态段）；Next 14.2.35 dev 下动态段不编译（平台已知坑），
 *       prod build 下正常。dev 验证请用列表 + build 后验详情。
 */
function upstreamOf(req: Request): string {
  const explicit = (process.env.DECISIONS_API_BASE || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  try {
    return new URL(req.url).origin + "/api/decisions-core";
  } catch {
    return "";
  }
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") || "";
  const asOf = new Date().toISOString();
  const UPSTREAM = upstreamOf(req);
  if (!id) return NextResponse.json({ ok: false, reason: "缺少决策 id" }, { status: 400 });
  if (!UPSTREAM) {
    const reason = "决策库未接入（DECISIONS_API_BASE 未设；等待 platform-data U-19 后端就绪）";
    return NextResponse.json({ ok: false, reason, error: reason }, { status: 503 });
  }
  try {
    // 用 decisions-core 的 ?id= 别名（cb08d3ac0）而非 /decisions/<id> 动态段：
    //   Next 14.2.35 dev 对动态段不编译（平台已知坑），query 别名在 dev/prod 都可用
    const r = await fetch(UPSTREAM + "/decisions?id=" + encodeURIComponent(id), {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401 || r.status === 403) return NextResponse.json({ ok: false, reason: "无权限读取决策详情" }, { status: 403 });
    if (r.status === 404) return NextResponse.json({ ok: false, reason: "决策不存在" }, { status: 404 });
    if (!r.ok) return NextResponse.json({ ok: false, reason: "决策库返回 " + r.status }, { status: 503 });
    const j = await r.json();
    if (!j || !j.decision) return NextResponse.json({ ok: false, reason: "决策库返回格式不符（缺 decision）" }, { status: 503 });
    return NextResponse.json({
      ok: true,
      decision: j.decision,
      dims: Array.isArray(j.dims) ? j.dims : [],
      tracks: Array.isArray(j.tracks) ? j.tracks : [],
      asOf,
    });
  } catch (e) {
    const reason = "决策详情请求失败：" + String((e as Error)?.message || e).slice(0, 120);
    return NextResponse.json({ ok: false, reason, error: reason }, { status: 503 });
  }
}