import { NextResponse } from "next/server";

// 2026-10-26：切 "私有" 确认弹窗里那句"当前存量中有 N 条"的取数口（console BFF）。
//
// 契约（docs/notes/2026-10-26-asset-visibility-copy-frozen.md §6，五条约束）：
//   1. 窄路由：端点与参数全部服务端写死，**不接受任何客户端 query/header**；
//   2. admin key 只在服务端（MIND_ADMIN_API_KEY），**永不出服务端**；客户端传的一律丢弃；
//   3. 字段投影：只返回三类的存量计数，**不返回** platform / ownedVisibility / agentPolicies；
//   4. 短 TTL 缓存；
//   5. 三级容错：有效→用；过期但上游失败→旧值 + stale=true；无可用值→counts=null。
//      **三种情况都不阻止切换**（切换的正确性由后端 acknowledgeOwnerless 保证，不依赖 N）。
export const dynamic = "force-dynamic";

const KINDS = ["memory", "knowledge", "skill"] as const;
type Kind = (typeof KINDS)[number];

const TTL_MS = 60_000;

type Counts = Record<Kind, number | null>;

interface Cache {
  counts: Counts | null;
  at: number;
}

// 进程内缓存：单实例控制台上够用；多实例各自缓存，最坏差一个 TTL，不影响判定
let cache: Cache = { counts: null, at: 0 };

function emptyCounts(): Counts {
  return { memory: null, knowledge: null, skill: null };
}

/** 只取三类计数；上游其它字段一律不读、不返回 */
function project(raw: unknown): Counts {
  const out = emptyCounts();
  const kinds = (raw as { kinds?: Record<string, { grandfatheredIfPrivate?: unknown }> } | null)?.kinds;
  if (!kinds) return out;
  for (const k of KINDS) {
    const v = kinds[k]?.grandfatheredIfPrivate;
    // 后端口径：number，永远 ≥0，不会是 null；0 表示"没有存量代价"而不是"未知"。
    //   所以这里只在"确实是有限数字"时采信，否则保持 null（未知），绝不补 0。
    out[k] = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  }
  return out;
}

export async function GET() {
  const now = Date.now();
  const fresh = cache.counts !== null && now - cache.at < TTL_MS;
  if (fresh) {
    return NextResponse.json({ ok: true, counts: cache.counts, stale: false, asOf: new Date(cache.at).toISOString() });
  }

  const key = process.env.MIND_ADMIN_API_KEY;
  if (!key) {
    // 没配 key：把它当"取不到"（未知），而不是 0；不阻止切换
    return NextResponse.json({
      ok: true,
      counts: cache.counts,
      stale: cache.counts !== null,
      asOf: cache.counts ? new Date(cache.at).toISOString() : null,
      reason: "缺少服务端凭据，存量条数未知",
    });
  }

  try {
    const r = await fetch("http://localhost:3000/api/v1/asset-policy/stats", {
      cache: "no-store",
      headers: { "x-admin-key": key }, // 只用服务端 env 的 key；不接受客户端传入
    });
    if (!r.ok) throw new Error("upstream " + r.status);
    const counts = project(await r.json());
    cache = { counts, at: now };
    return NextResponse.json({ ok: true, counts, stale: false, asOf: new Date(now).toISOString() });
  } catch {
    // 上游失败：有旧值就返回旧值并标 stale（比"未知"体验好），没有就 counts=null
    return NextResponse.json(
      {
        ok: true,
        counts: cache.counts,
        stale: cache.counts !== null,
        asOf: cache.counts ? new Date(cache.at).toISOString() : null,
        reason: cache.counts ? "上游暂时取不到，显示的是上次结果" : "存量条数未知",
      },
      { status: 200 } // 语义是"页面可用，只是数未知/稍旧"，不用 5xx 吓调用方
    );
  }
}
