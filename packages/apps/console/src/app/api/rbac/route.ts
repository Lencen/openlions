import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { requirePlatformWrite } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";

export const dynamic = "force-dynamic";
const MIND = "http://localhost:3000/api/v1/rbac";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const agent = u.searchParams.get("agent") || "";
  // 2026-09-29 (agent-d 休假): 安全 fetch (失败返 502)
  const r = await safeFetchJson(MIND + (agent ? "?agent=" + encodeURIComponent(agent) : ""));
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  return NextResponse.json(r.data);
}

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  // 0.4.40-02 批2：/api/rbac 也是平台授权写入口，必须与 agent-permissions 同口径
  const guard = requirePlatformWrite(req, "perm.grant", b as Record<string, unknown>);
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });
  const r = await safeFetchJson(MIND, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  await writeAudit({
    entityType: "PlatformAuth",
    entityId: String((b as any).agent_id || (b as any).agent || "rbac"),
    action: "platform.rbac.update",
    before: {},
    after: b as Record<string, unknown>,
    actor: { id: guard.actorId, type: "human" },
    changeType: "update",
    confirmed: true,
  });
  return NextResponse.json(r.data);
}
