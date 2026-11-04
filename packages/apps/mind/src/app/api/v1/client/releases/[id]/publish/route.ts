/**
 * POST /api/v1/client/releases/{id}/publish  body: { channel: "stable"|"internal" }
 *
 * 设计 §3：**未签名不得发布** → R3 之前一律 409 UNSIGNED_RELEASE。
 * 不用"先允许、R3 再收紧"：那段时间会产生**对公众可见的未签名 stable 包**，
 * 事后无法区分"当时还没签名"与"签名被绕过"。
 */
import { NextResponse } from "next/server";
import { publishRelease, toPublic, type Channel } from "@/server/client-release";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: { id: string } }) {
  const expected = process.env.MIND_ADMIN_API_KEY;
  if (!expected) return NextResponse.json({ ok: false, error: "MIND_ADMIN_API_KEY not configured on server" }, { status: 500 });
  if ((req.headers.get("x-admin-key") || "") !== expected) {
    return NextResponse.json({ ok: false, error: "invalid or missing x-admin-key (admin only)" }, { status: 401 });
  }
  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  const channel = (String(body?.channel || "stable")) as Channel;
  if (channel !== "stable" && channel !== "internal") {
    return NextResponse.json({ ok: false, error: "INVALID_CHANNEL" }, { status: 400 });
  }
  const r = await publishRelease(ctx.params.id, channel);
  if (!r.ok) {
    const detail = r.error === "UNSIGNED_RELEASE"
      ? "该版本尚未签名（R3 接入签名器后才有 signature），未签名不得发布"
      : undefined;
    return NextResponse.json({ ok: false, error: r.error, detail }, { status: r.status });
  }
  return NextResponse.json({ ok: true, item: toPublic(r.row) });
}
