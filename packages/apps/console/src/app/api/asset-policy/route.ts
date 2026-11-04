import { NextResponse } from "next/server";

// 2026-10-26：资产可见性策略的读取代理（console BFF）。
//   上游：mind `GET /api/v1/asset-policy`（公开读，无需 admin key）。
//   为什么在 BFF 里做字段投影：上游响应是"平台 + 三类 + hint"，其中只有
//   mode/selectable/fixedTo/defaultMode 是页面需要的；其余（将来可能出现的
//   agent 级策略等）不应顺手灌给浏览器。投影是白名单，上游加字段不会自动外泄。
export const dynamic = "force-dynamic";

const KINDS = ["memory", "knowledge", "skill"] as const;
type Kind = (typeof KINDS)[number];

interface KindPolicy {
  mode?: string;
  selectable?: boolean;
  fixedTo?: string | null;
  defaultMode?: string | null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export async function GET() {
  try {
    const r = await fetch("http://localhost:3000/api/v1/asset-policy", { cache: "no-store" });
    if (!r.ok) return NextResponse.json({ ok: false, error: "策略暂时取不到" }, { status: 502 });
    const raw = (await r.json()) as Record<string, unknown> & { hint?: string };
    const types: Record<string, KindPolicy> = {};
    for (const k of KINDS) {
      const one = raw[k] as KindPolicy | undefined;
      if (!one) continue;
      types[k] = {
        mode: asString(one.mode) ?? "public",
        selectable: one.selectable === true,
        // fixedTo 与 defaultMode 直接来自后端（前端不假定默认值；后端改默认值只需改一处）
        fixedTo: asString(one.fixedTo),
        defaultMode: asString(one.defaultMode),
      };
    }
    return NextResponse.json({ ok: true, types, hint: typeof raw.hint === "string" ? raw.hint : null });
  } catch {
    return NextResponse.json({ ok: false, error: "策略暂时取不到" }, { status: 502 });
  }
}

// 2026-10-26：切换可见性（POST）。三条约束：
//   1. 只接受 `{kind, mode, confirmed}`，其中 `confirmed` 是"用户在确认弹窗里点了确认"的凭证；
//      **服务端据此替后端补 `acknowledgeOwnerless: true`**（后端 409 语义要求显式确认，不能默认替用户确认）；
//   2. 目标 kind/mode 白名单校验，其它字段一律不透传；
//   3. 后端错误按业务话术回给页面（403/409 分别给"需要管理员"与"需要确认存量影响"）。
export async function POST(req: Request) {
  const allowedKinds = ["memory", "knowledge", "skill"];
  const allowedModes = ["public", "private"];
  let body: { kind?: string; mode?: string; confirmed?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "请求内容无法识别" }, { status: 400 });
  }
  if (!body.kind || !allowedKinds.includes(body.kind)) {
    return NextResponse.json({ ok: false, error: "未知的资产类型" }, { status: 400 });
  }
  if (!body.mode || !allowedModes.includes(body.mode)) {
    return NextResponse.json({ ok: false, error: "未知的可见性选项" }, { status: 400 });
  }
  if (body.confirmed !== true) {
    return NextResponse.json({ ok: false, error: "需要先确认切换的影响范围" }, { status: 400 });
  }
  const key = process.env.MIND_ADMIN_API_KEY;
  if (!key) return NextResponse.json({ ok: false, error: "保存失败：缺少服务端凭据" }, { status: 500 });

  try {
    const r = await fetch("http://localhost:3000/api/v1/asset-policy", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "x-admin-key": key },
      // 用户在确认弹窗点过确认 → 这里补 acknowledgeOwnerless（不是替用户决定，是转达这一事实）
      body: JSON.stringify({ [body.kind]: body.mode, acknowledgeOwnerless: true }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (r.status === 403) {
      return NextResponse.json({ ok: false, error: "保存失败：需要平台管理员权限" }, { status: 403 });
    }
    if (r.status === 409) {
      return NextResponse.json({ ok: false, error: "保存失败：需要确认存量影响后再试" }, { status: 409 });
    }
    if (!r.ok || j.ok === false) {
      return NextResponse.json({ ok: false, error: "保存失败，请重试或联系平台管理员" }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "保存失败，请重试或联系平台管理员" }, { status: 502 });
  }
}
