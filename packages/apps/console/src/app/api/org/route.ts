import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { requirePlatformWrite } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

// 组织架构 BFF (2026-09-21): 代理 mind /api/v1/org
const MIND = "http://localhost:3000/api/v1/org";

export async function GET() {
  // 2026-09-29 (agent-d 休假): 安全 fetch (失败返 502)
  const r = await safeFetchJson(MIND);
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  return NextResponse.json(r.data);
}

export async function POST(req: Request) {
  const body = await req.json();
  const guard = requirePlatformWrite(req as any, "config.write", body as Record<string, unknown>);
  if (!guard.ok) return NextResponse.json(guard.body || { ok: false, error: "写操作未授权" }, { status: guard.status || 401 });
  const r = await safeFetchJson(MIND, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  await writeAudit({
    entityType: "PlatformConfig",
    entityId: String((body as any).id || "org"),
    action: "platform.config.org",
    before: {},
    after: body as Record<string, unknown>,
    actor: { id: guard.actorId || "console-admin", type: "human" },
    changeType: "update",
    confirmed: true,
  });
  return NextResponse.json(r.data);
}
