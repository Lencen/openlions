import { NextRequest, NextResponse } from "next/server";

// 2026-10-29 portal 下载代理：只允许下载**latest 且已发布**的包。
// 为什么走代理而不是直链：① 不暴露发布服务内网地址；② 可校验 v 与 latest 一致；
// ③ 未接入时明确 503，而不是把 404 当成"文件不存在"。
export const dynamic = "force-dynamic";

const MIND = process.env.LIONS_MIND_URL || "http://127.0.0.1:3000";

const ALLOWED_PARAMS = new Set(["platform", "v", "version"]);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  // 2026-11-02: 未知参数必须 400, 不能静默忽略。
  // 实测事故: ?version=.23 被忽略 -> 200 返回 latest(.27), 调用方以为拿到 .23。
  for (const key of sp.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return NextResponse.json(
        { ok: false, error: "unknown query parameter: " + key, allowed: Array.from(ALLOWED_PARAMS) },
        { status: 400 }
      );
    }
  }
  const platform = sp.get("platform") || "linux-deb";
  const vParam = sp.get("v") || "";
  const versionParam = sp.get("version") || "";
  // 兼容旧调用方: version 作为 v 的别名; 两者同时给且不一致 -> 400, 不猜。
  if (vParam && versionParam && vParam !== versionParam) {
    return NextResponse.json({ ok: false, error: "v 与 version 不一致" }, { status: 400 });
  }
  const wantVersion = vParam || versionParam;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(`${MIND}/api/v1/client/releases/latest?platform=${encodeURIComponent(platform)}`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!r.ok) {
      // 2026-10-29 21:20 修正：404 要看 body 才能区分"路由不存在"与"业务未接入"
      //   · HTML 404  → 路由未部署（mind 版本太旧）
      //   · JSON 404  → 路由存在，业务上还没有已发布版本（NO_PUBLISHED_RELEASE）
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const isJson = ct.includes("application/json");
      if (!isJson) {
        return NextResponse.json(
          { ok: false, error: "发布服务路由不存在", hint: "mind 未部署客户端发布服务（页面级 404）" },
          { status: 503 }
        );
      }
      let upstream = "";
      try {
        upstream = String(((await r.json()) as Record<string, unknown>)?.error ?? "");
      } catch {
        upstream = "";
      }
      return NextResponse.json(
        {
          ok: false,
          error:
            upstream === "NO_PUBLISHED_RELEASE"
              ? "尚无已发布版本（NO_PUBLISHED_RELEASE）"
              : "发布服务已接入，尚无任何客户端版本（RELEASE_SERVICE_NOT_INTEGRATED）",
          upstream_error: upstream || null,
          hint: "安装包发布并签名后此链接才会生效",
        },
        { status: 503 }
      );
    }
    const b = (await r.json()) as { latest?: { version?: string; download_url?: string; id?: string } };
    const latest = b.latest;
    if (!latest?.download_url && !latest?.id) {
      return NextResponse.json({ ok: false, error: "最新版本缺少下载地址" }, { status: 503 });
    }
    // portal 只允许"最新"：请求里的 v 若与 latest 不一致，拒绝（避免旧链接长期可用）
    if (wantVersion && latest.version && wantVersion !== latest.version) {
      return NextResponse.json({ ok: false, error: `只提供最新版本（当前 ${latest.version}）` }, { status: 409 });
    }
    const url = latest.download_url || `${MIND}/api/v1/client/releases/${latest.id}/download`;
    const dl = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (!dl.ok) return NextResponse.json({ ok: false, error: `下载失败 HTTP ${dl.status}` }, { status: 502 });
    const buf = await dl.arrayBuffer();
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "content-type": dl.headers.get("content-type") || "application/octet-stream",
        "content-disposition": `attachment; filename="${latest.version ?? "client"}.deb"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as { message?: string })?.message || e).slice(0, 100) }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}
