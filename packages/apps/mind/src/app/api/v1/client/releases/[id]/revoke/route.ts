/**
 * POST /api/v1/client/releases/{id}/revoke — 撤销（portal 立即下架）
 * 撤销后 state=revoked、channel 退回 internal、publishedAt 清空 → latest 推导自然不再命中。
 */
import { NextResponse } from "next/server";
import { revokeRelease, toPublic } from "@/server/client-release";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: { id: string } }) {
  const expected = process.env.MIND_ADMIN_API_KEY;
  if (!expected) return NextResponse.json({ ok: false, error: "MIND_ADMIN_API_KEY not configured on server" }, { status: 500 });
  if ((req.headers.get("x-admin-key") || "") !== expected) {
    return NextResponse.json({ ok: false, error: "invalid or missing x-admin-key (admin only)" }, { status: 401 });
  }
  const r = await revokeRelease(ctx.params.id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, item: toPublic(r.row) });
}
