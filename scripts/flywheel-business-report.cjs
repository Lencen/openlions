#!/usr/bin/env node
/**
 * flywheel-business-report.cjs — 飞轮业务看板唯一入口（2026-10-27）
 * ================================================================
 * 产物：run/flywheel-business-snapshot-latest.json
 *   = canonical schema v1 + business 扩展（追加字段，不改 v1 语义）
 *
 * 用法：
 *   node scripts/flywheel-business-report.cjs --hours=24 --write
 *   node scripts/flywheel-business-report.cjs --format=json
 *   node scripts/flywheel-business-report.cjs --check
 *   node scripts/flywheel-business-report.cjs --date=2026-10-26 --write
 *
 * 只读：不写任何业务表；gateway token 只读本机 sqlite。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const {
  collectBusinessSnapshot, validateBusinessSnapshot, BUSINESS_SCHEMA,
} = require("./lib/flywheel-business-snapshot.cjs");
const { renderText } = require("./lib/flywheel-snapshot.cjs");

const REPO = path.resolve(__dirname, "..");
const RUN_DIR = path.join(REPO, "run");
const OUT = path.join(RUN_DIR, "flywheel-business-snapshot-latest.json");

function argOf(name) {
  const hit = process.argv.find((s) => s.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : null;
}
const has = (name) => process.argv.includes("--" + name) || process.argv.some((s) => s.startsWith("--" + name + "="));

(async () => {
  const opts = {};
  if (argOf("hours")) opts.hours = Number(argOf("hours"));
  if (argOf("date")) opts.date = argOf("date");
  if (argOf("from") && argOf("to")) { opts.from = argOf("from"); opts.to = argOf("to"); }

  const snapshot = await collectBusinessSnapshot(opts);
  const problems = validateBusinessSnapshot(snapshot);

  if (has("check")) {
    if (problems.length) {
      console.error("[flywheel-business] 自检失败:");
      for (const p of problems) console.error("  - " + p);
      process.exit(1);
    }
    console.log("[flywheel-business] 自检通过（" + snapshot.schema + " + " + BUSINESS_SCHEMA + "，窗口 " + snapshot.window.label + "）");
    return;
  }

  if (has("write") || has("quiet")) {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");
    if (!has("quiet")) console.error("[flywheel-business] 已落盘: " + OUT);
  }

  if (argOf("format") === "json") {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    return;
  }

  // timer/服务用 --quiet：只落盘，不刷一屏；人工排查仍可去掉 --quiet。
  if (has("quiet")) return;

  // 人看的一屏：canonical 摘要 + 业务扩展摘要
  const b = snapshot.business;
  process.stdout.write(renderText(snapshot) + "\n");
  process.stdout.write("\n== 业务看板扩展（" + b.schema + "） ==\n");
  process.stdout.write("regime " + b.regime.current + " " + b.regime.label + " | 14d 可比=" + b.regime.comparable + "\n");
  process.stdout.write("DONE 拆分 agent " + b.delivery.agentDone + " / cron " + b.delivery.cronDone + " / system " + b.delivery.doneBy.system + " / 其他 " + b.delivery.doneBy.other + "\n");
  process.stdout.write("agent 转化 " + (b.delivery.agentConversionPct == null ? "NO_DATA" : b.delivery.agentConversionPct + "%") + " | cron 关单比 " + (b.delivery.cronDonePct == null ? "NO_DATA" : b.delivery.cronDonePct + "%") + "\n");
  process.stdout.write("验收覆盖 7d runner " + (b.delivery.acceptanceCoverage.runnerPct == null ? "NO_DATA" : b.delivery.acceptanceCoverage.runnerPct + "%") + " / any " + (b.delivery.acceptanceCoverage.anyPct == null ? "NO_DATA" : b.delivery.acceptanceCoverage.anyPct + "%") + "\n");
  process.stdout.write("shadow PASS " + b.acceptance.shadow.pass + " / FAIL " + b.acceptance.shadow.fail + "（诊断，不改任务）\n");
  process.stdout.write("never claimed " + b.queue.neverClaimed + "（" + (b.queue.neverClaimedPct == null ? "NO_DATA" : b.queue.neverClaimedPct + "%" ) + "）| 首次认领 P50 " + (b.queue.firstClaimWait.p50Hours == null ? "NO_DATA" : b.queue.firstClaimWait.p50Hours + "h") + "\n");
  process.stdout.write("token gateway " + b.cost.gateway.tokens.toLocaleString() + " / calls " + b.cost.gateway.calls + "（" + (b.cost.gateway.available ? "exact" : "NO_DATA") + "）| agent 覆盖 " + (b.cost.agent.coveragePct == null ? "NO_DATA" : b.cost.agent.coveragePct + "%") + " | 单价 未配置\n");
  process.stdout.write("资产 M" + b.assets.totals.Memory + " / K" + b.assets.totals.Knowledge + " / P" + b.assets.totals.Practice + " / S" + b.assets.totals.Skill + " | 主题反思 " + b.assets.reflection.topic + " / 历史反思 " + b.assets.reflection.legacy + "\n");
  process.stdout.write("数据健康 " + b.health.score + "/100（cap=" + b.health.capped + "）| 红线 " + (b.health.redlines.length || 0) + " 项\n");
  if (b.noData.length) process.stdout.write("NO_DATA " + b.noData.map((x) => x.label).join(" / ") + "\n");
  if (problems.length) process.stdout.write("! 自检问题: " + problems.join("; ") + "\n");
})().catch((e) => {
  console.error("[flywheel-business] FAIL " + ((e && e.stack) || e));
  process.exit(2);
});
