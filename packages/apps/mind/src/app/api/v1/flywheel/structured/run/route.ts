/**
 * POST /api/v1/flywheel/structured/run — 手动触发碎片结构化整理
 * V1.7 §4.2 API
 *
 * Body: { theme: string, lookbackDays?: number, force?: boolean, actor?: string }
 *
 * 注意: 24h 防重入锁 (除非 force=true). force 用于管理后台人工触发或调试.
 */
import { structureFragments } from "@/server/pipeline/structure-fragments";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const theme = body.theme;
    if (!theme) {
      return Response.json({ error: "theme 必填" }, { status: 400 });
    }

    const result = await structureFragments({
      theme,
      lookbackDays: body.lookbackDays,
      force: !!body.force,
      actor: body.actor || "api:manual",
    });
    return Response.json(result);
  } catch (e: any) {
    console.error(`[structured-run:V1.7] err: ${e.message}`);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
