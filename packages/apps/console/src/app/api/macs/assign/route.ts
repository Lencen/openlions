import { NextRequest, NextResponse } from "next/server";
import { macsAdminFetch, auditMacsWrite } from "@/lib/server/macs-admin";
import { protectedReason } from "@/lib/server/macs-protected";
import { requirePlatformWrite } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";

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
  const guard = requirePlatformWrite(req, "ops.write", body as Record<string, unknown>);
  if (!guard.ok) return NextResponse.json(guard.body || { ok: false, error: "写操作未授权" }, { status: guard.status || 401 });
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

  // 0.4.40-03 批3：平台审计（uiux 契约）。ops 类操作无法回滚，故审计失败时如实返回 500，
  //   并说明"操作已执行"——不假装没发生（与 model-config 的文件可回滚场景不同）。
  try {
    await writeAudit({
      entityType: "PlatformConfig",
      entityId: messageId,
      action: "platform.ops.assign",
      before: ({ assignedTo: "(previous)" }),
      after: ({ assignedTo, note, httpStatus: r.status }),
      actor: { id: guard.actorId || "console-admin", type: "human" },
      changeType: "update",
      confirmed: true,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "操作已执行，但审计写入失败（fail-closed 上报）", detail: String((e as Error)?.message || e).slice(0, 200) }, { status: 500 });
  }
  return NextResponse.json({ ok: r.status < 300, status: r.status, result: r.body }, { status: r.status < 300 ? 200 : r.status });
}
