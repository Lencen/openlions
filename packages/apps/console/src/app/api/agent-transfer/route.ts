import { NextRequest, NextResponse } from "next/server";

import { safeFetchJson, safeStatus } from "@/lib/server/proxy-fetch";
import { requirePlatformWrite } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";
// AI 离开/接手: 数据继承 (agentSource 迁移) - P2-B 2026-09-01
// 转发 mind agent.transferData (adminProcedure, 用 MIND_ADMIN_API_KEY)
export async function POST(req: NextRequest) {
  const body = await req.json();
  // 0.4.40-03 批3：数据继承是平台授权写，必须鉴权 + 审计
  const guard = requirePlatformWrite(req, "agent.manage", body as Record<string, unknown>);
  if (!guard.ok) return NextResponse.json(guard.body || { _error: "写操作未授权" }, { status: guard.status || 401 });
  const adminKey = process.env.MIND_ADMIN_API_KEY || ""  // 2026-09-08 加固: 禁止硬编码默认, 必须由 env 提供;
    const r = await safeFetchJson("http://localhost:3000/api/trpc/agent.transferData", {
    method: "POST",
    headers: {
      "x-admin-key": adminKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (r.ok === false) {
    return NextResponse.json({ _error: r.error }, { status: 502 });
  }
  const data = r.data;
  await writeAudit({
    entityType: "PlatformAuth",
    entityId: String((body as any).from_agent || (body as any).agent_id || "agent-transfer"),
    action: "platform.agent.transfer",
    before: {},
    after: body as Record<string, unknown>,
    actor: { id: guard.actorId || "console-admin", type: "human" },
    changeType: "update",
    confirmed: true,
  });
  return NextResponse.json(data, { status: safeStatus(r.status) });
}
