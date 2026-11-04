import { getAgentCapabilitiesReport } from "@/server/pipeline/agent-capabilities";

/**
 * /api/v1/agents/[id]/capabilities — 提案原文指定的路径形态 (提案 cmtwl36jy02bx1j76zndaehd0)。
 *
 * 提案写的是 `GET /api/agents/:id/capabilities`; 平台现有版本化约定是 /api/v1/...,
 * 故本路由作为**别名**与 /api/v1/flywheel/agents/capabilities?agentId= 同源同构,
 * 两者共用 server/pipeline/agent-capabilities.ts 的数据层, 避免两份实现分叉。
 *
 * 返回: { ok, agentId, mcp, lions_mind, tools, declared, granted, observed, consistency, verdict }
 *   mcp / lions_mind / tools 是提案要求的扁平字段, declared/granted/observed 是三层证据。
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const agentId = decodeURIComponent(String(ctx?.params?.id || "")).trim();
  if (!agentId) {
    return Response.json({ ok: false, error: "MISSING_AGENT_ID" }, { status: 400 });
  }
  try {
    const r = await getAgentCapabilitiesReport(agentId);
    return Response.json({
      ok: true,
      agentId: r.agentId,
      // 提案要求的三项扁平字段(直接可用)
      mcp: r.granted.mcp,
      lions_mind: r.granted.lionsMind,
      tools: r.granted.tools,
      declared: r.declared,
      granted: r.granted,
      observed: r.observed,
      consistency: r.consistency,
      verdict: r.verdict,
      authoritativeFor: r.authoritativeFor,
      checkedAt: r.checkedAt,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
