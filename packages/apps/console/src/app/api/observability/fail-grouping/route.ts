import { NextResponse } from "next/server";
import { openMind } from "@/lib/server/lions-db";

// 2026-11-06 · 0.4.32-03/05 可观测性：验收 FAIL 分组（owner / 类型 / 严重度）
// 口径来源：verification/2026-11-06-obs/FAIL-GROUPING-2026-11-06.md
// 硬约束：未知不填 0 —— 取不到就返回 status=unknown + reason，页面显示"取不到"，不是"没有"。
export const dynamic = "force-dynamic";

type Row = { key: string; n: number };
type Resp = {
  status: "ok" | "unknown";
  reason?: string;
  asOf: string;
  window: "7d";
  sinceMs: number;
  totals: { fail7d: number | null; fail24h: number | null; pass7d: number | null; trio: number | null };
  byType: Row[];
  byOwner: Row[];
  bySeverity: Row[];
};

const since = (days: number) => Math.floor(Date.now() - days * 86400 * 1000);

async function rows(pool: any, sql: string, params: unknown[] = []): Promise<Row[]> {
  const r = await pool.query(sql, params);
  return (r.rows || []).map((x: any) => ({ key: String(Object.values(x)[0] ?? "(unknown)"), n: Number(Object.values(x)[1] ?? 0) }));
}

export async function GET() {
  const since7 = since(7);
  const since1 = since(1);
  const base: Resp = {
    status: "ok",
    asOf: new Date().toISOString(),
    window: "7d",
    sinceMs: since7,
    totals: { fail7d: null, fail24h: null, pass7d: null, trio: null },
    byType: [],
    byOwner: [],
    bySeverity: [],
  };
  let pool: any = null;
  try {
    pool = await openMind();
  } catch (e: any) {
    return NextResponse.json({ ...base, status: "unknown", reason: "打不开 lions_mind: " + (e?.message || e) } as Resp);
  }
  try {
    const t = await pool.query(
      `select
         count(*) filter (where verdict='FAIL')::int as fail7d,
         count(*) filter (where verdict='FAIL' and "checkedAt" >= $2)::int as fail24h,
         count(*) filter (where verdict='PASS')::int as pass7d,
         count(*) filter (where verdict='FAIL' and "failsJson"::text like '%evidence-length%')::int as trio
       from "AcceptanceVerdict" where "checkedAt" >= $1`,
      [since7, since1],
    );
    const v = (t.rows && t.rows[0]) || {};
    base.totals = {
      fail7d: v.fail7d ?? null,
      fail24h: v.fail24h ?? null,
      pass7d: v.pass7d ?? null,
      trio: v.trio ?? null,
    };
    base.byType = await rows(
      pool,
      `select "specType", count(*)::int from "AcceptanceVerdict" where verdict='FAIL' and "checkedAt" >= $1 group by 1 order by 2 desc`,
      [since7],
    );
    base.byOwner = await rows(
      pool,
      `select coalesce(t."ownerId",'(unowned)'), count(*)::int
         from "AcceptanceVerdict" a left join "Todo" t on t.id = a."entityId"
        where a.verdict='FAIL' and a."checkedAt" >= $1 group by 1 order by 2 desc`,
      [since7],
    );
    base.bySeverity = await rows(
      pool,
      `select coalesce(t.priority,'(no-todo)'), count(*)::int
         from "AcceptanceVerdict" a left join "Todo" t on t.id = a."entityId"
        where a.verdict='FAIL' and a."checkedAt" >= $1 group by 1 order by 2 desc`,
      [since7],
    );
    return NextResponse.json(base);
  } catch (e: any) {
    return NextResponse.json({ ...base, status: "unknown", reason: "查询失败: " + (e?.message || e) } as Resp);
  }
}
