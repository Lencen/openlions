import { getAgentCapabilitiesReport, listAgentCapabilitiesReport } from "@/server/pipeline/agent-capabilities";

/**
 * /api/v1/flywheel/agents/capabilities — 2026-09-14 能力自检端点 (提案 cmtwl36jy02bx1j76zndaehd0 落地)。
 *
 * 解决的真实问题: 此前平台无法回答"某 agent 能不能调用平台 API/MCP", 只能派探测任务等 agent 自述;
 *   实测 agent-c / agent-f 回 NO_TOOLS, 而注册表对 agent-f 声明 tools=true ——
 *   声明与观察冲突且都不可复算。本端点把三层事实一次返回, 让冲突变成机器可判定的字段。
 *
 * 用法:
 *   GET /api/v1/flywheel/agents/capabilities                  -> 全量
 *   GET /api/v1/flywheel/agents/capabilities?agentId=agent-x  -> 单个
 * 返回: { ok, count, capabilities: [{ agentId, declared, granted, observed, consistency, verdict, ... }] }
 *   declared = 注册表声明 (T0-T3 + tools/db/file/network)
 *   granted  = AgentServicePermission 实发授权 (mcp / lionsMind / services / tools)
 *   observed = TaskExecution 实证 (completedRuns / noToolsReports / executedEvidenceReports)
 *   consistency: CONFIRMED | DECLARED_UNOBSERVED | SELF_REPORT_NO_TOOLS | NO_OBSERVATION
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agentId = (url.searchParams.get("agentId") || "").trim();
  try {
    if (agentId) {
      const one = await getAgentCapabilitiesReport(agentId);
      return Response.json({ ok: true, count: 1, capabilities: [one] });
    }
    const all = await listAgentCapabilitiesReport();
    return Response.json({ ok: true, count: all.length, capabilities: all });
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
