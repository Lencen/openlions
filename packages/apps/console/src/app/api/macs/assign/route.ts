import { NextRequest, NextResponse } from "next/server";
import { macsAdminFetch, auditMacsWrite } from "@/lib/server/macs-admin";
import { protectedReason } from "@/lib/server/macs-protected";

export const dynamic = "force-dynamic";

// 2026-10-21 改派负责人（写操作，admin）。
// 防呆：必须 confirm=true + note 非空（审计需要"为什么改派"）；每次写审计。
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const messageId = String(body.messageId || "").trim();
  const assignedTo = String(body.assignedTo || "").trim();
  const note = String(body.note || "").trim();
  if (!messageId || !assignedTo) return NextResponse.json({ ok: false, error: "缺少 messageId 或 assignedTo" }, { status: 400 });
  if (body.confirm !== true) return NextResponse.json({ ok: false, error: "需要二次确认（confirm=true）" }, { status: 400 });
  if (!note) return NextResponse.json({ ok: false, error: "改派必须填写原因（note）" }, { status: 400 });
  const guarded = protectedReason(messageId);
  if (guarded) {
    auditMacsWrite({ action: "assign", messageId, result: "blocked", reason: "protected" });
    return NextResponse.json({ ok: false, error: "该消息在保护名单内，禁止改派：" + guarded }, { status: 403 });
  }

  const r = await macsAdminFetch("/api/messages/" + encodeURIComponent(messageId) + "/assign", {
    method: "POST",
    body: JSON.stringify({ assigned_to: assignedTo, note }),
  });
  auditMacsWrite({ action: "assign", messageId, assignedTo, note, httpStatus: r.status, result: r.status < 300 ? "ok" : "failed", response: r.body });
  return NextResponse.json({ ok: r.status < 300, status: r.status, result: r.body }, { status: r.status < 300 ? 200 : r.status });
}
