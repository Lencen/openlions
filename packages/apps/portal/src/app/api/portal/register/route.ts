import { NextRequest, NextResponse } from "next/server";
import { GUIDE_VERSION } from "@/lib/platform-guide";

// POST /api/portal/register — Agent 自助注册 (提交审批)
// 2026-09-02: 走 mind agent.register with approval_mode=self → PENDING
// 管理员在 console approve 后签发服务密钥; 2026-10-15 安全收口: heartbeat **不再匿名返明文密钥**,
//   agent 必须用管理员下发的第一把 key 带 X-API-Key 调 heartbeat 才能取回其余服务密钥。
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { agent_id, display_name, channel, host, profile, services } = body;

  if (!agent_id || !display_name || !channel || !host) {
    return NextResponse.json(
      { ok: false, error: "missing required fields: agent_id, display_name, channel, host" },
      { status: 400 }
    );
  }

  // 走 mind 统一注册 (bootstrap key) — self 模式 → PENDING
  const bootstrapKey = process.env.MIND_BOOTSTRAP_API_KEY || "";
  if (!bootstrapKey) return NextResponse.json({ ok: false, error: "门户未配置接入准入 key（MIND_BOOTSTRAP_API_KEY）" }, { status: 503 });
  const mind = (process.env.LIONS_MIND_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
  try {
    const res = await fetch(mind + "/api/trpc/agent.register", {
      method: "POST",
      headers: {
        "x-bootstrap-key": bootstrapKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        json: {
          agent_id,
          display_name,
          channel,
          host,
          // 2026-09-07: agent 声明想要接入的业务 (可选), 审批页默认按声明预勾选
          profile: {
            ...(profile || {}),
            ...(Array.isArray(services) && services.length > 0 ? { requested_services: services } : {}),
          },
          approval_mode: "self",
          long_term: false,
          idempotent: true,
        },
      }),
    });
    const data = await res.json();
    const inner = data?.result?.data?.json || data?.result?.data || data;
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: inner?.message || "注册失败" }, { status: res.status });
    }
    const consoleUrl = (process.env.LIONS_CONSOLE_URL || "http://127.0.0.1:3004").replace(/\/$/, "");
    return NextResponse.json({
      ok: true,
      pending: true,
      agent: { agent_id, display_name, status: "PENDING" },
      message: "注册已提交, 等待管理员审批。审批通过后管理员会给你一把一次性领取券；用它换正式钥匙。",
      approveUrl: consoleUrl + "/agents/approvals",
      requestedServices: Array.isArray(services) ? services : undefined,
      guideVersion: GUIDE_VERSION,
      guideUrl: "/api/portal/guide?format=json",
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
