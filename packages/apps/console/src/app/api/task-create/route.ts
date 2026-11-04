import { NextResponse } from "next/server";
import { safeFetchJson } from "@/lib/server/proxy-fetch";

export const dynamic = "force-dynamic";

// 2026-10-13 round 76-BT: 从 selfimproving 的 /tasks/new 搬来 —— console 一直独缺"**手工建任务**"。
//   转发到 selfimproving 的 tRPC task.create: 那里会建 Task + 写 FlywheelEvent + 审计 + **通知 mind**
//   (`notifyMindTaskCreated`), 副作用齐备, 所以不自己直连库。
const SI = "http://localhost:3001/api/trpc/task.create";
const REQUIRED = ["title", "description", "background", "requirements", "materials", "acceptanceCriteria", "qualityStandards"];

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  const missing = REQUIRED.filter((k) => !String(body?.[k] ?? "").trim());
  if (missing.length) return NextResponse.json({ ok: false, error: "缺少必填项: " + missing.join(", ") }, { status: 400 });
  const json: Record<string, string> = {};
  for (const k of [...REQUIRED, "priority", "estimatedEffort"]) {
    const v = body?.[k];
    if (v !== undefined && v !== null && String(v) !== "") json[k] = String(v);
  }
  const r = await safeFetchJson(SI, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json }),
  });
  if (r.ok === false) return NextResponse.json({ ok: false, error: r.error }, { status: 502 });
  const task = (r.data as any)?.result?.data ?? null;
  if (!task?.id) return NextResponse.json({ ok: false, error: "创建失败（上游未返回任务）" }, { status: 502 });
  return NextResponse.json({ ok: true, task });
}
