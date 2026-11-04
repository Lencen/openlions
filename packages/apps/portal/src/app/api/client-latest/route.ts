import { NextResponse } from "next/server";

// 2026-10-30 portal 公开元数据：给"要装客户端"的程序一条不受 UI 约束的问路。
// 用途：agent / 运维脚本可以先问版本与 sha256，下载后再校验，避免"下了个不知道是什么的东西"。
// 口径：
//   · 只给 latest（与下载页一致，不暴露历史版本）；
//   · 必须带 sha256 与 size —— 没有校验值的下载地址等于没有完整性保证；
//   · 未发布时返回 503 + 明确原因，不返回空对象冒充"有版本"。
export const dynamic = "force-dynamic";

const MIND = process.env.LIONS_MIND_URL || "http://127.0.0.1:3000";
const SELF = process.env.PORTAL_BASE_URL || "http://127.0.0.1:3006";

export async function GET(req: Request) {
  const platform = new URL(req.url).searchParams.get("platform") || "linux-deb";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(`${MIND}/api/v1/client/releases/latest?platform=${encodeURIComponent(platform)}`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!r.ok) {
      const isJson = ct.includes("application/json");
      let upstream = "";
      if (isJson) {
        try {
          upstream = String(((await r.json()) as Record<string, unknown>)?.error ?? "");
        } catch {
          upstream = "";
        }
      }
      return NextResponse.json(
        {
          ok: false,
          error: !isJson ? "RELEASE_ROUTE_MISSING" : upstream || "NO_PUBLISHED_RELEASE",
          detail: !isJson
            ? "发布服务路由不存在（mind 未部署）"
            : upstream === "RELEASE_SERVICE_NOT_INTEGRATED"
              ? "发布服务已接入，尚无任何客户端版本"
              : "尚无已发布版本",
        },
        { status: 503 }
      );
    }
    const b = (await r.json()) as { latest?: Record<string, unknown> };
    const l = b.latest;
    if (!l) {
      return NextResponse.json({ ok: false, error: "NO_PUBLISHED_RELEASE" }, { status: 503 });
    }
    // latest 里若没有 key_id（当前实现如此），向 verify 补一次——agent 需要知道"用哪把公钥验"
    let keyId = (l.key_id as string) ?? null;
    let signedAt = null as string | null;
    if (!keyId) {
      try {
        const vr = await fetch(`${MIND}/api/v1/client/releases/${String(l.id)}/verify`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
        if (vr.ok) {
          const v = (await vr.json()) as Record<string, unknown>;
          keyId = (v.key_id as string) ?? null;
          signedAt = (v.signed_at as string) ?? null;
        }
      } catch {
        /* 取不到就留空，不编造 */
      }
    }
    return NextResponse.json({
      ok: true,
      version: l.version,
      platform: l.platform,
      arch: l.arch,
      filename: l.filename,
      size: l.sizeBytes ?? l.size ?? null,
      sha256: l.sha256 ?? null,
      key_id: keyId,
      signed: l.signed === true,
      published_at: l.publishedAt ?? l.published_at ?? null,
      signed_at: signedAt,
      download: `${SELF}/api/client-download?platform=${encodeURIComponent(platform)}`,
      verify: `${MIND}/api/v1/client/releases/${String(l.id)}/verify`,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "RELEASE_SERVICE_UNREACHABLE", detail: String((e as { message?: string })?.message || e).slice(0, 100) },
      { status: 503 }
    );
  } finally {
    clearTimeout(timer);
  }
}
