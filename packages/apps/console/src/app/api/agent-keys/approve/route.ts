import { NextRequest, NextResponse } from "next/server";
import { macsAdminFetch, auditMacsWrite } from "@/lib/server/macs-admin";

export const dynamic = "force-dynamic";

// 批准/拒绝一把 agent key。硬约束（来自契约 §2.3 与后端 msg_d7b81f148ffb4315）：
//   ①admin scope **只能人工审批**，不能自助 → 这里必须有 confirm=true（前端弹二次确认后带上）；
//   ②requiresHumanConfirm=true 时，前端必须**原样展示 impact**，所以后端把 impact 原文回传，前端只渲染；
//   ③拒绝必须写理由（审计需要"为什么拒"）；批准可选写理由；
//   ④审批通过后**同一把 key 立即生效**（缓存全量失效），前端要明确告知操作者。
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const requestId = String(body.requestId || "").trim();
  const decision = String(body.decision || "").trim();
  const note = String(body.note || "").trim();
  const ttlDays = body.ttlDays != null ? Number(body.ttlDays) : undefined;

  if (!requestId) return NextResponse.json({ ok: false, error: "缺少 requestId" }, { status: 400 });
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ ok: false, error: "decision 只能是 approve 或 reject" }, { status: 400 });
  }
  if (decision === "approve" && body.confirm !== true) {
    return NextResponse.json({ ok: false, error: "批准需要二次确认（confirm=true）——批准后同一把 key 立即生效" }, { status: 400 });
  }
  if (decision === "reject" && !note) {
    return NextResponse.json({ ok: false, error: "拒绝必须填写理由（note）" }, { status: 400 });
  }

  const payload: Record<string, unknown> = { requestId, decision };
  if (note) payload.note = note;
  if (Number.isFinite(ttlDays as number) && ttlDays) payload.ttlDays = ttlDays;

  const r = await macsAdminFetch("/api/v1/agent-keys/approve", { method: "POST", body: JSON.stringify(payload) });
  auditMacsWrite({
    action: decision === "approve" ? "agent-key-approve" : "agent-key-reject",
    messageId: requestId,
    result: r.status < 400 ? "ok" : "failed",
    reason: `${decision}${note ? " · " + note : ""}${r.status < 400 ? "" : " · " + ((r.body && r.body.error) || r.status)}`,
  });
  if (r.status >= 400) {
    return NextResponse.json({ ok: false, error: (r.body && r.body.error) || "审批失败", status: r.status }, { status: r.status || 502 });
  }

  // 2026-10-26 实测发现的**静默空操作**：MACS 的 approve 只 `UPDATE` 已存在的 token 行，
  //   对「尚无 token 行的 agent」会返回 ok:true + keyId:"UPDATE 0"（把 SQL 影响行数当成了 keyId），
  //   但库里其实**没有签发任何 key**（实测 agent-fixture-keyspage：agent_tokens 0 行、status.keyId=null）。
  //   界面若照抄成功消息，就等于对操作者撒谎。这里**回查一次 status** 做交叉验证：
  //   拿不到 keyId 时明确降级为 warning，让页面显示"批准已记录，但签发未落库"。
  let verified: { keyId?: string | null; status?: string | null } | null = null;
  let warning: string | null = null;
  if (decision === "approve") {
    const agentId = String((r.body && r.body.agentId) || "").trim();
    if (agentId) {
      const st = await macsAdminFetch("/api/v1/agent-keys/status?agent_id=" + encodeURIComponent(agentId));
      if (st.status < 400 && st.body) {
        verified = { keyId: st.body.keyId ?? null, status: st.body.status ?? null };
        if (!st.body.keyId) {
          warning = "审批已记录，但该执行体名下没有查到有效 key（签发可能未落库）。请让后端核对 approve 的写入路径，不要当成已生效。";
        }
      }
    }
  }
  return NextResponse.json({ ok: true, ...(r.body), verified, warning });
}
