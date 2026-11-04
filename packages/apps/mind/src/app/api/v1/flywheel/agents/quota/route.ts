import { listAgentQuotas, resolveQuota, setAgentQuota, DEFAULT_DAILY_LIMIT, BOOTSTRAP_LIMITS } from "@/server/pipeline/agent-quota";
import { realUsage5h } from "@/server/pipeline/llm-real-usage";

/**
 * /api/v1/flywheel/agents/quota — 任务每日额度的**后台配置与查看**入口 (2026-09-14)。
 *
 * 为什么需要它: 额度原先是每台终端 .env 的自律值(散在 7 台机器), 打满即静默停摆、看板上看不见。
 *   现在额度是平台策略, 存在 AgentRegistry.profile.quota, 用这两个口子读与改:
 *     GET  ?agentId=agent-e   -> 单个 agent 的额度明细(含自适应构成)
 *     GET                       -> 全量额度表(含今日用量)
 *     POST { agentId, dailyLimit, mode, note } -> 改配置(立即对下一次认领生效)
 *
 * 语义提醒:
 *   - 额度是**软的每日上限**, 不是"到点关停": adaptive 模式下有地板 floor>0, 永不归零(用户明确要求)。
 *   - 派生额度(limit)由 baseLimit × 余量 × 消耗 × 老化 算出; 想固定不浮动就把 mode 设成 "fixed"。
 *   - 未登记 agent 用平台默认额度(见 GET 返回的 default_daily_limit)与出厂兜底表 BOOTSTRAP_LIMITS。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const agentId = (url.searchParams.get("agentId") || "").trim();
  try {
    if (agentId) {
      const q = await resolveQuota(agentId);
      const real = await realUsage5h(agentId);
      return Response.json({
        ok: true,
        quota: q,
        real: { calls5h: real.totalCalls, byAgent: real.byAgent }, // 2026-09-16 方案A Part2: 真实 MiniMax 用量
      });
    }
    const quotas = await listAgentQuotas();
    const realAll = await realUsage5h();
    return Response.json({
      ok: true,
      default_daily_limit: DEFAULT_DAILY_LIMIT,
      bootstrap_limits: BOOTSTRAP_LIMITS,
      count: quotas.length,
      quotas,
      real: { calls5h: realAll.totalCalls, byAgent: realAll.byAgent }, // 2026-09-16 方案A Part2
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "INVALID_JSON" }, { status: 400 }); }
  const agentId = String(body?.agentId || "").trim();
  if (!agentId) return Response.json({ ok: false, error: "MISSING_AGENT_ID" }, { status: 400 });
  const dailyLimit = body?.dailyLimit != null ? Number(body.dailyLimit) : undefined;
  if (dailyLimit != null && (!Number.isFinite(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000)) {
    return Response.json({ ok: false, error: "INVALID_DAILY_LIMIT", hint: "1..10000 的整数" }, { status: 400 });
  }
  const mode = body?.mode === "fixed" || body?.mode === "adaptive" ? body.mode : undefined;
  if (body?.mode && !mode) return Response.json({ ok: false, error: "INVALID_MODE", hint: "fixed|adaptive" }, { status: 400 });
  try {
    const r = await setAgentQuota(agentId, { dailyLimit, mode, note: body?.note, by: body?.by || "api:admin" });
    if (!r.ok) return Response.json(r, { status: 404 });
    return Response.json({ ok: true, agentId, quota: await resolveQuota(agentId) });
  } catch (e: any) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
