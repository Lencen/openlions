/**
 * GET /api/v1/client/releases/{id}/verify — 公开、只读的签名验证（R3）
 *
 * 为什么需要它：console 里标"已签名"只是**数据库自称**；用公钥对**盘上字节**验签，
 * 才能回答"这个包现在还是当初签的那份内容吗"。portal 将来可显示"已验证签名"。
 *
 * 返回 { valid, key_id, signed_at, sha256 }；未签名/文件缺失/未知 key 都返回 valid:false + reason。
 */
import { NextResponse } from "next/server";
import { getRelease } from "@/server/client-release";
import { verifyBytes, loadPublicKeyById } from "@/server/client-release-signing";
import { readFileSync, existsSync } from "node:fs";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const row = await getRelease(ctx.params.id);
  if (!row) return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });

  const base = { id: row.id, version: row.version, platform: row.platform, arch: row.arch, sha256: row.sha256 };

  if (!row.signature) {
    return NextResponse.json({ ok: true, ...base, valid: false, reason: "NOT_SIGNED" });
  }
  if (!row.signedBy) {
    return NextResponse.json({ ok: true, ...base, valid: false, reason: "MISSING_KEY_ID" });
  }
  const pub = loadPublicKeyById(row.signedBy);
  if (!pub) {
    return NextResponse.json({ ok: true, ...base, valid: false, reason: "UNKNOWN_KEY_ID", key_id: row.signedBy });
  }
  const p = row.storagePath || "";
  if (!p || !existsSync(p)) {
    return NextResponse.json({ ok: true, ...base, valid: false, reason: "FILE_MISSING", key_id: row.signedBy });
  }
  const buf = readFileSync(p);
  const r = verifyBytes(buf, row.signature, row.signedBy);
  return NextResponse.json({
    ok: true, ...base,
    valid: r.valid,
    key_id: row.signedBy,
    signed_at: (row as any).signedAt || row.publishedAt,
    ...(r.valid ? {} : { reason: r.reason }),
  });
}
