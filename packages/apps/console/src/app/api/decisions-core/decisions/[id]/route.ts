import { NextResponse } from "next/server";
import { asOf, qStrict, openMind, safeClose } from "@/lib/server/lions-db";

/**
 * GET /api/decisions-core/decisions/[id] —— U-19 决策详情（决策元信息 + 8 维 + 落地追踪）
 *
 * 契约（严格 fail-closed）：
 *   200 { ok:true, decision, dims:[], tracks:[], asOf }
 *   404 { ok:false, reason:"未找到该决策" }   —— 仅当查询成功但确实无此行
 *   503 { ok:false, reason }                  —— 库/表不可用或查询失败
 *
 * 为什么不用 one()：one() 基于 q()，查询失败也返回 null，会把「表不存在」伪装成「未找到」。
 *
 * ⚠️ 同步要求（2026-11-18 U-19）：本文件的 3 条详情 SQL 与 decisions/route.ts 的 ?id= 别名逐字相同。
 *    改详情查询必须两处同改；等价性靠源码级比对核对（dev 下动态段不编译，故保留两路并存）。
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const id = ctx?.params?.id || "";
  if (!id) return NextResponse.json({ ok: false, reason: "缺少决策标识" }, { status: 400 });
  const mind = openMind();
  if (!mind) return NextResponse.json({ ok: false, reason: "决策数据服务暂不可用" }, { status: 503 });
  try {
    const rows = await qStrict(mind, 'SELECT * FROM "DecisionItem" WHERE id = $1 LIMIT 1', id);
    const decision = rows[0] ?? null;
    if (!decision) return NextResponse.json({ ok: false, reason: "未找到该决策" }, { status: 404 });
    const dims = await qStrict(mind, 'SELECT * FROM "DecisionAnalysis8D" WHERE "decisionId" = $1 ORDER BY dimension ASC', id);
    const tracks = await qStrict(mind, 'SELECT * FROM "DecisionOutcome" WHERE "decisionId" = $1 ORDER BY "createdAt" ASC', id);
    return NextResponse.json({ ok: true, decision, dims, tracks, asOf: asOf() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, reason: "决策数据暂时无法读取，请稍后重试" }, { status: 503 });
  } finally {
    safeClose(mind);
  }
}
