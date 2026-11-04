import { NextRequest, NextResponse } from "next/server";

// 2026-10-15 round-78: 读实时数据(上游 mind agent.pendingList 待审批列表)的 BFF, 且本文件导出 POST
//   (hasNonStaticMethods -> 构建期必然 bailout 成动态)。显式声明以统一口径/防回归。
export const dynamic = "force-dynamic";

// GET /api/agent-approvals — 待审批 agent 列表 (PENDING)
// POST /api/agent-approvals — { action: 'approve'|'reject', agent_id }
// 2026-09-02: 管理员审批流 (portal 自助注册 → PENDING → 这里审批)

const TRPC = (process.env.LIONS_MIND_URL || "http://127.0.0.1:3000").replace(/\/$/, "") + "/api/trpc";
const ADMIN = process.env.MIND_ADMIN_API_KEY || ""  // 2026-09-08 加固: 禁止硬编码默认, 必须由 env 提供;

async function callTrpc(path: string, body?: any) {
  const init: any = { cache: "no-store" as any };
  if (body) {
    init.method = "POST";
    init.headers = { "x-admin-key": ADMIN, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  } else {
    init.headers = { "x-admin-key": ADMIN };
  }
  const res = await fetch(`${TRPC}/${path}`, init);
  const data = await res.json();
  const r = data?.result?.data?.json || data?.result?.data || data;
  if (!res.ok) {
    const err = typeof r === "object" && r ? (r as any).message || (r as any).error?.message : r;
    throw new Error(String(err || "内部接口调用失败"));
  }
  return r;
}

export async function GET() {
  try {
    const list = await callTrpc("agent.pendingList?input=%7B%22json%22%3Anull%7D");
    return NextResponse.json(list || []);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { action, agent_id, services } = body;
    if (!action || !agent_id) return NextResponse.json({ error: "missing action or agent_id" }, { status: 400 });
    if (action !== "approve" && action !== "reject") return NextResponse.json({ error: "action must be approve|reject" }, { status: 400 });
    const proc = action === "approve" ? "agent.approve" : "agent.reject";
    const result = await callTrpc(proc, { json: action === "approve" ? { agent_id, services: services || undefined } : { agent_id } });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
