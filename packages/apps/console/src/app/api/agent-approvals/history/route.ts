import { NextRequest, NextResponse } from "next/server";

import { safeFetchJson } from "@/lib/server/proxy-fetch";
// GET /api/agent-approvals/history — 审批记录/操作日志 (长期保留, 审计用)
// 2026-09-03: 从 mind AuditLog 拉 AGENT 生命周期操作 (REGISTER_REQUEST/APPROVE/REJECT/REVOKE/GRANT_API_KEY)

const TRPC = "http://localhost:3000/api/trpc";
const ADMIN = process.env.MIND_ADMIN_API_KEY || ""  // 2026-09-08 加固: env 必须配置, 禁硬编码默认;

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const agentId = sp.get("agent_id") || "";
    const action = sp.get("action") || "";
    const limit = Math.min(parseInt(sp.get("limit") || "200"), 200);
    const input: any = { entityType: "AGENT", limit };
    if (agentId) input.agent_id = agentId;
    if (action) input.action = action;
    const enc = encodeURIComponent(JSON.stringify({ json: input }));
      const r = await safeFetchJson(`${TRPC}/agent.auditList?input=${enc}`, { headers: { "x-admin-key": ADMIN } });
  if (r.ok === false) {
    return NextResponse.json({ _error: r.error }, { status: 502 });
  }
  const data = r.data;    const rows = data?.result?.data || [];
    return NextResponse.json(Array.isArray(rows) ? rows : []);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
