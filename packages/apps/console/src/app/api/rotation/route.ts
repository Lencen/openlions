import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { requirePlatformWrite } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

// 2026-10-13 round 76-BM: 把 mind 最后一个**活页面** /rotation 搬进 console
//   (用户决策: console 是唯一管理后台, mind 前端退休)。
//   页面 -> console /system/rotation; 数据与动作 -> 本 BFF -> mind 的 autoRotation.*
const MIND = "http://localhost:3000/api/trpc/autoRotation";

const ACTIONS = new Set(["start", "stop", "runNow", "updateConfig", "generateDailySummary"]);

function pick(d: any) {
  return d?.result?.data ?? null;
}

// GET /api/rotation -> { ok, status, timeline, error }
export async function GET() {
  const [s, t] = await Promise.all([
    safeFetchJson(MIND + ".getStatus?input=%7B%7D"),
    safeFetchJson(MIND + ".getTimeline?input=%7B%7D"),
  ]);
  return NextResponse.json({
    ok: s.ok || t.ok,
    status: s.ok ? pick(s.data) : null,
    timeline: t.ok ? pick(t.data) : null,
    error: s.ok === false ? s.error : null,
  });
}

// POST /api/rotation  { action, payload }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const action = String(body?.action || "");
  if (!ACTIONS.has(action)) return NextResponse.json({ ok: false, error: "未知操作" }, { status: 400 });
  // 0.4.40-03 批3：运维写路由统一鉴权 + 审计
  const guard = requirePlatformWrite(req, "ops.write", body as Record<string, unknown>);
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });
  const r = await safeFetchJson(MIND + "." + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: body?.payload ?? {} }),
  });
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  await writeAudit({
    entityType: "PlatformConfig",
    entityId: "autoRotation",
    action: "platform.rotation." + action,
    before: {},
    after: { action, payload: body?.payload ?? {} },
    actor: { id: guard.actorId, type: "human" },
    changeType: "update",
    confirmed: true,
  });
  return NextResponse.json({ ok: true, data: r.data });
}
