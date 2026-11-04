import { NextResponse } from "next/server";
import { macsAdminFetch } from "@/lib/server/macs-admin";

export const dynamic = "force-dynamic";

// 2026-10-26 K 的 key 生命周期审批（**与 /api/agent-approvals 的服务授权是两件事**）：
//   agent-approvals + mind claim-service-key = 服务授权（哪个 agent 能调哪个业务）；
//   /api/v1/agent-keys/* = agent key 生命周期（机器身份/管理身份、TTL、轮换）。
// 本 BFF 只做两件事：①带 admin key 转发 ②把 MACS 的错误原样带出（前端按 code 显示人话）。
// 注意：admin key **只在服务端**（macs-admin.ts 读取 .env.local / env），浏览器永远拿不到。
export async function GET() {
  const r = await macsAdminFetch("/api/v1/agent-keys/pending");
  if (r.status >= 400) {
    return NextResponse.json({ ok: false, items: [], error: (r.body && r.body.error) || "取待审批列表失败", status: r.status }, { status: r.status || 502 });
  }
  return NextResponse.json({ ok: true, ...(r.body) });
}
