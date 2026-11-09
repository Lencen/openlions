import { NextRequest, NextResponse } from "next/server";
import { openMacs, q } from "@/lib/server/lions-db";
import { macsAdminFetch, auditMacsWrite } from "@/lib/server/macs-admin";
import { protectedReason } from "@/lib/server/macs-protected";
import { requirePlatformWrite } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

// 2026-10-21 重试投递（写操作）。
// 防呆：① 必须显式 confirm=true（前端二次确认后才发）；
//        ② 先用**只读库**核对状态，只有 pending/expired/failed 放行；delivered/read 直接 409，不调 MACS；
//        ③ 每次调用写审计（谁、哪条、结果）。
const RETRYABLE = new Set(["pending", "expired", "failed"]);

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const messageId = String(body.messageId || "").trim();
  if (!messageId) return NextResponse.json({ ok: false, error: "缺少 messageId" }, { status: 400 });
  if (body.confirm !== true) return NextResponse.json({ ok: false, error: "需要二次确认（confirm=true）" }, { status: 400 });
  const guard = requirePlatformWrite(req, "ops.write", body as Record<string, unknown>);
  if (!guard.ok) return NextResponse.json(guard.body || { ok: false, error: "写操作未授权" }, { status: guard.status || 401 });

  // 0) 保护名单：真实业务消息一律拒绝（后端线指定）
  const guarded = protectedReason(messageId);
  if (guarded) {
    auditMacsWrite({ action: "retry", messageId, result: "blocked", reason: "protected" });
    return NextResponse.json({ ok: false, error: "该消息在保护名单内，禁止重试：" + guarded }, { status: 403 });
  }

  const db = openMacs();
  if (!db) return NextResponse.json({ ok: false, error: "MACS 只读库不可用，拒绝执行写操作" }, { status: 503 });
  const rows = await q(db, "SELECT message_id, delivery_status, processing_state FROM messages WHERE message_id = ? LIMIT 1", messageId);
  const m: any = (rows || [])[0];
  if (!m) return NextResponse.json({ ok: false, error: "消息不存在" }, { status: 404 });
  const st = String(m.delivery_status || "");
  if (!RETRYABLE.has(st)) {
    auditMacsWrite({ action: "retry", messageId, result: "blocked", reason: "status=" + st });
    return NextResponse.json({ ok: false, error: "该消息当前状态为 " + st + "，不允许重试（仅 pending/expired/failed）", status: st }, { status: 409 });
  }

  const r = await macsAdminFetch("/api/messages/" + encodeURIComponent(messageId) + "/retry", { method: "POST", body: JSON.stringify({}) });
  auditMacsWrite({ action: "retry", messageId, status: st, httpStatus: r.status, result: r.status < 300 ? "ok" : "failed", response: r.body });

  // 0.4.40-03 批3：平台审计（uiux 契约）。ops 类操作无法回滚，故审计失败时如实返回 500，
  //   并说明"操作已执行"——不假装没发生（与 model-config 的文件可回滚场景不同）。
  try {
    await writeAudit({
      entityType: "PlatformConfig",
      entityId: messageId,
      action: "platform.ops.retry",
      before: ({ delivery_status: st }),
      after: ({ retried: r.status < 300, httpStatus: r.status }),
      actor: { id: guard.actorId || "console-admin", type: "human" },
      changeType: "update",
      confirmed: true,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "操作已执行，但审计写入失败（fail-closed 上报）", detail: String((e as Error)?.message || e).slice(0, 200) }, { status: 500 });
  }
  return NextResponse.json({ ok: r.status < 300, status: r.status, result: r.body }, { status: r.status < 300 ? 200 : r.status });
}
