import { NextResponse } from "next/server";
import { initAutoRotation, initDailySummaryScheduler, initDlqRetryScheduler } from "@/server/auto-rotation";
import { prisma } from "@/lib/prisma";

// 2026-10-15 round-78: 本路由**启动进程内调度器**(有副作用), 不是读接口。
//   无参 GET 无 dynamic -> 被 build 期预渲染: ① build 进程里启动过调度器(随 build 进程消亡);
//   ② 之后的手工/脚本调用拿到冻结的 {success:true}(实测 x-nextjs-cache: HIT) 却**什么都没启动**
//   -> 静默失效(见 scripts/land-f005-* 注释: 每日总结 cron 仅靠本入口或 startDailySummaryScheduler 武装)。
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await initAutoRotation();
    await initDailySummaryScheduler();
    await initDlqRetryScheduler(prisma);
    return NextResponse.json({ success: true, message: "Auto-rotation initialized (incl. DLQ retry)" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
