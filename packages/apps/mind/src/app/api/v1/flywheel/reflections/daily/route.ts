import { runDailyReflection } from "@/server/pipeline/reflect-daily";

// 2026-10-15 round-78: 本路由**执行日结反思流水线**(不是读接口), 是日结入口。
//   无参 GET 无 dynamic -> build 期被预渲染: ① build 进程里真的跑了一次 runDailyReflection(副作用);
//   ② 之后所有请求都拿到冻结结果(实测 x-nextjs-cache: HIT, 冻结在 DAILY·2026-10-14) ->
//   再也不会产生当天的日结, 属于"库里坏了也返回旧值"。故必须动态。
export const dynamic = "force-dynamic";

// GET /api/v1/flywheel/reflections/daily — 每日 00:00 日结反思 (crontab: 0 0 * * *)
export async function GET() {
  try {
    const r = await runDailyReflection();
    return Response.json(r);
  } catch (e: any) {
    console.error("[reflect-daily]", e);
    return Response.json({ ok: false, error: (e && e.message) || String(e) }, { status: 500 });
  }
}
