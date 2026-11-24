import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// 飞轮硬指标看板数据 (2026-09-21 Q6#2): 读 scripts/hard-task-metrics.cjs 产出的 JSON
export async function GET() {
  // 2026-11-13 P0：路径兼容多布局（仓库/发布树/logs 可配），不 ENOTFOUND 时静默 0；找不到 -> ok:false + 原因。
  const candidates = [
    process.env.HARD_METRICS_FILE,
    path.join(process.env.LIONS_LOGS_DIR || "", "hard-task-metrics.json"),
    // 2026-11-15 P2：生成器写的是仓库 logs/（cron/手动跑），部署树若未带该文件则回落仓库路径
    path.join(process.env.HOME || "~", "lions", "logs", "hard-task-metrics.json"),
    path.join(process.cwd(), "..", "..", "..", "logs", "hard-task-metrics.json"),
    path.resolve(process.cwd(), "../../../../logs/hard-task-metrics.json"),
    "/opt/lions/current/logs/hard-task-metrics.json",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      return NextResponse.json({ ok: true, ...j, source: p });
    } catch { /* 下一个候选 */ }
  }
  return NextResponse.json({ ok: false, error: "hard-task-metrics.json 不可读（仓库/发布树/logs 均未找到）", candidates: candidates.map((x) => x.replace(process.env.HOME || "", "<HOME>")), hint: "先运行 node scripts/hard-task-metrics.cjs" });
}