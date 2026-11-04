/**
 * GET  /api/v1/client/releases  — 列表（console 用）：版本/平台/架构/大小/签名/状态/通道/发布时间
 * POST /api/v1/client/releases  — 上传登记（R2 不签名，落 draft）
 *   可选 form 字段 `manifest`（JSON 文本或文件）：给了就做交叉校验（版本/sha256/尺寸/版本四元），
 *   不自洽一律拒（400 请求不合法 / 409 与清单声明冲突）。见 server/client-release.ts。
 *
 * 契约（消费侧已实现，后端必须对齐）:
 *   - `latest` 不存字段，由查询推导（见 server/client-release.ts）；
 *   - **没有任何版本时返回 404**，不返回 `{items:[]}` —— 空数组会被消费侧读成"发布过 0 个版本"，
 *     而 404 才表示"未接入 / 尚未发布"。
 */
import { NextResponse } from "next/server";
import {
  countReleases, listReleases, createRelease, toPublic, validateReleaseManifest,
  PLATFORMS, type Platform, type Channel,
} from "@/server/client-release";

export const dynamic = "force-dynamic";

function adminOk(req: Request): true | NextResponse {
  const expected = process.env.MIND_ADMIN_API_KEY;
  if (!expected) return NextResponse.json({ ok: false, error: "MIND_ADMIN_API_KEY not configured on server" }, { status: 500 });
  const got = req.headers.get("x-admin-key") || "";
  if (got !== expected) return NextResponse.json({ ok: false, error: "invalid or missing x-admin-key (admin only)" }, { status: 401 });
  return true;
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const channel = (sp.get("channel") as Channel) || undefined;
  const platform = sp.get("platform") || undefined;
  const limit = Number(sp.get("limit") || 50);

  const n = await countReleases();
  // 契约 2：没有版本 → 404（不是空数组）
  if (n === 0) return NextResponse.json({ ok: false, error: "RELEASE_SERVICE_NOT_INTEGRATED", detail: "尚无任何客户端版本记录" }, { status: 404 });

  const items = await listReleases({ channel, platform, limit });
  return NextResponse.json({ ok: true, items: items.map(toPublic), total: n, asOf: new Date().toISOString() });
}

export async function POST(req: Request) {
  const gate = adminOk(req);
  if (gate !== true) return gate;

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ ok: false, error: "INVALID_FORM" }, { status: 400 }); }

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "MISSING_FILE" }, { status: 400 });

  const version = String(form.get("version") || "").trim();
  const platform = String(form.get("platform") || "").trim() as Platform;
  const arch = String(form.get("arch") || "amd64").trim();
  const notes = form.get("notes") ? String(form.get("notes")) : null;
  const channel = (String(form.get("channel") || "stable") as Channel);

  const buf = Buffer.from(await file.arrayBuffer());

  // manifest 交叉校验（2026-10-30）：给了 manifest 就必须自洽 —— 见 server/client-release.ts 的判定顺序。
  // 以前这个字段被**静默忽略**，所以"清单承诺的字节"与"实际签名的字节"可以不是同一份而无人报错。
  let manifestChecked: string[] | null = null;
  const rawManifest = form.get("manifest");
  if (rawManifest != null) {
    let parsed: unknown;
    try {
      parsed = rawManifest instanceof File ? JSON.parse(await rawManifest.text()) : JSON.parse(String(rawManifest));
    } catch {
      return NextResponse.json({ ok: false, error: "INVALID_MANIFEST", detail: "manifest 不是合法 JSON" }, { status: 400 });
    }
    const verdict = validateReleaseManifest({ manifest: parsed, buf, filename: file.name, formVersion: version });
    if (!verdict.ok) {
      return NextResponse.json({ ok: false, error: verdict.error, detail: verdict.detail }, { status: verdict.status });
    }
    manifestChecked = verdict.checked;
  }

  const r = await createRelease({ version, platform, arch, filename: file.name, buf, notes, channel, createdBy: "console-admin" });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, detail: r.detail }, { status: r.status });
  return NextResponse.json({
    ok: true, item: toPublic(r.row), signed: false,
    manifestVerified: manifestChecked, // null = 未提供 manifest；非空 = 已交叉校验过哪些维度
    note: "R2：尚未接入签名器，state=draft，不可发布",
  }, { status: 201 });
}
