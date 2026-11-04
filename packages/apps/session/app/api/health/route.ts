import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// 2026-10-22 轻量健康端点：首页 `/` 是 SSR + 依赖会话库，冷启动实测 >8s，
//   会让发布脚本的健康判据（8s 超时）失败并触发回滚。这里给一个不查库的探针。
export async function GET() {
  return NextResponse.json({ ok: true, app: "session", at: new Date().toISOString() });
}
