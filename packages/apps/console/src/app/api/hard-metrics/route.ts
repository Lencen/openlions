import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// 飞轮硬指标看板数据 (2026-09-21 Q6#2): 读 scripts/hard-task-metrics.cjs 产出的 JSON
export async function GET() {
  try {
    const p = path.join(process.cwd(), "..", "..", "..", "logs", "hard-task-metrics.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return NextResponse.json({ ok: true, ...j });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e), hint: "先运行 node scripts/hard-task-metrics.cjs" });
  }
}