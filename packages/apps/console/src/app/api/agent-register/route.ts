import { NextRequest, NextResponse } from "next/server";

import { safeFetchJson } from "@/lib/server/proxy-fetch";
export async function POST(req: NextRequest) {
  const body = await req.json();

  // 从环境变量或硬编码拿 bootstrap key（Console 是内部工具）
  const bootstrapKey = process.env.MIND_BOOTSTRAP_API_KEY || ""  // 2026-09-08 加固: env 必须配置, 禁硬编码默认;

  const mind = (process.env.LIONS_MIND_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
    const r = await safeFetchJson(mind + "/api/trpc/agent.register", {
    method: "POST",
    headers: {
      "x-bootstrap-key": bootstrapKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (r.ok === false) {
    return NextResponse.json({ _error: r.error }, { status: 502 });
  }
  const data = r.data;  return NextResponse.json(data, { status: r.status });
}
