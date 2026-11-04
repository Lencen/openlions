/**
 * GET /api/v1/client/releases/latest?platform=linux-deb&channel=stable
 *
 * **portal 只调这一个**（只提供最新，不列历史）。
 * 契约：没有已发布的 stable 版本 → **404**（portal 映射为"尚未发布安装包"）。
 * latest 由查询推导，不读任何 latest 字段。
 */
import { NextResponse } from "next/server";
import { findLatest, toPublic, type Channel } from "@/server/client-release";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const platform = sp.get("platform") || undefined;
  const channel = (sp.get("channel") || "stable") as Channel;
  const row = await findLatest(platform, channel);
  if (!row) {
    return NextResponse.json(
      { ok: false, error: "NO_PUBLISHED_RELEASE", detail: "该平台暂无已发布版本（channel=" + channel + "）" },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true, latest: toPublic(row), asOf: new Date().toISOString() });
}
