import { NextRequest, NextResponse } from "next/server";

// 2026-10-29 客户端版本管理（console 读侧）。
// 契约：docs/productization/CLIENT-RELEASE-SERVICE-2026-10-29.md
//   GET {MIND}/api/v1/client/releases?channel=&limit=  → { ok, items[], latest, asOf }
// 关键口径（沿用本仓库纪律）：
//   1. 服务未接入（404/超时）→ available:false + 原因；**不返回空数组冒充"没有版本"**；
//   2. latest 由服务端推导，本页不自己排序挑选；
//   3. 未签名的包必须在列表里可见（否则"未签名"会被误读成"没有这个版本"）。
export const dynamic = "force-dynamic";

const MIND = process.env.LIONS_MIND_URL || "http://127.0.0.1:3000";

export async function GET(req: NextRequest) {
  const channel = req.nextUrl.searchParams.get("channel") || "stable";
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 50) || 50, 200);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(`${MIND}/api/v1/client/releases?channel=${encodeURIComponent(channel)}&limit=${limit}`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (r.status === 404) {
      // 2026-10-29 21:15 修正：status=404 有两种，**必须看 body**才能区分
      //   a) 路由不存在（未部署）→ 返回 HTML（Next 页面级 404）；
      //   b) 路由存在但业务未接入 → 返回 JSON {error:"RELEASE_SERVICE_NOT_INTEGRATED"}。
      // 只看状态码会把 (b) 误报成"服务未接入"，而 (b) 恰恰是契约要求的正确状态。
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      const isJson = ct.includes("application/json");
      if (!isJson) {
        return NextResponse.json({
          ok: true,
          available: false,
          reason: "客户端发布服务路由不存在（mind 未部署该版本，返回的是页面级 404）",
          channel,
          items: [],
          latest: null,
          asOf: new Date().toISOString(),
        });
      }
      let upstreamError = "";
      try {
        upstreamError = String(((await r.json()) as Record<string, unknown>)?.error ?? "");
      } catch {
        upstreamError = "";
      }
      const reason =
        upstreamError === "NO_PUBLISHED_RELEASE"
          ? "发布服务已接入，尚无已发布版本（NO_PUBLISHED_RELEASE）"
          : "发布服务已接入，尚无任何客户端版本记录（RELEASE_SERVICE_NOT_INTEGRATED）";
      return NextResponse.json({
        ok: true,
        available: false,
        reason,
        upstream_error: upstreamError || null,
        channel,
        items: [],
        latest: null,
        asOf: new Date().toISOString(),
      });
    }
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: `上游返回 HTTP ${r.status}` }, { status: 502 });
    }
    const body = (await r.json()) as Record<string, unknown>;
    // 2026-10-30：列表端点不返回 latest（契约里 latest 是独立端点），
    // 这里补一次查询，否则"已发布的版本存在、latest 却显示空"——页面会自相矛盾。
    // 2026-10-30 优先用 latest_id（平台侧同一条 SQL 算出）：在 items 里找 -> 天然同一时点。
    // 找不到时**明确报不一致**，而不是悄悄去补查，避免"列表与 latest 来自两个时点"。
    const items0 = (body.items ?? []) as Array<Record<string, unknown>>;
    const latestId = body.latest_id ?? null;
    let latest: Record<string, unknown> | null = null;
    if (latestId) {
      latest = items0.find((x) => x.id === latestId) ?? null;
      if (!latest) {
        return NextResponse.json({
          ok: true,
          available: true,
          channel,
          items: items0,
          latest: null,
          latest_reason: `LATEST_ID_NOT_IN_ITEMS（latest_id=${String(latestId)} 不在本页 items 中，通常意味着分页或过滤）`,
          latest_id: latestId,
          items_at: String(body.asOf ?? new Date().toISOString()),
          latest_at: null,
        });
      }
    }
    latest = latest ?? ((body.latest as Record<string, unknown> | undefined) ?? null);
    let latestReason: string | null = null;
    // 2026-10-30：补查 latest 会引入"两个时点"。把两侧时点都记下来，
    // 出问题时能立刻确认是不是"列表查完、latest 查之前刚好有人 publish"。
    const itemsAt = String(body.asOf ?? new Date().toISOString());
    let latestAt: string | null = latest ? itemsAt : null;
    if (!latest) {
      try {
        const lr = await fetch(`${MIND}/api/v1/client/releases/latest?platform=linux-deb`, {
          cache: "no-store",
          signal: AbortSignal.timeout(1500),
        });
        latestAt = new Date().toISOString();
        if (lr.ok) {
          const lb = (await lr.json()) as { latest?: Record<string, unknown> };
          latest = lb.latest ?? null;
        } else {
          const t = await lr.text().catch(() => "");
          latestReason = t.includes("NO_PUBLISHED_RELEASE")
            ? "尚无已发布版本（NO_PUBLISHED_RELEASE）"
            : "latest 查询失败";
        }
      } catch {
        latestReason = "latest 查询超时";
      }
    }
    return NextResponse.json({
      ok: true,
      available: true,
      channel,
      // 2026-10-30：把签名事实一并透出（signed/key_id）；若上游未给 key_id，
      // 至少保证 signed 字段原样到达页面，避免页面把"已签"显示成"未签"。
      items: ((body.items ?? []) as Array<Record<string, unknown>>).map((it) => ({
        ...it,
        signed: it.signed === true,
        key_id: it.key_id ?? it.keyId ?? null,
      })),
      latest,
      latest_reason: latestReason,
      items_at: itemsAt,
      latest_at: latestAt,
      asOf: body.asOf ?? new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({
      ok: true,
      available: false,
      reason: `发布服务不可达：${String((e as { message?: string })?.message || e).slice(0, 80)}`,
      channel,
      items: [],
      latest: null,
      asOf: new Date().toISOString(),
    });
  } finally {
    clearTimeout(timer);
  }
}
