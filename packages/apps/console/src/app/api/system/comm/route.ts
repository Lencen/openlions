import { NextRequest, NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";
import { requireFeature } from "@/lib/server/license-gate";

// GET /api/system/comm — 通信服务 (macs) 管理数据
// 2026-09-07: 平台化 macs 管理 — agent 授权(平台) + macs 服务/在线/会话
// ?view=messages&conversation_id=xxx — 返回单会话消息 (像 session 详情)
const MIND_TRPC = "http://localhost:3000/api/trpc";
const MIND_ADMIN = process.env.MIND_ADMIN_API_KEY || ""  // 2026-09-08 加固: 禁止硬编码默认, 必须由 env 提供;
const MACS = process.env.MACS_URL || "http://127.0.0.1:8765";
const MACS_KEY = process.env.HERMES_MCP_API_KEY || "";

async function macsFetch(path: string) {
  const r = await safeFetchJson(`${MACS}${path}`, { headers: { "x-api-key": MACS_KEY }, timeoutMs: 4000 });
  if (!r.ok) return null;
  return r.data;
}

export async function GET(req: NextRequest) {
  // 2026-10-27（S2 门禁）：MACS 协作是收费面 macs.collab；**MACS 进程内部面不在此门**（那是内部/管理面）。
  const denied = await requireFeature("macs.collab");
  if (denied) return denied;
  try {
    const sp = req.nextUrl.searchParams;
    const view = sp.get("view");
    const convId = sp.get("conversation_id");

    // 消息视图: 单会话消息 (像 session 详情)
    if (view === "messages" && convId) {
      const msgs = await macsFetch(`/api/messages?conversation_id=${encodeURIComponent(convId)}`);
      return NextResponse.json({ messages: msgs?.messages || msgs || [] });
    }

    // 会话列表视图: 全对话
    if (view === "conversations") {
      const convs = await macsFetch("/api/conversations/all");
      return NextResponse.json({ conversations: convs?.conversations || [], count: convs?.count || 0 });
    }

    // 默认视图: 服务状态 + 授权矩阵 + 在线 + 统计
    const r = await safeFetchJson(`${MIND_TRPC}/agent.list?input=%7B%22json%22%3Anull%7D`, { headers: { "x-admin-key": MIND_ADMIN } });
    const data = r.ok ? r.data : null;
    const agents = data?.result?.data?.json || data?.result?.data || [];

    let macsHealth: any = null;
    try {
      const h = await fetch(`${MACS}/health`, { cache: "no-store" as any, signal: AbortSignal.timeout(4000) });
      macsHealth = { code: h.status, body: h.ok ? await h.json() : null };
    } catch (e: any) { macsHealth = { code: 0, error: String(e?.message || e) }; }

    // /api/agents 返回 {agents:[...]}, 归一化为数组
    const macsAgentsRaw: any = (await macsFetch("/api/agents")) || {};
    const macsAgents: any[] = Array.isArray(macsAgentsRaw) ? macsAgentsRaw : (macsAgentsRaw?.agents || macsAgentsRaw?.items || []);
    const macsStats = await macsFetch("/api/stats");
    const convs = await macsFetch("/api/conversations/all");

    const mcpAgents = (agents || []).filter((a: any) => {
      const perms = a?.permissions || [];
      return perms.some((p: any) => p.service_name === "mcp_agent_chat");
    }).map((a: any) => {
      const mPerm = (a?.permissions || []).find((p: any) => p.service_name === "mcp_agent_chat");
      const mAgent = (macsAgents || []).find((m: any) => (m.agent_id || m.agentId) === a.agent_id);
      return {
        agent_id: a.agent_id, display_name: a.display_name, status: a.status,
        mcp_auth: mPerm?.status || "NONE",
        macs_status: mAgent?.status || (mAgent ? "registered" : "not_registered"),
        last_seen: mAgent?.last_seen || null,
      };
    });

    return NextResponse.json({
      macs: macsHealth, macs_agents: macsAgents, macs_stats: macsStats,
      conversations: convs?.conversations || [], conv_count: convs?.count || 0,
      mcp_agents: mcpAgents,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

// POST /api/system/comm/send — 运营者与某 agent 的会话
// 2026-10-27 修两处（商业化线 P0）：
//   ① **收费写操作必须有授权门**：原来 GET 有 macs.collab 门、POST 没有 → 未授权也能发消息（写操作裸奔）。
//      现在 POST 最前面同样 requireFeature，未授权/未知一律 402，且**不产生任何副作用**（不调 MACS）。
//   ② **不再写死具体人名**：原 sender_id 硬编码 "operator"（真实运营者身份），客户版不能 ship 一个具体人名。
//      改为 `LIONS_OPERATOR_ID`（或 `MACS_OPERATOR_ID`）环境变量；未配置时**拒绝发送并说明**，
//      而不是退回某个默认人名 —— 用错身份发出去比不发更糟（审计归属会错）。
export async function POST(req: NextRequest) {
  // ① 授权门：放在最前面，失败即返回，绝不触达 MACS
  const denied = await requireFeature("macs.collab");
  if (denied) return denied;
  const OPERATOR = String(process.env.LIONS_OPERATOR_ID || process.env.MACS_OPERATOR_ID || "").trim();
  if (!OPERATOR) {
    // ② 不猜身份：明确告诉部署方要配什么，而不是用默认人名
    return NextResponse.json(
      { error: "OPERATOR_NOT_CONFIGURED", detail: "未配置运营者身份（LIONS_OPERATOR_ID），为避免审计归属错误，已拒绝发送" },
      { status: 503 }
    );
  }
  try {
    const body = await req.json().catch(() => null);
    const to = String(body?.to || "").trim();
    const text = String(body?.text || "").trim();
    if (!to || !text) return NextResponse.json({ error: "to/text 必填" }, { status: 400 });
    const target = to.startsWith("@") ? to : "@" + to;
    if (!MACS_KEY) return NextResponse.json({ error: "HERMES_MCP_API_KEY 未配置" }, { status: 503 });
    const r = await fetch(`${MACS}/api/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": MACS_KEY },
      body: JSON.stringify({ sender_id: OPERATOR, to: target, text, message_type: "p2p_text" }),
      cache: "no-store" as any,
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    console.log("[comm/send] operator", OPERATOR, "->", target, "status", r.status, "msg", data?.message_id || data?.error || "");
    if (!r.ok) return NextResponse.json({ error: data?.error || `macs ${r.status}` }, { status: 502 });
    return NextResponse.json({ ok: true, sender: OPERATOR, ...data });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
