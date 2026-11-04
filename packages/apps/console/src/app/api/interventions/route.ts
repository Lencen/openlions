import { NextResponse } from "next/server";
import { asOf, num, openMind, q, safeClose } from "@/lib/server/lions-db";

export const dynamic = "force-dynamic";

// GET /api/interventions
// 代理 mind: GET /api/v1/flywheel/interventions (近 24h 人类干预按类型计数, 用于"真实自主率" north star)
// 额外附上干预明细 (直接只读 mind 库 FlywheelEvent stage=HUMAN_INTERVENTION), 让人类看到"干预了什么"。
// 容错: mind v1 不可达或库缺失时返回空结构 + ok:false, 绝不 500。
export async function GET(req: Request) {
  const warnings: string[] = [];
  let upstream: any = null;
  // 2026-10-13 round 76-DD: 转发顶栏时间范围(③) —— 这个面板原本**硬编码近 24h**,
  //   而它所在的页已消费全局筛选, 于是"页面筛选说近 7 天、这个面板说近 24h"自相矛盾。
  const range = new URL(req.url).searchParams.get("range");
  const qs = range ? "?range=" + encodeURIComponent(range) : "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch("http://localhost:3000/api/v1/flywheel/interventions" + qs, { cache: "no-store", signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) upstream = await res.json();
    else warnings.push("mind /api/v1/flywheel/interventions 返回 " + res.status);
  } catch {
    warnings.push("mind 服务 (3000) 不可达: 干预计数降级为本地只读统计");
  }

  const mind = openMind();
  const rows = await q(
    mind,
    "SELECT id, sourceType, sourceId, sourceTitle, createdAt FROM FlywheelEvent " +
      "WHERE stage='HUMAN_INTERVENTION' ORDER BY createdAt DESC LIMIT 50"
  );
  const recent = rows.map((r) => ({
    id: r.id,
    kind: r.sourceType,
    refId: r.sourceId,
    title: r.sourceTitle,
    at: num(r.createdAt),
  }));
  const localTotal24h = rows.filter((r) => num(r.createdAt) > Date.now() - 24 * 3600 * 1000).length;

  // 上游不可用时用本地 24h 明细兜底
  const byKind = upstream?.byKind?.length
    ? upstream.byKind.map((x: any) => ({ kind: x.k, count: num(x.c) }))
    : Object.entries(
        rows
          .filter((r) => num(r.createdAt) > Date.now() - 24 * 3600 * 1000)
          .reduce((acc: Record<string, number>, r: any) => {
            const k = r.sourceType || "other";
            acc[k] = (acc[k] || 0) + 1;
            return acc;
          }, {})
      ).map(([kind, count]) => ({ kind, count: num(count) }));

  safeClose(mind);
  return NextResponse.json({
    asOf: asOf(),
    ok: upstream ? !!upstream.ok : false,
    source: upstream ? "mind /api/v1/flywheel/interventions" : "local-readonly-fallback",
    windowHours: num(upstream?.windowHours, 24),
    range: upstream?.range ?? null,
    rangeLabel: upstream?.rangeLabel ?? null,
    total: upstream ? num(upstream.total) : localTotal24h,
    byKind,
    recentTotal: rows.length,
    recent,
    warnings,
  });
}
