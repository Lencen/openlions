import { NextRequest, NextResponse } from "next/server";
import { openMacs, q } from "@/lib/server/lions-db";
import { macsAdminFetch, auditMacsWrite } from "@/lib/server/macs-admin";
import { requirePlatformWrite } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

// 2026-10-21 未送达队列重放（写操作，admin）。
// 后端契约：POST /api/dlq/replay/{id} —— 把消息改回 pending 并重新入 offline 队列，随后删除 DLQ 行。
// 防呆：必须先确认 DLQ 行存在（只读库），避免对已重放的行重复操作。
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch {}
  const id = String(body.id || "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "缺少队列行 id" }, { status: 400 });
  if (body.confirm !== true) return NextResponse.json({ ok: false, error: "需要二次确认（confirm=true）" }, { status: 400 });
  const guard = requirePlatformWrite(req, "ops.write", body as Record<string, unknown>);
  if (!guard.ok) return NextResponse.json(guard.body || { ok: false, error: "写操作未授权" }, { status: guard.status || 401 });

  const db = openMacs();
  if (!db) return NextResponse.json({ ok: false, error: "MACS 只读库不可用，拒绝执行写操作" }, { status: 503 });
  const rows = await q(db, "SELECT id, message_id, target_agent_id FROM dead_letter_queue WHERE id = ? LIMIT 1", Number(id));
  const row: any = (rows || [])[0];
  if (!row) return NextResponse.json({ ok: false, error: "该队列行不存在（可能已被重放）" }, { status: 404 });

  const r = await macsAdminFetch("/api/dlq/replay/" + encodeURIComponent(id), { method: "POST", body: JSON.stringify({}) });
  auditMacsWrite({ action: "dlq-replay", id, messageId: row.message_id, target: row.target_agent_id, httpStatus: r.status, result: r.status < 300 ? "ok" : "failed", response: r.body });

  // 0.4.40-03 批3：平台审计（uiux 契约）。ops 类操作无法回滚，故审计失败时如实返回 500，
  //   并说明"操作已执行"——不假装没发生（与 model-config 的文件可回滚场景不同）。
  try {
    await writeAudit({
      entityType: "PlatformConfig",
      entityId: String(row.message_id || id),
      action: "platform.ops.dlq_replay",
      before: ({ queued: true }),
      after: ({ replayed: r.status < 300, target: row.target_agent_id }),
      actor: { id: guard.actorId || "console-admin", type: "human" },
      changeType: "update",
      confirmed: true,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "操作已执行，但审计写入失败（fail-closed 上报）", detail: String((e as Error)?.message || e).slice(0, 200) }, { status: 500 });
  }
  return NextResponse.json({ ok: r.status < 300, status: r.status, result: r.body }, { status: r.status < 300 ? 200 : r.status });
}
