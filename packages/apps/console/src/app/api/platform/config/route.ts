/**
 * GET|PUT /api/platform/config —— 平台配置读写（0.6.4 U-56a 批次 A）
 *
 * 为什么新建而不复用 /api/platform-settings：
 *   U-56a 要求「可写」必须带 reason + before/after 审计，而 platform-settings 的 PATCH 只有白名单校验、无审计无 reason。
 *   本路由 = 读（复用 loadSettings）+ 写（守卫 + reason + 审计 + 落盘），语义专用于「配置变更」。
 *
 * 契约：
 *   GET  200 { ok, settings, source, asOf, authMode, authModeSource }
 *   PUT  headers: x-platform-admin-token（PLATFORM_WRITE_AUTH=enforce 时必需）, x-actor 可选
 *        body: { patch:{...}, team_language?:"auto|zh-CN|en-US", reason:"<必填>", confirm:true }
 *        200 { ok, settings, changed:[...], auditId, path, asOf }
 *        400 缺 reason / patch 非法 / 无变更 / 缺二次确认
 *        401|403 鉴权失败 | 503 审计不可写（fail-closed，回滚不落盘）
 *
 * 顺序（fail-closed）：守卫 -> reason -> 校验 -> 算 after -> **先写审计** -> 再落盘。
 *   审计写不出时直接 503，配置不落盘（与 audit.ts「先审计后落盘才叫 fail-closed」一致）。
 */
import { NextResponse } from "next/server";
import { loadSettings, loadRaw, saveRaw, mergeWithDefaults, validatePatch } from "@/lib/server/platform-settings";
import { requirePlatformWrite, writeAuthModeWithSource } from "@/lib/server/platform-write-guard";
import { writeAudit } from "@/lib/server/audit";
import { diffOnly } from "@/lib/server/audit-core";

export const dynamic = "force-dynamic";

function asOf() { return new Date().toISOString(); }

export async function GET() {
  const r = loadSettings();
  const m = writeAuthModeWithSource();
  return NextResponse.json({
    ok: r.ok,
    settings: r.settings,
    source: r.source,
    error: r.error,
    authMode: m.mode,
    authModeSource: m.source,
    asOf: asOf(),
  });
}

export async function PUT(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const g = requirePlatformWrite(req as any, "config.write", body);
  if (!g.ok) return NextResponse.json(g.body || { ok: false, error: "未授权" }, { status: g.status || 401 });

  const reason = String(body?.reason || "").trim();
  if (!reason) return NextResponse.json({ ok: false, error: "缺少变更原因（reason 必填，用于审计留痕）" }, { status: 400 });

  // 2026-11-18 devops 实测 bug：validatePatch 只接受「扁平 agent_team 字段 + 顶级 team_language」，
  //   而 PUT 契约 body 里必然带 reason/confirm（守卫要求）-> 原实现把 reason/confirm 当「未知字段」全部拒绝，
  //   导致合法写请求结构上不可能成功（400 校验失败）。
  //   修法：先剥离 metadata，再展开 patch；无 patch 时按扁平写法兼容（便于 curl 直调）。
  const META_KEYS = new Set(["reason", "confirm", "confirmToken", "patch", "actor"]);
  let patchInput: any;
  if (body && body.patch !== undefined) {
    if (typeof body.patch !== "object" || body.patch === null || Array.isArray(body.patch)) {
      return NextResponse.json({ ok: false, error: "patch 必须是对象" }, { status: 400 });
    }
    patchInput = Object.assign({}, body.patch);
    if (body.team_language !== undefined) patchInput.team_language = body.team_language;
  } else {
    patchInput = {};
    for (const [k, val] of Object.entries(body || {})) if (!META_KEYS.has(k)) patchInput[k] = val;
  }
  const v = validatePatch(patchInput);
  if (!v.ok) return NextResponse.json({ ok: false, error: "校验失败", errors: v.errors }, { status: 400 });

  const beforeR = loadRaw();
  if (!beforeR.ok) return NextResponse.json({ ok: false, error: "读取现有配置失败: " + (beforeR.error || "unknown") }, { status: 500 });
  const before: any = JSON.parse(JSON.stringify(beforeR.raw || {}));
  // 与 platform-settings PATCH 同语义：只替换 agent_team（保留未知顶层键），team_language 显式给出才写
  const after: any = JSON.parse(JSON.stringify(before));
  const base: any = (before.agent_team && typeof before.agent_team === "object") ? JSON.parse(JSON.stringify(before.agent_team)) : {};
  Object.assign(base, v.patch);
  after.agent_team = mergeWithDefaults({ agent_team: base }).agent_team;
  if (v.topLevel && v.topLevel.team_language !== undefined) after.team_language = v.topLevel.team_language;

  const diff = diffOnly(before, after);
  if (!diff.keys.length) return NextResponse.json({ ok: false, error: "无变更（patch 与原值相同）" }, { status: 400 });

  // 先审计（fail-closed）：写不出直接 503，配置不落盘
  let auditId: string | undefined;
  try {
    const a = await writeAudit({
      entityType: "PlatformConfig",
      entityId: "platform-settings",
      action: "platform.config.update",
      before,
      after,
      actor: { id: g.actorId || "console-admin", type: "agent" },
      changeType: "update",
      confirmed: body?.confirm === true,
      confirmToken: typeof body?.confirmToken === "string" ? body.confirmToken : undefined,
      extraMetadata: { reason, route: "/api/platform/config" },
    });
    auditId = a?.id;
    if (!a?.ok && !auditId) {
      return NextResponse.json({ ok: false, error: "审计写入失败，配置未变更（fail-closed）", detail: a?.error }, { status: 503 });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "审计写入失败，配置未变更（fail-closed）", detail: String(e?.message || e).slice(0, 200) }, { status: 503 });
  }

  const w = saveRaw(after);
  if (!w.ok) return NextResponse.json({ ok: false, error: "写入失败: " + (w.error || "unknown"), auditId }, { status: 500 });

  const readback = loadSettings();
  return NextResponse.json({ ok: true, settings: readback.settings, changed: diff.keys, auditId, path: w.path, asOf: asOf() });
}
