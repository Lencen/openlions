import { NextRequest, NextResponse } from "next/server";

import { safeFetchJson, safeStatus } from "@/lib/server/proxy-fetch";
// AI 离开/接手: 数据继承 (agentSource 迁移) - P2-B 2026-09-01
// 转发 mind agent.transferData (adminProcedure, 用 MIND_ADMIN_API_KEY)
export async function POST(req: NextRequest) {
  const body = await req.json();
  const adminKey = process.env.MIND_ADMIN_API_KEY || ""  // 2026-09-08 加固: 禁止硬编码默认, 必须由 env 提供;
    const r = await safeFetchJson("http://localhost:3000/api/trpc/agent.transferData", {
    method: "POST",
    headers: {
      "x-admin-key": adminKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (r.ok === false) {
    return NextResponse.json({ _error: r.error }, { status: 502 });
  }
  const data = r.data;  return NextResponse.json(data, { status: safeStatus(r.status) });
}
