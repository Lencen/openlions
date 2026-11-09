import { NextResponse } from "next/server";
import { openMind } from "@/lib/server/lions-db";

// 2026-11-06 · 数据卡 9（/flywheel）落地：4 条判据的实时值 + 阈值 + 状态
// 口径：docs/design/uiux-bento-2026-11/data-cards/card-9-flywheel.md
//
// 契约（2026-11-06 20:4x 修正，消费方 frontend-line-2 反馈）：
//   - checks[].value  是**给人看的展示串**（如 "3.3%" / "4743 条 / 最近 4.8h"），不要拿它去 parse；
//   - checks[].valueNum 是**同一事实的数值**（百分比 0-100 / 条数 / 小时），null = 不可得；
//   - 单条查询失败只降级该条为 state="na"+reason，**不把整块判 unknown**
//     （status: ok / partial（有条目 na）/ unknown（连不上库））。
export const dynamic = "force-dynamic";

type Check = {
  id: "extract_fail_rate" | "cognition_24h" | "backlog" | "pipeline_freshness";
  label: string;
  threshold: string;
  value: string | null;
  valueNum: number | null;
  /** 数值单位：% / count / hours（2026-11-06 按 frontend 建议补，便于机器判阈值） */
  unit: "%" | "count" | "hours";
  /** 结构化附加信息：消费方不用再从 value 展示串里解析（2026-11-06 按 frontend 建议补） */
  extra?: { lastActiveHours?: number; attempts?: number; skips?: number };
  state: "pass" | "fail" | "na";
  reason?: string;
};

export async function GET() {
  const asOf = new Date().toISOString();
  const checks: Check[] = [];
  let pool: any = null;
  try {
    pool = await openMind();
  } catch (e: any) {
    return NextResponse.json({ status: "unknown", reason: "打不开 lions_mind: " + (e?.message || e), asOf, checks: [] });
  }

  // ① 提炼失败率
  try {
    const r = await pool.query(
      `select round((count(*) filter (where status='ERROR'))::numeric*100/nullif(count(*),0),1)::float as v from "SessionExtractionState"`,
    );
    const v = r.rows?.[0]?.v;
    checks.push({
      id: "extract_fail_rate",
      label: "提炼失败率",
      unit: "%",
      threshold: "<= 5%",
      value: v == null ? null : v + "%",
      valueNum: v == null ? null : Number(v),
      state: v == null ? "na" : v > 5 ? "fail" : "pass",
      reason: v == null ? "提炼记录为空" : undefined,
    });
  } catch (e: any) {
    checks.push({ id: "extract_fail_rate", label: "提炼失败率", threshold: "<= 5%", value: null, valueNum: null, unit: "%", state: "na", reason: "查询失败: " + (e?.message || e) });
  }

  // ② 认知链 24h 新增（事实源 = FlywheelReflection 且 status='OK'）
  try {
    const r = await pool.query(
      `select count(*) filter (where "createdAt" >= (now() at time zone 'UTC') - interval '24 hours')::int as c24,
              round(extract(epoch from ((now() at time zone 'UTC') - max("createdAt")))/3600,1)::float as age
         from "FlywheelReflection" where status='OK'`,
    );
    const c24 = r.rows?.[0]?.c24;
    const age = r.rows?.[0]?.age;
    const stale = typeof c24 === "number" && c24 === 0 && typeof age === "number" && age > 24;
    checks.push({
      id: "cognition_24h",
      label: "认知链 24h 新增",
      unit: "count",
      threshold: "> 0（=0 且 >24h 无活动 → 断流）",
      value: typeof c24 === "number" ? c24 + " 条 / 最近 " + (age ?? "?") + "h" : null,
      valueNum: typeof c24 === "number" ? c24 : null,
      extra: { lastActiveHours: typeof age === "number" ? age : undefined },
      state: typeof c24 !== "number" ? "na" : stale ? "fail" : "pass",
      reason: typeof c24 !== "number" ? "FlywheelReflection 查询失败" : undefined,
    });
  } catch (e: any) {
    checks.push({ id: "cognition_24h", label: "认知链 24h 新增", threshold: "> 0", value: null, valueNum: null, unit: "count", state: "na", reason: "查询失败: " + (e?.message || e) });
  }

  // ③ 飞轮积压
  try {
    const r = await pool.query(`select count(*)::int as v from "FlywheelJob" where status in ('PENDING','PROCESSING')`);
    const v = r.rows?.[0]?.v;
    checks.push({
      id: "backlog",
      label: "飞轮积压",
      unit: "count",
      threshold: "<= 20",
      value: typeof v === "number" ? String(v) : null,
      valueNum: typeof v === "number" ? v : null,
      state: typeof v !== "number" ? "na" : v > 20 ? "fail" : "pass",
    });
  } catch (e: any) {
    checks.push({ id: "backlog", label: "飞轮积压", threshold: "<= 20", value: null, valueNum: null, unit: "count", state: "na", reason: "查询失败: " + (e?.message || e) });
  }

  // ④ 管道新鲜度（extract 阶段）：与 scripts/check-pipeline-freshness.cjs 同表同 SLO。
  //    注意 SessionExtractionState 的时间列是 extractedAt（bigint ms），没有 createdAt。
  try {
    const r = await pool.query(
      `select
         round(extract(epoch from (now() - to_timestamp(max("extractedAt")/1000.0)))/3600,1)::float as age,
         (select count(*)::int from "SessionExtractionState"
            where status in ('ERROR','DEFERRED')
              and "extractedAt" > (extract(epoch from (now() at time zone 'UTC') - interval '2 hours')*1000)::bigint) as attempts
         from "SessionExtractionState" where status='OK'`,
    );
    const age = r.rows?.[0]?.age;
    const attempts = Number(r.rows?.[0]?.attempts ?? 0);
    // 与 scripts/check-pipeline-freshness.cjs（2026-11-06 card-9 ④ 口径）一致：
    //   超 SLO 且有尝试但 0 成功 -> FAIL；超 SLO 但近窗口无尝试 -> QUIET（不判断流，这里记 na）
    let st: "pass" | "fail" | "na" = "pass";
    let why: string | undefined;
    if (typeof age !== "number") { st = "na"; why = "无已完成的提炼记录"; }
    else if (age > 2) {
      if (attempts > 0) { st = "fail"; why = "近 2h 有 " + attempts + " 次尝试但 0 成功（429/熔断）"; }
      else { st = "na"; why = "输入稀疏（近 2h 无尝试）—— 不判断流"; }
    }
    checks.push({
      id: "pipeline_freshness",
      label: "管道新鲜度（extract）",
      unit: "hours",
      threshold: "<= 2h（超 SLO 且有尝试才判红）",
      value: typeof age === "number" ? age + "h" : null,
      valueNum: typeof age === "number" ? age : null,
      extra: { attempts },
      state: st,
      reason: why,
    });
  } catch (e: any) {
    checks.push({ id: "pipeline_freshness", label: "管道新鲜度（extract）", threshold: "<= 2h", value: null, valueNum: null, unit: "hours", state: "na", reason: "查询失败: " + (e?.message || e) });
  }

  const naCount = checks.filter((c) => c.state === "na").length;
  const status = naCount === checks.length ? "unknown" : naCount > 0 ? "partial" : "ok";
  return NextResponse.json({ status, asOf, checks });
}
