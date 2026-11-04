import { NextRequest, NextResponse } from "next/server";
import { macsAdminFetch } from "@/lib/server/macs-admin";

export const dynamic = "force-dynamic";

// 钥匙状态排障：按 agent 查 scope / 到期 / 自动续期 / 最近 401。
export async function GET(req: NextRequest) {
  const agentId = (req.nextUrl.searchParams.get("agent_id") || "").trim();
  if (!agentId) return NextResponse.json({ ok: false, error: "缺少 agent_id" }, { status: 400 });
  const r = await macsAdminFetch("/api/v1/agent-keys/status?agent_id=" + encodeURIComponent(agentId));
  if (r.status >= 400) {
    return NextResponse.json({ ok: false, error: (r.body && r.body.error) || "查询失败", status: r.status }, { status: r.status || 502 });
  }
  return NextResponse.json({ ok: true, ...(r.body) });
}
