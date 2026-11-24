/**
 * POST /api/system/auth/toggle —— 平台写鉴权模式切换（0.6.4 U-56a 批次 A）
 *
 * 作用：切 PLATFORM_WRITE_AUTH（enforce | shadow | off）。
 *
 * 安全设计（比普通配置写更严）：
 *   · 权限：平台守卫的 **auth.manage**（不是 config.write）；
 *   · 二次确认：守卫层已要求 confirm=true / confirmToken；
 *   · 关闭鉴权（off）额外要求 body.acknowledge === "I-understand"（防误点）；
 *   · **env 显式设置 PLATFORM_WRITE_AUTH 时返回 409**：env 永远优先，禁止页面覆盖（避免「页面关了但 env 又开」的假象）；
 *   · 审计实体 PlatformAuth（audit.ts 既有类型），before/after = 模式迁移。
 *
 * 契约：
 *   POST body: { mode:"enforce"|"shadow"|"off", reason:"<必填>", confirm:true, acknowledge?:"I-understand"(off 必填) }
 *   200 { ok, mode, source:"file", auditId, asOf }
 *   400 参数不合法 / 缺 reason / off 缺 acknowledge | 401|403 鉴权失败 | 409 env 锁定 | 503 审计不可写
 *
 * 生效范围：落盘到平台设置文件 write_auth.mode；写守卫在 env 未显式设置时读取它（无需重启）。
 */
import { NextResponse } from "next/server";
import { loadRaw, saveRaw } from "@/lib/server/platform-settings";
import { requirePlatformWrite, writeAuthEnvSet, writeAuthModeWithSource } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";

export const dynamic = "force-dynamic";

const MODES = ["enforce", "shadow", "off"] as const;

function asOf() { return new Date().toISOString(); }

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const g = requirePlatformWrite(req as any, "auth.manage", body);
  if (!g.ok) return NextResponse.json(g.body || { ok: false, error: "未授权" }, { status: g.status || 401 });

  const mode = String(body?.mode || "").toLowerCase();
  if (!(MODES as readonly string[]).includes(mode)) {
    return NextResponse.json({ ok: false, error: "mode 必须是 enforce|shadow|off" }, { status: 400 });
  }
  const reason = String(body?.reason || "").trim();
  if (!reason) return NextResponse.json({ ok: false, error: "缺少变更原因（reason 必填）" }, { status: 400 });
  if (mode === "off" && String(body?.acknowledge || "") !== "I-understand") {
    return NextResponse.json({ ok: false, error: "关闭写鉴权需 acknowledge='I-understand'（防误操作）" }, { status: 400 });
  }
  if (writeAuthEnvSet()) {
    return NextResponse.json({
      ok: false,
      error: "写鉴权模式由环境变量 PLATFORM_WRITE_AUTH 锁定，页面不可覆盖（如需变更请改 env 并重启）",
      current: writeAuthModeWithSource(),
    }, { status: 409 });
  }

  const cur = writeAuthModeWithSource();
  if (cur.mode === mode && cur.source === "file") {
    return NextResponse.json({ ok: false, error: "无变更（当前已是该模式）" }, { status: 400 });
  }

  let auditId: string | undefined;
  try {
    const a = await writeAudit({
      entityType: "PlatformAuth",
      entityId: "platform.write_auth",
      action: "platform.auth.update",
      before: { mode: cur.mode, source: cur.source },
      after: { mode, source: "file" },
      actor: { id: g.actorId || "console-admin", type: "agent" },
      changeType: "update",
      confirmed: body?.confirm === true,
      confirmToken: typeof body?.confirmToken === "string" ? body.confirmToken : undefined,
      extraMetadata: { reason, route: "/api/system/auth/toggle" },
    });
    auditId = a?.id;
    if (!a?.ok && !auditId) {
      return NextResponse.json({ ok: false, error: "审计写入失败，模式未变更（fail-closed）", detail: a?.error }, { status: 503 });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "审计写入失败，模式未变更（fail-closed）", detail: String(e?.message || e).slice(0, 200) }, { status: 503 });
  }

  const r = loadRaw();
  if (!r.ok) return NextResponse.json({ ok: false, error: "读取配置失败: " + (r.error || "unknown"), auditId }, { status: 500 });
  const raw: any = JSON.parse(JSON.stringify(r.raw || {}));
  raw.write_auth = { mode, reason, actor: g.actorId || "console-admin", updatedAt: new Date().toISOString() };
  const w = saveRaw(raw);
  if (!w.ok) return NextResponse.json({ ok: false, error: "写入失败: " + (w.error || "unknown"), auditId }, { status: 500 });

  return NextResponse.json({ ok: true, mode, source: "file", auditId, path: w.path, asOf: asOf() });
}
