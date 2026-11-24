import { NextResponse } from "next/server";
import { asOf, qStrict, openMind, safeClose } from "@/lib/server/lions-db";

/**
 * GET /api/decisions-core/decisions —— U-19 决策库后端（0.6.3，[team]）
 *
 * 这是**数据源后端**，由 console 的 /api/decisions 代理消费（frontend 侧透传层）。
 * 部署时把 DECISIONS_API_BASE 指向 http://127.0.0.1:<port>/api/decisions-core 即可。
 *
 * 契约（严格 fail-closed）：
 *   200 { ok:true, rows:[...], asOf }
 *   503 { ok:false, reason }   —— 库/表不可用或查询失败（**绝不 200+空数组**）
 *
 * 为什么用 qStrict 而不是 q：q() 会把查询失败吞成 []，表不存在时会伪装成「没有决策」。
 *   这正是 2026-11-16/17 三例「catch 吞错 -> 假 0」同族，故本路由统一用 qStrict（失败 throw -> 503）。
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const idParam = url.searchParams.get("id") || "";
  const status = url.searchParams.get("status") || "";
  const limit = Math.min(Number(url.searchParams.get("limit") || "50") || 50, 500);
  const mind = openMind();
  if (!mind) {
    return NextResponse.json({ ok: false, reason: "决策数据服务暂不可用" }, { status: 503 });
  }
  try {
    // ?id= 别名（等价 /[id]）：供 dev 环境与代理层使用，避免动态段不编译的 404（frontend 2026-11-18 03:09 实测）
    // ⚠️ 同步要求（U-19）：这 3 条详情 SQL 与 [id]/route.ts 逐字相同，改一处必须改两处（等价性已源码级核对）。
    if (idParam) {
      const dRows = await qStrict(mind, 'SELECT * FROM "DecisionItem" WHERE id = $1 LIMIT 1', idParam);
      const decision = dRows[0] ?? null;
      if (!decision) return NextResponse.json({ ok: false, reason: "未找到该决策" }, { status: 404 });
      const dims = await qStrict(mind, 'SELECT * FROM "DecisionAnalysis8D" WHERE "decisionId" = $1 ORDER BY dimension ASC', idParam);
      const tracks = await qStrict(mind, 'SELECT * FROM "DecisionOutcome" WHERE "decisionId" = $1 ORDER BY "createdAt" ASC', idParam);
      return NextResponse.json({ ok: true, decision, dims, tracks, asOf: asOf() });
    }
    const rows = status
      ? await qStrict(mind, 'SELECT * FROM "DecisionItem" WHERE status = $1 ORDER BY "createdAt" DESC LIMIT ' + limit, status)
      : await qStrict(mind, 'SELECT * FROM "DecisionItem" ORDER BY "createdAt" DESC LIMIT ' + limit);
    return NextResponse.json({ ok: true, rows, asOf: asOf() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, reason: "决策数据暂时无法读取，请稍后重试" }, { status: 503 });
  } finally {
    safeClose(mind);
  }
}
