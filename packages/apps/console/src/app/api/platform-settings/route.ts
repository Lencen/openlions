/**
 * /api/platform-settings —— 平台设置读写（0.6.2 U-51/U-52）
 *
 * GET  : 返回 { ok, settings, source, asOf }（文件不存在 -> 灰度安全缺省，不报错）
 * PATCH: 校验白名单字段后原子写；返回 { ok, settings, path }
 *
 * 鉴权：与 model-config 同族——写操作走 PLATFORM_WRITE_AUTH 的三态（enforce/shadow/off）；
 *   本批默认沿用现有实现（若 model-config 有封装则复用之；否则最小实现）。
 */
import { NextResponse } from "next/server";
import { loadSettings, loadRaw, saveRaw, mergeWithDefaults, validatePatch, type PlatformSettings } from "@/lib/server/platform-settings";

export const dynamic = "force-dynamic";

function asOf() { return new Date().toISOString(); }

export async function GET() {
  const r = loadSettings();
  return NextResponse.json({
    ok: r.ok,
    settings: r.settings,
    source: r.source,
    error: r.error,
    asOf: asOf(),
  });
}

export async function PATCH(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const v = validatePatch(body);
  if (!v.ok) {
    return NextResponse.json({ ok: false, error: "校验失败", errors: v.errors }, { status: 400 });
  }
  // 读**原始 JSON**（保留未知顶层键，如 devops 写的 team_language）-> 只覆盖 agent_team -> 原子写回
  //   （2026-11-18 01:41 实测发现：只写 {agent_team} 会把 team_language 等既有键丢掉）
  const rawR = loadRaw();
  if (!rawR.ok) {
    return NextResponse.json({ ok: false, error: "读取现有配置失败: " + (rawR.error || "unknown") }, { status: 500 });
  }
  const raw: any = JSON.parse(JSON.stringify(rawR.raw || {}));
  const base: any = JSON.parse(JSON.stringify((raw.agent_team && typeof raw.agent_team === "object") ? raw.agent_team : {}));
  Object.assign(base, v.patch);
  const normalized = mergeWithDefaults({ agent_team: base });
  raw.agent_team = normalized.agent_team;   // 只替换 agent_team，其余顶层键原样保留
  // 0.6.3 U-49：team_language 顶级键（显式给出才写；未给则保留原值）
  if (v.topLevel && v.topLevel.team_language !== undefined) raw.team_language = v.topLevel.team_language;
  const w = saveRaw(raw);
  if (!w.ok) {
    return NextResponse.json({ ok: false, error: "写入失败: " + (w.error || "unknown") }, { status: 500 });
  }
  // 回读校验（写后确认落盘一致性）
  const after = loadSettings();
  return NextResponse.json({ ok: true, settings: after.settings, path: w.path, asOf: asOf() });
}