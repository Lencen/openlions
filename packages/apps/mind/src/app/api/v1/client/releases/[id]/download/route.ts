/**
 * GET /api/v1/client/releases/{id}/download?v=<version>
 *
 * 设计 §5：**只提供最新**。非 latest → 409；未发布 → 409；文件丢失 → 410。
 * `v` 与 latest 不一致 → 409（便于日志归因，与 portal 代理行为一致）。
 */
import { NextResponse } from "next/server";
import { openDownload, createReadStream } from "@/server/client-release";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: { id: string } }) {
  const wantV = new URL(req.url).searchParams.get("v");
  const r = await openDownload(ctx.params.id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, detail: (r as any).detail }, { status: r.status });
  if (wantV && wantV !== r.row.version) {
    return NextResponse.json({ ok: false, error: "VERSION_MISMATCH", detail: "请求 v=" + wantV + " 但 latest=" + r.row.version }, { status: 409 });
  }
  const stream = createReadStream(r.path);
  return new NextResponse(stream as any, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(Number(r.row.sizeBytes) || 0),
      "content-disposition": 'attachment; filename="' + r.row.filename.replace(/"/g, "") + '"',
      "x-client-version": r.row.version,
      "x-client-sha256": r.row.sha256,
    },
  });
}
