import { NextResponse } from "next/server";

/**
 * GET /api/decisions —— 决策治理列表（0.6.3 U-19，frontend 侧只读透传）
 *
 * 口径（与 platform-data 对齐中，先按 fail-closed 实现）：
 *   · 后端决策库未就绪 -> **503 + 原因**（不返回 200+空数组，同 F-06/U-02 口径）
 *   · 后端就绪 -> 透传 rows（字段契约见 run/0.6.3 立项 U-19）
 *   · 后端地址用 DECISIONS_API_BASE 覆盖（默认指向平台内部 API）
 */
/**
 * 上游地址：
 *   · DECISIONS_API_BASE 显式设置 -> 用设置值（跨进程/跨端口部署）
 *   · 未设置 -> 默认指向**同应用**的 decisions-core（platform-data 31351c990 已落在 console 内）
 *     -> 这样 dev/prod 无需额外 env 即可打通；跨服务部署时再设 env
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
  const url = new URL(req.url);
  const status = url.searchParams.get("status") || "";
  const limit = url.searchParams.get("limit") || "50";
  const asOf = new Date().toISOString();
  const UPSTREAM = upstreamOf(req);

  if (!UPSTREAM) {
    // 503 契约按 platform-data 02:46 确认：{ok:false, reason}（同时保留 error 供既有判据/页面读取）
    const reason = "决策库未接入（DECISIONS_API_BASE 未设；等待 platform-data U-19 后端就绪）";
    return NextResponse.json({ ok: false, reason, error: reason }, { status: 503 });
  }
  try {
    const qs = new URLSearchParams({ limit });
    if (status) qs.set("status", status);
    const r = await fetch(UPSTREAM + "/decisions?" + qs.toString(), { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json({ ok: false, error: "无权限读取决策库" }, { status: 403 });
    }
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: "决策库返回 " + r.status }, { status: 503 });
    }
    const j = await r.json();
    const rows = Array.isArray(j) ? j : Array.isArray(j?.rows) ? j.rows : null;
    if (!rows) {
      return NextResponse.json({ ok: false, error: "决策库返回格式不符（期望 rows 数组）" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, rows, asOf });
  } catch (e) {
    const reason = "决策库请求失败：" + String((e as Error)?.message || e).slice(0, 120);
    return NextResponse.json({ ok: false, reason, error: reason }, { status: 503 });
  }
}