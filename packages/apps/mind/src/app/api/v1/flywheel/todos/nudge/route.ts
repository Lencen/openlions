import { NextRequest, NextResponse } from "next/server";
import { runTodoNudges } from "@/server/pipeline/todo-nudge";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/flywheel/todos/nudge
 * Header: x-admin-key: $MIND_ADMIN_API_KEY
 * Body: { dryRun?: boolean, limit?: number }
 *
 * Manual trigger for the MVP/pilot. The 5-minute scheduler is armed by
 * initTodoNudgeScheduler() from the app bootstrap.
 */
export async function POST(req: NextRequest) {
  const expected = process.env.MIND_ADMIN_API_KEY;
  // 2026-11-09：鉴权 fail-closed。原实现 expected 为空时**直接放行**（fail-open），
  //   而该接口会触发真催办（写 Todo.meta + 发 MACS 消息），不能裸奔。
  //   未配置 -> 503（接口未启用），配错/缺 header -> 401。
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "nudge_disabled", detail: "MIND_ADMIN_API_KEY 未配置，接口 fail-closed" },
      { status: 503 },
    );
  }
  if (req.headers.get("x-admin-key") !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  try {
    const result = await runTodoNudges({
      dryRun: body?.dryRun === true,
      limit: body?.limit,
    });
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
