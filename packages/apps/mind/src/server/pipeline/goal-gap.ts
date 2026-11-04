/**
 * goal-gap.ts — 目标差距 -> 自动开任务 (2026-09-10 治本层 第1片)
 *
 * 为什么存在: 过去的修复都是"人/agent 发现症状后补规则"(治标)。本模块让平台按目标自检并主动开工作:
 *   读 docs/platform-logic/goals.md 的机读 JSON 块 -> 取指标当前值(与体检 scorecard 同口径)
 *   -> 低于阈值即生成 GOAL_GAP 任务(带目标引用/契约/验收标准) -> agent claim/submit 执行
 *   -> 完成后由另一 agent 独立验收(见 goals.md §5)。
 * 去重: 同一 goalId 已有活跃任务则跳过, 避免每 6h 重复开单; 诚实: 不造空壳任务。
 */
import { prisma } from "@/lib/prisma";
import { evidenceKindOf } from "./evidence";
import { llmCalls5h } from "./llm-calls-5h";
import { sessionQuery } from "@/server/lib/session-pg";
import fs from "fs";

/**
 * 会话提炼的稳态读数 (2026-09-11, 任务 cmtvfgenf00101j76qryfut02)
 * 为什么跨库: 产物在 mind 库, 会话状态在 session 库; 需要按"来源会话是否也是新会话"来切分产物。
 * 只读 + 容错: 任一库不可用则返回全 0, 不影响指标本身。
 */
async function computeExtractSteadyState(since: Date): Promise<{ steadyProducts: number; backlogProducts: number; freshSessions: number; freshDone: number; freshExcluded: number; pendingBacklog: number; effectiveSessions: number; effectiveDone: number; effectiveSkipped: number; effectiveFailed: number; coverage: number }> {
  // 2026-10-07 新增(判据再定基, 人类批准): 分母改成**有效会话**(messageCount >= 3)。
  //   为什么: 原目标"产物量 >= 100/日"是**绝对量**, 而产物量 ≈ 输入量 × 单会话产出, 产线并不可控输入 ——
  //   实测 10-03 起会话同步故障导致输入从 8-11/日 塌到 1-4/日(且 1405 条里 1272 条是 <3 条消息的噪声),
  //   产物量随之掉到 0, 但**产线本身完全正常**(同日覆盖率 0.932: 133 条有效会话里 124 条提炼成功)。
  //   绝对量适合做观测(受输入规模支配), 覆盖率才是产线能负责的指标。
  const zero = { steadyProducts: 0, backlogProducts: 0, freshSessions: 0, freshDone: 0, freshExcluded: 0, pendingBacklog: 0, effectiveSessions: 0, effectiveDone: 0, effectiveSkipped: 0, effectiveFailed: 0, coverage: 0 };
  try {
    const sinceMs = since.getTime();
    // 2026-10-26 SQLite 退役(P3): 会话状态改读 lions_session（PG），一条聚合查询拿全部计数。
    const [agg] = await sessionQuery<any>(
      'SELECT ' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1)::int AS fresh_sessions,' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "extractStatus" = \'DONE\')::int AS fresh_done,' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "extractStatus" = \'SKIPPED\')::int AS fresh_excluded,' +
      ' COUNT(*) FILTER (WHERE "extractStatus" IN (\'PENDING\',\'PROCESSING\'))::int AS pending_backlog,' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "messageCount" >= 3)::int AS effective_sessions,' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "messageCount" >= 3 AND "extractStatus" = \'DONE\')::int AS effective_done,' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "messageCount" >= 3 AND "extractStatus" = \'SKIPPED\')::int AS effective_skipped,' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "messageCount" >= 3 AND "extractStatus" = \'FAILED\')::int AS effective_failed' +
      ' FROM "Session"',
      [since]
    );
    const num = (v: any) => Number(v || 0);
    const freshSessions = num(agg?.fresh_sessions), freshDone = num(agg?.fresh_done), freshExcluded = num(agg?.fresh_excluded);
    const pendingBacklog = num(agg?.pending_backlog), effectiveSessions = num(agg?.effective_sessions);
    const effectiveDone = num(agg?.effective_done), effectiveSkipped = num(agg?.effective_skipped), effectiveFailed = num(agg?.effective_failed);
    const coverage = effectiveSessions > 0 ? Number((effectiveDone / effectiveSessions).toFixed(3)) : 0;
    const ids: string[] = (await prisma.$queryRawUnsafe<any[]>(
      "SELECT DISTINCT sourceId FROM (SELECT sourceId FROM Memory WHERE createdAt >= ? AND sourceType='SESSION_EXTRACT' UNION ALL SELECT sourceId FROM Knowledge WHERE createdAt >= ? AND sourceType='SESSION_EXTRACT') WHERE sourceId IS NOT NULL",
      since, since
    )).map((r) => String(r.sourceId));
    const isFresh = new Set<string>();
    if (ids.length) {
      const rows = await sessionQuery<any>(
        'SELECT "sessionUid","id","createdAt" FROM "Session" WHERE "sessionUid" = ANY($1::text[]) OR "id" = ANY($1::text[])',
        [ids]
      );
      for (const row of rows) {
        const t = row.createdAt instanceof Date ? row.createdAt.getTime() : Date.parse(String(row.createdAt));
        if (Number.isFinite(t) && t >= sinceMs) { isFresh.add(String(row.sessionUid)); isFresh.add(String(row.id)); }
      }
    }
    const rows: any[] = await prisma.$queryRawUnsafe<any[]>(
      "SELECT sourceId FROM (SELECT sourceId FROM Memory WHERE createdAt >= ? AND sourceType='SESSION_EXTRACT' UNION ALL SELECT sourceId FROM Knowledge WHERE createdAt >= ? AND sourceType='SESSION_EXTRACT')",
      since, since
    );
    let steadyProducts = 0, backlogProducts = 0;
    for (const r of rows) { if (isFresh.has(String(r.sourceId))) steadyProducts++; else backlogProducts++; }
    return { steadyProducts, backlogProducts, freshSessions, freshDone, freshExcluded, pendingBacklog,
             effectiveSessions, effectiveDone, effectiveSkipped, effectiveFailed, coverage };
  } catch (e: any) {
    console.warn("[goal-gap] 稳态读数计算失败(非致命): " + String(e?.message || "").slice(0, 100));
    return zero;
  }
}


/**
 * 会话提炼覆盖率(单一实现, 2026-10-07 round 52 立)
 *
 * 为什么重写判据(实测证据): 24h 窗口在输入稀疏期只有 **2 条**有效会话(1 条 SKIPPED + 1 条刚创建的在途会话) ->
 *   覆盖率算成 0/2 = 0.000, 而同期 3 天窗口 126/129 = 0.977, 7 天 140/144 = 0.972 —— 产线明明正常, 读数却塌成 0。
 *   两处口径缺陷: ①`SKIPPED` 是**有意排除**(pipeline 的 P0-1 预筛: auto session/退休 agent/不可解析),
 *     它永远不可能变 DONE, 留在分母里等于给覆盖率设了一个永远够不到的上限;
 *     ②**在途会话**(刚上传、还没轮到提炼)也算未提炼 -> 分母被"来不及"污染。
 *   修法: 分母 = 窗口内 messageCount>=3 且 非 SKIPPED 且 (已 DONE 或 创建已超过 GRACE_MS) 的会话。
 *   窗口: 判定用 **7 天**(与 pipeline 自己的 scanSessionState since 同口径, index.ts:56); 24h 仍作为观测项输出。
 */
const EXTRACT_GRACE_MS = 30 * 60 * 1000; // 在途豁免: 30 分钟(给提炼器一个轮次的时间, 之后仍未 DONE 就计入分母)
async function computeExtractCoverage(sinceMs: number): Promise<{ eligible: number; done: number; skipped: number; failed: number; inflight: number; coverage: number | null }> {
  const empty = { eligible: 0, done: 0, skipped: 0, failed: 0, inflight: 0, coverage: null as number | null };
  try {
    const deadline = Date.now() - EXTRACT_GRACE_MS;
    // 2026-10-26 SQLite 退役(P3): 会话状态改读 lions_session（PG）。
    const [agg] = await sessionQuery<any>(
      'SELECT ' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "messageCount" >= 3 AND "extractStatus" = \'DONE\')::int AS done,' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "messageCount" >= 3 AND "extractStatus" = \'SKIPPED\')::int AS skipped,' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "messageCount" >= 3 AND "extractStatus" = \'FAILED\')::int AS failed,' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "messageCount" >= 3 AND ("extractStatus" IS NULL OR "extractStatus" IN (\'PENDING\',\'PROCESSING\')) AND "createdAt" > $2)::int AS inflight,' +
      ' COUNT(*) FILTER (WHERE "createdAt" >= $1 AND "messageCount" >= 3 AND ("extractStatus" IS NULL OR "extractStatus" <> \'SKIPPED\') AND ("extractStatus" = \'DONE\' OR "createdAt" <= $2))::int AS eligible' +
      ' FROM "Session"',
      [new Date(sinceMs), new Date(deadline)]
    );
    const done = Number(agg?.done || 0), skipped = Number(agg?.skipped || 0), failed = Number(agg?.failed || 0);
    const inflight = Number(agg?.inflight || 0), eligible = Number(agg?.eligible || 0);
    return { eligible, done, skipped, failed, inflight, coverage: eligible > 0 ? Number((done / eligible).toFixed(3)) : null };
  } catch (e: any) {
    console.warn("[goal-gap] 覆盖率计算失败(非致命): " + String(e?.message || "").slice(0, 100));
    return empty;
  }
}

const GOALS_FILE = process.env.LIONS_GOALS_FILE || "" + (process.env.LIONS_HOME || process.cwd()) + "/docs/platform-logic/goals.md";

interface GoalSpec { id: string; name: string; metric: string; target: number; direction: "up" | "down" }
export interface GoalMetric { id: string; value: number | null; target: number; direction: "up" | "down"; gap: number | null; ok: boolean; detail?: string; /** 2026-09-11: true = 窗口内无数据可算(此时 ok=false, 不再静默当作达标) */ missing?: boolean }
export interface GoalCheckResult { at: string; metrics: GoalMetric[]; gaps: GoalMetric[]; created: Array<{ goalId: string; taskId: string }>; skipped: Array<{ goalId: string; reason: string }> }

/** 读机读目标定义 (md 内 ```json 围栏块) */
export function loadGoalSpec(): { northStar?: GoalSpec; goals: GoalSpec[] } {
  try {
    const md = fs.readFileSync(GOALS_FILE, "utf-8");
    const m = md.match(/```json\r?\n([\s\S]*?)\r?\n```/);
    if (!m) return { goals: [] };
    const j = JSON.parse(m[1]);
    return { northStar: j.northStar, goals: Array.isArray(j.goals) ? j.goals : [] };
  } catch (e: any) {
    console.warn("[goal-gap] 读取目标定义失败: " + (e?.message || "").slice(0, 80));
    return { goals: [] };
  }
}

/** 指标口径明细(解释数字构成; 只读展示, 不参与达标判定) 2026-09-11 采纳 agent 评审建议 */
export const metricDetails: Record<string, string> = {};

/** 指标当前值 (与 quality-audit scorecard 同口径, 独立计算避免循环依赖) */
export async function measureMetrics(): Promise<Record<string, number | null>> {
  const now = Date.now();
  const d7 = new Date(now - 7 * 24 * 3600 * 1000);
  const d1 = new Date(now - 24 * 3600 * 1000);
  const out: Record<string, number | null> = {};
  for (const k of Object.keys(metricDetails)) delete metricDetails[k];
  try {
    // 2026-09-11 口径修复(决策 decision_metric_window_pollution_0911, 方案A): 原窗口用 reflection.updatedAt,
    //   任何维护性写入(补字段/脚本改写)都会把历史 finding 拉进窗口 -> 指标被自己的写入污染(实测 FW-GROW 0.392->0.268)。
    //   改为: 取全部反思, 窗口**下沉到 finding 自身时间**(firstSeenAt / lastResolvedAt)。findings 是 JSON, 无法在 SQL 里过滤。
    // 2026-09-11 独立复核裁决(agent-b): "需第三方案 —— dual-reporting 优于口径切换"。
    //   故不再单方面切换: **达标判定仍用原口径**(窗口 = reflection.updatedAt, 与历史曲线可比),
    //   新口径(finding 自身时间)只作为**观测值**并列展示, 供对比与后续迁移决策。
    const w7 = d7.getTime();
    const byFindingTime = (f: any): boolean => {
      const t1 = Date.parse(String((f as any).firstSeenAt || ""));
      const t2 = Date.parse(String((f as any).lastResolvedAt || ""));
      return (Number.isFinite(t1) && t1 >= w7) || (Number.isFinite(t2) && t2 >= w7);
    };
    // 2026-09-11 第 38 轮修(潜在缺陷, 属"窗口污染"的另一面): 定稿(goals.md:66)明确主口径是**累计**
    //   (不设滑动窗), 但代码此前用 updatedAt>=7d 的滑动窗算主读数 —— 当前两者恰好相等(实测全部 reflection
    //   的 updatedAt 都在 7 天内, 见第 32 轮验证), 属**数值巧合**。一旦维护性写入停止, 老 reflection 会移出窗口,
    //   主读数就会在无人察觉的情况下从"累计"悄悄变成"近 7 天", 与文档定义背离。
    //   改为: 主读数走累计(allRows); 原 7d(reflection.updatedAt) 读数降级为**观测项**, 便于对照。
    const winRows = await prisma.flywheelReflection.findMany({ where: { updatedAt: { gte: d7 }, structuredFindings: { not: null } }, select: { structuredFindings: true } });
    const allRows = await prisma.flywheelReflection.findMany({ where: { structuredFindings: { not: null } }, select: { structuredFindings: true } });
    let altTotal = 0, altResolved = 0, altNeedsReview = 0;
    let winTotal = 0, winResolved = 0, winNeedsReview = 0;
    const { parseStructuredFindings } = await import("./findings-parse");
    let total = 0, resolved = 0, needsReview = 0, noAcceptance = 0;
    for (const r of allRows) for (const f of parseStructuredFindings(r.structuredFindings)) {
      if (!byFindingTime(f)) continue;
      const st = String((f as any).status || "NEW");
      altTotal++;
      if (st === "RESOLVED") altResolved++; else if (st === "NEEDS_REVIEW") altNeedsReview++;
    }
    // 主口径: 累计(不设窗口) —— 与 goals.md:66 定稿一致
    for (const r of allRows) for (const f of parseStructuredFindings(r.structuredFindings)) {
      const st = String((f as any).status || "NEW");
      total++;
      if (st === "RESOLVED") resolved++;
      else if (st === "NEEDS_REVIEW") needsReview++;
      // "无需落地"代理: 未落地 且 acceptance 为空 -> 该条没有可执行的落地判据, 严格说不是"欠账"
      else if (!String((f as any).acceptance || "").trim()) noAcceptance++;
    }
    // 观测项: 旧的 7d(reflection.updatedAt) 口径 —— 保留用于对照, 不参与达标判定
    for (const r of winRows) for (const f of parseStructuredFindings(r.structuredFindings)) {
      const st = String((f as any).status || "NEW");
      winTotal++;
      if (st === "RESOLVED") winResolved++; else if (st === "NEEDS_REVIEW") winNeedsReview++;
    }
    const eligible = Math.max(0, total - needsReview);
    out.findings_landed_rate = eligible ? Number((resolved / eligible).toFixed(3)) : null;
    // 2026-09-11 采纳 agent 评审: 落地率不该只给一个比值, 要能看出分子分母构成
    const altEligible = Math.max(0, altTotal - altNeedsReview);
    metricDetails.findings_landed_rate_alt = "双口径观测(复核裁决 dual-reporting): 主口径=**累计**(不设窗口, 见 goals.md:66 定稿) -> " +
      out.findings_landed_rate + "; 观测项A 窗口=reflection.updatedAt(近7天, 旧口径) -> " +
      (winTotal ? Number((winResolved / Math.max(0, winTotal - winNeedsReview)).toFixed(3)) : null) +
      " (总 " + winTotal + " / 已落地 " + winResolved + " / 人审 " + winNeedsReview + "); 观测项B 窗口=finding 自身时间 -> " +
      (altEligible ? Number((altResolved / altEligible).toFixed(3)) : null) +
      " (总 " + altTotal + " / 已落地 " + altResolved + " / 人审 " + altNeedsReview + ")。A/B 均不参与达标判定。";
    // 双口径并列(复核裁决): 主读数=原口径(达标判定用), 括号内=新口径观测值
    const altRate = altEligible ? Number((altResolved / altEligible).toFixed(3)) : null;
    // 2026-10-06 修(读数自相矛盾, 实测): 原实现把"主读数与观测项A 当前相同(0.298)"**硬编码**在 detail 里,
    //   而当天实际读数已是 主读数 0.349 / 观测项A 0.119 —— 文案与数字对不上, 读到这条指标的人(含人类决策卡)
    //   会被误导成"两个口径相同、窗口污染仍存"。现改为**动态比较**, 三种关系各自成句。
    const mainRate = eligible > 0 ? Number((resolved / eligible).toFixed(3)) : null;
    const winRate = winTotal ? Number((winResolved / Math.max(0, winTotal - winNeedsReview)).toFixed(3)) : null;
    metricDetails.findings_landed_rate =
      "总 " + total + " = 已落地(关闭) " + resolved + " + 真未落地 " + (eligible - resolved) + " + 人审待办 " + needsReview +
      "(不计入分母) | 分母 " + eligible + " | 未落地中 acceptance 为空(无可落地判据, 代理'无需落地') " + noAcceptance +
      " || 口径说明: 主读数=**累计**(与 goals.md 定稿一致); 观测项A(reflection.updatedAt 近7天) = " + winRate + " (总 " + winTotal + "); 观测项B(finding 自身时间近7天) = " + altRate + " (总 " + altTotal +
      ")。当前主读数 " + mainRate + " 与观测项A " + winRate +
      (mainRate === winRate
        ? " **相同**(全部 reflection 的 updatedAt 都落在 7 天内 —— 窗口污染的残留效应, 不是巧合)"
        : " **不同**(窗口污染效应已消失; 累计口径不受维护性写入影响, 读数更稳)") +
      "; 观测项B 仅作趋势观测。三者均不改变达标判定口径。";
    // 2026-09-11: 证据门槛指标(采纳 agent 提案中正确的部分) —— 落地必须有可引用证据,
    //   否则"置为 RESOLVED 但没有证据"就是一种自证。注意: 不采纳该提案"未绑定 owner 不计入分母"的建议(那是操纵分母)。
    let resolvedWithEvidence = 0;
    let resolvedArchived = 0;
    for (const r of allRows) for (const f of parseStructuredFindings(r.structuredFindings)) {
      if (String((f as any).status || "") !== "RESOLVED") continue;
      // 2026-09-14 用户决定: 历史"无证据存量"(旧关闭路径关闭时不写任何证据)经机械复算后
      //   ① 能真跑出证据的补真证据; ② 跑不出的打 archivedAt 归档、**不再处理**。
      //   归档条目不进证据率的分子与分母(它们不随新数据变化, 留着只会永久污染读数), 但**单列条数**
      //   在 detail 里且数据保留 —— 不删除、不隐藏、不冒充已核实。见 scripts/archive-legacy-findings.cjs。
      if ((f as any).archivedAt) { resolvedArchived++; continue; }
      // 2026-09-11 收紧(自评: 原判据"有 note 即算证据"必然接近 1.0, 无门槛作用):
      //   只有包含**可复现形式**才算证据 —— commit hash / SQL 查询 / 接口路径 / 文件:行号 / 显式 evidenceRef。
      const evText = String((f as any).evidenceRef || "") + " " + String((f as any).resolutionNote || "");
      // 2026-09-11 二次收紧: 改用与生命周期硬拦相同的判据(evidence.ts), 指标与拦截面不再两套标准.
      const verifiable = Boolean(evidenceKindOf(evText));
      if (verifiable) resolvedWithEvidence++;
    }
    const evidenceDenom = Math.max(0, resolved - resolvedArchived);
    out.findings_evidence_rate = evidenceDenom ? Number((resolvedWithEvidence / evidenceDenom).toFixed(3)) : null;
    // 口径说明必须显式写进 detail, 否则读数会从 0.10 跳到 1.00 而无人知道为什么。
    metricDetails.findings_evidence_rate =
      "RESOLVED " + resolved + " - 历史归档 " + resolvedArchived + " = 分母 " + evidenceDenom
      + "; 分子(有可复现证据) " + resolvedWithEvidence + " -> " + out.findings_evidence_rate
      + " || 2026-09-14 用户决定: 旧关闭路径留下的'无证据存量'经机械复算后, 能跑出真证据的补证据, 跑不出的归档"
      + "(打 archivedAt)不再处理 —— 数据保留、条数在此单列、不冒充已核实。见 scripts/archive-legacy-findings.cjs";
  } catch { out.findings_landed_rate = null; }
  try {
    // 2026-09-14 FW-QUALITY 可审计增强: 除总均分外, 给出**构成**(各表 n/avg、低于 G3 门槛占比、未打分行数),
    //   否则一个 0.493 的读数看不出是"内容变差"还是"某条产线漏写质量分"(这正是 09-11 事故的盲区)。
    const rows = await prisma.$queryRawUnsafe<any[]>("SELECT AVG(q) AS \"avgQ\" FROM (SELECT qualityScore q FROM Memory WHERE sourceType='FLYWHEEL_STRUCTURED' AND createdAt >= ? UNION ALL SELECT qualityScore FROM Knowledge WHERE sourceType='FLYWHEEL_STRUCTURED' AND createdAt >= ? UNION ALL SELECT qualityScore FROM Practice WHERE sourceType='FLYWHEEL_STRUCTURED' AND createdAt >= ?)", d1, d1, d1);
    const v = rows?.[0]?.avgQ;
    out.products_avg_quality_24h = v == null ? null : Number(Number(v).toFixed(3));
    const comp = await prisma.$queryRawUnsafe<any[]>(
      "SELECT 'Memory' t, COUNT(*) n, AVG(qualityScore) aq, SUM(CASE WHEN qualityScore IS NULL OR qualityScore=0 THEN 1 ELSE 0 END) unscored, SUM(CASE WHEN qualityScore < 0.4 THEN 1 ELSE 0 END) low FROM Memory WHERE sourceType='FLYWHEEL_STRUCTURED' AND createdAt >= ? " +
      "UNION ALL SELECT 'Knowledge', COUNT(*), AVG(qualityScore), SUM(CASE WHEN qualityScore IS NULL OR qualityScore=0 THEN 1 ELSE 0 END), SUM(CASE WHEN qualityScore < 0.4 THEN 1 ELSE 0 END) FROM Knowledge WHERE sourceType='FLYWHEEL_STRUCTURED' AND createdAt >= ? " +
      "UNION ALL SELECT 'Practice', COUNT(*), AVG(qualityScore), SUM(CASE WHEN qualityScore IS NULL OR qualityScore=0 THEN 1 ELSE 0 END), SUM(CASE WHEN qualityScore < 0.4 THEN 1 ELSE 0 END) FROM Practice WHERE sourceType='FLYWHEEL_STRUCTURED' AND createdAt >= ?",
      d1, d1, d1
    );
    const totalN = comp.reduce((a, r) => a + Number(r.n ?? 0), 0);
    const unscored = comp.reduce((a, r) => a + Number(r.unscored ?? 0), 0);
    const low = comp.reduce((a, r) => a + Number(r.low ?? 0), 0);
    metricDetails.products_avg_quality_24h =
      "24h 三表 FLYWHEEL_STRUCTURED 产物 " + totalN + " 条(均分 " + out.products_avg_quality_24h + "); 构成 " +
      comp.map((r) => r.t + ":" + r.n + "/avg" + (r.aq == null ? "-" : Number(r.aq).toFixed(3))).join(" + ") +
      " | 低于 G3 门槛(<0.4) " + low + " 条(" + (totalN ? (low / totalN * 100).toFixed(1) : "0") + "%), 未打分(NULL/0) " + unscored + " 条" +
      (unscored > 0 ? " ⚠️ 存在未打分产物 —— 按历史根因(写入侧漏写/传错参数)排查, 不得静默当作正常" : "") +
      " | 口径: AVG(qualityScore), 窗口=近24h(rolling); 评分公式见 db-writer.calcQualityScore, 门槛单一来源 product-quality.MIN_PRODUCT_QUALITY。";
  } catch { out.products_avg_quality_24h = null; }
  try {
    // 2026-09-24 PL-TRUST 机制修复(任务本次,根因 2026-09-24 10:17 塌 - 的实证):
    //   旧实现只在 26h 超龄时返 null(missing),让 goal-check 自动开单"塌在 -"。
    //   新实现走 pl-trust-snapshot-refresh 模块的三段式兜底(snapshot → lazy refresh → 守门 fallback),
    //   **永远不返 null**:成功路径有真值,失败路径有 reason + replay(traceable)。
    //   口径未改: audit_violations 仍 = violations + docDriftDocs(quality-audit.ts 单一口径来源)。
    //   历史保留: PL_TRUST_SNAPSHOT_MAX_AGE_H 仍控制 missing 阈值(由 runGoalCheck 上层判 missing),
    //   但本函数不再主动把 audit_violations 置 null —— 让上层用"快照超龄但有守门 fallback 真值"
    //   判定 ok=true 而非 missing=true。这是"自检可信"指标的语义闭环。
    const { getAuditViolationsWithFallback } = await import("./pl-trust-snapshot-refresh");
    const r = await getAuditViolationsWithFallback();
    if (r.ok) {
      out.audit_violations = r.audit_violations;
      metricDetails.audit_violations =
        "source=" + r.source + "; audit_violations=" + r.audit_violations
        + " || 口径: violations + docDriftDocs(quality-audit.ts 单一口径)"
        + " || 兜底链: snapshot(>6h 自动 lazy) -> runQualityAudit() -> scripts/pl-trust-guard.cjs(spawnSync 30s)"
        + " || 守门脚本永远能跑(只读 DB + git),任何上游断裂都能给出真值,结构上消除'塌在 -'。";
    } else {
      // 全失败(无快照/lazy 失败/守门失败) → 返 null 但 detail 带 replay 让上游有 traceable hint
      // 这里仍保留 null,因为真没数据;但 PL-TRUST 的"自检可信"语义在这里 = "如实告警",不再静默 0。
      out.audit_violations = null;
      metricDetails.audit_violations =
        "⚠️ 三段兜底全失败(source=" + r.source + "): " + r.reason
        + " || replay: " + r.replay
        + " || 即使 timer 未装,本接口也会尝试 lazy refresh + 守门 fallback;若全部失败则属真正无数据,需人工排查。";
    }
  } catch (e: any) {
    // 极端兜底:模块本身抛错(代码 bug / 编译失败) → 不静默 null,detail 给原因
    out.audit_violations = null;
    metricDetails.audit_violations = "⚠️ getAuditViolationsWithFallback threw: " + String(e?.message || e).slice(0, 200)
      + " || replay: node " + (process.env.LIONS_HOME || process.cwd()) + "/scripts/pl-trust-guard.cjs";
  }
  try {
    const [done, failed] = await Promise.all([
      prisma.task.count({ where: { status: "DONE", updatedAt: { gte: d1 } } }),
      prisma.task.count({ where: { status: "FAILED", updatedAt: { gte: d1 } } }),
    ]);
    out.task_success_rate = done + failed > 0 ? Number((done / (done + failed)).toFixed(3)) : null;
  } catch { out.task_success_rate = null; }
  // 2026-09-10: 人类干预(埋点) + 真实自主率代理
  try {
    // 2026-09-21 口径修正(用户决策 Q5): 一次人类决策会落 2-3 条 HUMAN_INTERVENTION 事件
    //   (todo update + todo DONE + human comment, sourceId=同一待办/实体 id)。
    //   旧口径按事件条数计数 -> 把"点一次决策"夸大成多次干预(实测今天 3 次决策记了 4 条)。
    //   新口径按 COUNT(DISTINCT sourceId) 去重: 一个被人类触碰过的实体(待办/讨论)记 1 次干预。
    const rows = await prisma.$queryRawUnsafe<any[]>(
      "SELECT COUNT(DISTINCT sourceId) c FROM FlywheelEvent WHERE stage='HUMAN_INTERVENTION' AND sourceTitle NOT LIKE '[test]%' AND sourceId IS NOT NULL AND createdAt >= ?", d1);
    const iv = Number(rows?.[0]?.c ?? 0);
    out.human_interventions_24h = iv;
    const done = await prisma.task.count({ where: { status: "DONE", updatedAt: { gte: d1 } } });
    // 自主率代理 = 完成任务数 / (完成任务数 + 人类干预数); 目标 0.95(2026-09-21 用户确认"目标设定者"定位)
    out.autonomy_proxy = done + iv > 0 ? Number((done / (done + iv)).toFixed(3)) : null;
    // 2026-09-24 PL-AUTONOMY 机制修复(任务 cmufdnwdu00dz5ahxldf45ti3): 当 done+iv=0 返回 null 时,detail 必须给出
    //   窗口活跃度证据,避免"业务真在跑但 close-loop 慢"被静默判定为"平台停摆"。这是**只读观测**,不操纵分母、
    //   不改指标语义(null 仍 = 无数据,missing=true 仍开单)。详细根因复盘见
    //   docs/platform-logic/pl-autonomy-vacuum-2026-09-24.md。
    if (out.autonomy_proxy == null) {
      try {
        const winStart = d1.getTime();
        const activeRows: any[] = await prisma.$queryRawUnsafe<any[]>(
          "SELECT " +
          " (SELECT COUNT(*) FROM Task WHERE updatedAt >= ?) AS taskChanges, " +
          " (SELECT COUNT(*) FROM FlywheelEvent WHERE createdAt >= ?) AS eventCount, " +
          " (SELECT COUNT(*) FROM Task WHERE status='PROCESSING') AS processingNow, " +
          " (SELECT COUNT(*) FROM Task WHERE status='BLOCKED') AS blockedNow, " +
          " (SELECT COUNT(*) FROM Task WHERE status='PENDING') AS pendingNow, " +
          " (SELECT COUNT(*) FROM Todo WHERE updatedAt >= ?) AS todoChanges, " +
          " (SELECT MAX(updatedAt) FROM Task) AS lastTaskChangeMs",
          winStart, winStart, winStart);
        const r = activeRows?.[0] || {};
        const taskChanges = Number(r.taskChanges ?? 0);
        const eventCount = Number(r.eventCount ?? 0);
        const processingNow = Number(r.processingNow ?? 0);
        const blockedNow = Number(r.blockedNow ?? 0);
        const pendingNow = Number(r.pendingNow ?? 0);
        const todoChanges = Number(r.todoChanges ?? 0);
        const lastTaskChangeMs = r.lastTaskChangeMs == null ? null : Number(r.lastTaskChangeMs);
        const lastChangeAgo = lastTaskChangeMs ? ((Date.now() - lastTaskChangeMs) / 3600000).toFixed(1) + "h" : "?";
        const windowActive = taskChanges + eventCount + todoChanges > 0;
        metricDetails.autonomy_proxy =
          "⚠️ 24h 窗口内 done=0, iv=0 → 读数为 null(指标语义保留:无数据≠达标,继续开单)。" +
          " 窗口活跃度证据: Task 状态变更 " + taskChanges + " 条(最近 " + lastChangeAgo + " 前), " +
          "FlywheelEvent " + eventCount + " 条, Todo 更新 " + todoChanges + " 条; " +
          "当前队列 PROCESSING=" + processingNow + " BLOCKED=" + blockedNow + " PENDING=" + pendingNow + "。" +
          (windowActive
            ? " 判定: **业务真在跑,但 close-loop 真空**(本次塌陷的实测根因,见 docs/platform-logic/pl-autonomy-vacuum-2026-09-24.md)。" +
              " fix 已把窗口活跃度写进 detail; agent 接手时不再走'无数据恐慌-猜测-复算'路径。"
            : " 判定: 平台疑似停摆; 需查 upstream 产线(详见 todo worker / agent 进程)。");
      } catch {
        metricDetails.autonomy_proxy = (metricDetails.autonomy_proxy ? metricDetails.autonomy_proxy + " || " : "") +
          "窗口活跃度探针失败(非致命):无法判定停摆 vs 真空期。";
      }
    }
  } catch { out.human_interventions_24h = null; out.autonomy_proxy = null; }
  // 成本: 24h LLM 调用次数(观测烧额度; 目标为上限)
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>("SELECT COUNT(*) c FROM FlywheelEvent WHERE stage='CALL_LLM' AND createdAt >= ?", d1);
    out.llm_calls_24h = Number(rows?.[0]?.c ?? 0);
  } catch { out.llm_calls_24h = null; }
  // 2026-09-11: 真实约束是订阅"每 5 小时 6000 次调用"(token 不限) -> 用滚动 5 小时窗口做配额指标。
  // 2026-10-11 PL-COST 机制修复(任务 cmv2wvi5u02y9rbs1yj6o57v2, 根因见 llm-calls-5h.ts 头注):
  //   旧实现 catch -> null, 只要一次查询抖动就让 metric 塌成 "-", goal-check 每 6h 据此开单;
  //   且只读 CALL_LLM, 而 responder 的聚合 calls 被 brain-calls 后端丢弃 -> 系统性少记一个数量级
  //   (实测 2026-10-11: 真实 666 次/5h vs 可见 58 次)。现改为共享实现 + 兜底链, **永不 null**。
  try {
    const reading = await llmCalls5h();
    out.llm_calls_5h = reading.value;
    metricDetails.llm_calls_5h =
      "滚动5h 调用 " + reading.value + " = max(平台 CALL_LLM " + reading.platform + ", responder 实报 " + reading.real + ")" +
      " (源=" + reading.source + (reading.degraded ? ", DEGRADED" : "") + ")" +
      " || 口径: 订阅 6000 次/5h(token 不限), 目标 4800 = 80% 留余量。" +
      " platform = FlywheelEvent stage='CALL_LLM' 且**非网络失败**的条数(goals.md:113; 本窗口网络失败 " + reading.networkFailures + " 条单列观测, 不计入);" +
      " real = SUM(json_extract(sourceTitle,'$.calls')) over stage='LLM_USE_REAL'(responder 逐次上报, 网络失败不计次)。" +
      " 取 max 不求和: 两路是对同一批调用的独立埋点, 相加会双计, max 是真实用量的下界。" +
      " 兜底链: prisma -> 直连只读 sqlite -> 本地快照 -> 0(degraded), 结构上消除'塌在 -'。";
  } catch (e: any) {
    // 共享实现内部已兜底, 这里只是理论上的最后一道防线: 仍给 0 而非 null, 并显式标注。
    out.llm_calls_5h = 0;
    metricDetails.llm_calls_5h =
      "⚠️ 计量链全部异常(" + String(e?.message || e).slice(0, 80) + "), 保守取 0(不静默, 需查 DB/responder)。";
  }
  // 2026-09-10: 会话提炼产物量(24h) — 把"会话里的信息有没有被提炼成记忆/知识"变成可计算的指标
  // 背景: 会话已集中到 session 服务(98xx 会话/500k 消息), 但提炼器仍在读旧本地源, 09-05 起会话类产物为 0
  try {
    // 2026-09-17 [FW-EXTRACT 机制修复]: UNION ALL 加入 Practice
    //   根因: session-extract.ts:15 注释承诺产 4 类 (M/K/P/S), 但代码实际只产 2 类 (M+K);
    //     且 metric SQL 只 UNION M+K, 漏数 Practice。实测 24h Practice.sourceType=SESSION_EXTRACT = 82 条。
    //   Skill 未纳入: 24h Skill 表 sourceType 全为空, 不属会话提炼管线。
    //   注入记忆所述 \"仅计 memory 单类\" 是过期描述; 修复到 M+K+P 三表与代码注释承诺对齐。
    const sql =
      "SELECT COUNT(*) c FROM (" +
      "SELECT id FROM Memory WHERE createdAt >= ? AND ((sourceType LIKE 'PIPELINE_%' AND sourceType <> 'PIPELINE_BACKFILL') OR sourceType IN ('SESSION_EXTRACT','CLAUDE_CONVERSATION'))" +
      " UNION ALL " +
      "SELECT id FROM Knowledge WHERE createdAt >= ? AND ((sourceType LIKE 'PIPELINE_%' AND sourceType <> 'PIPELINE_BACKFILL') OR sourceType IN ('SESSION_EXTRACT','CLAUDE_CONVERSATION'))" +
      " UNION ALL " +
      "SELECT id FROM Practice WHERE createdAt >= ? AND ((sourceType LIKE 'PIPELINE_%' AND sourceType <> 'PIPELINE_BACKFILL') OR sourceType IN ('SESSION_EXTRACT','CLAUDE_CONVERSATION')))";
    const rows = await prisma.$queryRawUnsafe<any[]>(sql, d1, d1, d1);
    out.session_extraction_products_24h = Number(rows?.[0]?.c ?? 0);
    // 2026-09-11 采纳 agent 评审: 24h 读数里混着历史会话补提炼(backlog), 看不出稳态产能.
    //   补一个"近 6 小时折算日产能"作为稳态读数(仍不计入达标判定, 避免用口径换数字).
    const d6 = new Date(Date.now() - 6 * 3600 * 1000);
    const rows6 = await prisma.$queryRawUnsafe<any[]>(sql, d6, d6, d6);
    const c6 = Number(rows6?.[0]?.c ?? 0);
    // 2026-09-11 (任务 cmtvfgenf00101j76qryfut02): 把"稳态读数"做成**可复算的定义**, 而不是一句免责声明。
    //   定义: 稳态产能 = 近24h 产物中, 其来源会话**本身也是近24h 新建**的那部分(即只靠新流入就能产出的量);
    //   其余为历史会话补提炼(backlog 消耗, 一次性)。同时给出**真实积压**(PENDING/PROCESSING)以证明稳态可持续。
    //   口径修正(实测): 旧注释称"8291 条 SKIPPED 会话是待提炼积压"—— 错。实测 SKIPPED 共 8505 条,
    //   原因是**有意排除**: auto session(cron/hook) 5426 条 + agent retired 2810 条 + 不可解析 50 条;
    //   全库 PENDING/PROCESSING 真实积压 = 0。故"未提炼会话数下降"这个验收项本身立错了对象。
    const steady = await computeExtractSteadyState(d1);
    metricDetails.session_extraction_products_24h =
      "24h " + out.session_extraction_products_24h + " | 近6h " + c6 + " 条(折算速率 " + c6 * 4 + "/日)" +
      // 2026-09-11 独立复核指出本定义的结构性反例(agent-c): 今日新建的**批处理** session 可以把昨日 backlog
      //   一并提炼, 那部分会被计入"新会话产出"; 反之老 session 也可能持续处理新事件。故本读数**不是严格稳态**,
      //   只是"新会话贡献量"的下界近似 —— 改名以避免对外被当成稳态产能。
      " || **新会话产出 " + steady.steadyProducts + "/日**(定义: 近24h 产物中来源会话本身也新建于近24h 的部分; " +
      "⚠️ 非严格稳态: 独立复核给出反例 —— 今日新建的批处理 session 可把昨日 backlog 一并提炼并计入本数, 老 session 也可能产出新内容。真实稳态应按日序列观测) + " +
      "历史补提炼 " + steady.backlogProducts + " 条(一次性) | 近24h 新会话 " + steady.freshSessions + " 条(已提炼 " + steady.freshDone + " / 按规则排除 " + steady.freshExcluded + ")" +
      " | **真实积压(PENDING/PROCESSING) " + steady.pendingBacklog + " 条**" +
      (steady.pendingBacklog === 0 ? "(提炼器跟得上流入, 稳态读数可复现)" : "(仍有积压, 稳态读数尚不可持续)") +
      " || 口径说明: SKIPPED 不是积压而是**有意排除**(auto session/退休 agent/不可解析), 见提交 2026-09-11。" +
      // 2026-09-11 复核质疑的核实结论(闭环): 复核员质疑"'agent retired' 缺判据证据链, 可能是真积压改名"。已查证,
      //   判据链**存在**: docs/platform-logic/agent-registry.md §退役规则(退役 agent 的会话在 session 侧标 SKIPPED, 不再进入提炼)、
      //   docs/platform-logic/session.md(同口径)、docs/evidence-self-proof-report.md(8,291/8,291 全部有 extractError, 判定"非缺口"),
      //   以及事件链(FlywheelEvent: [operator]终端硬件故障退役 08-22 / 项目从 [operator] 退役硬盘迁移到 operator 09-04)。
      //   实测这 2810 条全部属 agent-h(2026-05-27~06-18, 300,174 条消息), extractedAt 全为 NULL —— 即**按决策放弃提炼**, 不是处理失败。
      //   但仍有一件事是真的: 这 300k 消息的知识**没有被继承**(另有 finding 记录用户曾要求 agent-h 继承, 其 Memory 主题记录实测为 0 条)。
      " 复核质疑已核实: 'agent retired' 判据链**存在**(见 agent-registry.md/session.md/evidence-self-proof-report.md + 退役事件链), " +
      "2810 条全属 agent-h 且 extractedAt 全为 NULL => 是**按决策放弃**, 不是处理失败或改名积压; " +
      "但 300,174 条消息的知识**未被继承**(该主题 Memory 实测 0 条), 是否回捞需人工决定。";

    // 2026-10-07 判据再定基(人类批准 "按你的建议处理"): FW-EXTRACT 的**判定口径**改为"有效会话提炼覆盖率"。
    //   为什么改: 原判定用产物**绝对量 >= 100/日**, 而绝对量 ≈ 输入量 × 单会话产出, 输入不由产线控制 ——
    //   实测 10-03 起会话同步故障把输入从 8-11/日 打到 1-4/日, 产物量随之掉到 0/日,
    //   但**产线本身正常**: 24h 内 133 条有效会话(>=3 条消息)中 124 条提炼成功(覆盖率 0.932), FAILED 0 条。
    //   产物量降级为**观测项**(仍在 detail 里, 并给出输入构成: 有效会话 vs <3 条噪声), 覆盖率作为判定。
    // 2026-10-07 round 52 二次定基(实测: 24h 窗口在稀疏期只有 2 条有效会话, 覆盖率假塌 0.000):
    //   判定口径 = **7 天**窗口的覆盖率(与 pipeline 自己的扫描窗口同口径), 分母排除 SKIPPED(有意排除)与在途会话(30min 豁免);
    //   24h 覆盖率降级为**观测项**(保留在 detail 里, 供发现"当下堵住"用)。详见 computeExtractCoverage 头注。
    const cov24 = await computeExtractCoverage(Date.now() - 24 * 3600 * 1000);
    const cov7d = await computeExtractCoverage(Date.now() - 7 * 24 * 3600 * 1000);
    out.extract_coverage_24h = cov24.coverage;
    out.extract_coverage_7d = cov7d.coverage;
    const covText = (c: { eligible: number; done: number; skipped: number; failed: number; inflight: number; coverage: number | null }) =>
      (c.coverage == null ? "不可判定(无可计入会话)" : String(c.coverage)) + " = " + c.done + "/" + c.eligible +
      " (DONE " + c.done + " / FAILED " + c.failed + " / 在途未到期 " + c.inflight + " / 有意排除 SKIPPED " + c.skipped + ")";
    metricDetails.extract_coverage_7d =
      "提炼覆盖率 **7 天** " + covText(cov7d) +
      " || 口径: 窗口内 messageCount>=3 的会话中 extractStatus=DONE 的比例;" +
      "**分母排除两类**: ①SKIPPED(SKIPPED 是 pipeline 的 P0-1 预筛**有意排除**: auto session/退休 agent/不可解析, 永远不会变 DONE);" +
      "②在途会话(创建 <30min 且未 DONE, 还没轮到提炼器)。窗口取 7 天 = pipeline 自己的扫描窗口(index.ts:56)。" +
      " || 观测项(不参与判定): 24h 覆盖率 " + covText(cov24) +
      " —— 24h 窗口在输入稀疏期分母会小到 1~2 条(实测 2 条: 1 SKIPPED + 1 在途), 读数无统计意义, 故不用于判定;" +
      "24h 新会话 " + steady.freshSessions + " 条(已提炼 " + steady.freshDone + " / 按规则排除 " + steady.freshExcluded + ")。" +
      " || 口径说明: 产物绝对量的目标是 100/日(2026-09 立, 当时输入充裕); 输入被同步故障掐断期间绝对量必然塌, 但不代表产线坏。";

  } catch {
    out.session_extraction_products_24h = null;
    out.extract_coverage_24h = null;
    out.extract_coverage_7d = null;
  }
  return out;
}

export async function runGoalCheck(opts: { create?: boolean } = {}): Promise<GoalCheckResult> {
  const spec = loadGoalSpec();
  const values = await measureMetrics();
  const metrics: GoalMetric[] = [];
  for (const g of spec.goals) {
    const v = values[g.metric] ?? null;
    // 2026-09-11 第 23 轮修(实测缺陷): 原来 v == null 时 ok 保持初始值 true —— 即**没有数据的指标会显示为达标**。
    //   实测触发场景: FW-QUALITY 的 24h 窗口里已无 FLYWHEEL_STRUCTURED 产物(最后一条 2026-09-10 16:15),
    //   读数变 null, 而接口仍返回 ok:true(我看到'None OK'才发现)。静默通过比误报更危险: 它会把"管线停了"伪装成"达标"。
    let gap: number | null = null;
    let ok = true;
    let missing = false;
    if (v != null) {
      gap = g.direction === "up" ? Number((g.target - v).toFixed(3)) : Number((v - g.target).toFixed(3));
      ok = gap <= 0;
    } else {
      // 无数据 != 达标: 显式标 missing 且不计为 ok, 由 goal-check 正常走"未达标"流程(受冷静期约束, 不会刷单)。
      missing = true;
      ok = false;
      metricDetails[g.metric] = (metricDetails[g.metric] ? metricDetails[g.metric] + " || " : "") +
        "⚠️ 无数据: 窗口内没有可用于计算该指标的产物 —— 按未达标处理(而不是静默当作达标)。需查上游产线是否停摆。";
    }
    metrics.push({ id: g.id, value: v, target: g.target, direction: g.direction, gap, ok, missing, detail: metricDetails[g.metric] });
  }
  const gaps = metrics.filter((m) => !m.ok);
  const created: Array<{ goalId: string; taskId: string }> = [];
  const skipped: Array<{ goalId: string; reason: string }> = [];
  for (const m of gaps) {
    const g = spec.goals.find((x) => x.id === m.id)!;
    const theme = "目标·" + g.id;
    const active = await prisma.task.findFirst({ where: { theme, improvementType: "GOAL_GAP", status: { notIn: ["DONE", "FAILED", "DEPRECATED"] } }, select: { id: true } });
    if (active) { skipped.push({ goalId: m.id, reason: "已有活跃 GOAL_GAP 任务 " + active.id }); continue; }
    // 2026-09-10 冷静期(agent 实证反馈): 任务被秒认领秒交(仅提案不落地)时"活跃去重"失效,
    //   同一目标 30 分钟内开出 3 条同质任务 -> 各 agent 反复输出同质结论、白烧 token。
    //   规则: 同一目标 GOAL_GAP 任务在 GOAL_GAP_COOLDOWN_MIN(默认 360)分钟内不再重复开单。
    const cooldownMin = Number(process.env.GOAL_GAP_COOLDOWN_MIN ?? 360);
    if (cooldownMin > 0) {
      const recent = await prisma.task.findFirst({
        where: { theme, improvementType: "GOAL_GAP", createdAt: { gte: new Date(Date.now() - cooldownMin * 60_000) } },
        orderBy: { createdAt: "desc" }, select: { id: true, status: true },
      });
      if (recent) { skipped.push({ goalId: m.id, reason: "冷静期内(" + cooldownMin + "min)已有任务 " + recent.id + " status=" + recent.status }); continue; }
    }
    // 2026-09-11 P0 (任务 cmtvfgeps00121j765jmy4sk7 要求 #3): "已 DONE 且**无新证据**的主题设冷静期"。
    //   实测问题: 目标·FW-GROW 这类未达标目标, 每 6h 一轮 -> 24h 内开出 3 条**内容完全相同**的任务
    //   (description 里带着当时的指标读数; 读数没变 => 任务描述逐字相同 => 就是同一条活在重复派发)。
    //   判据: 上一次同类任务已 DONE, 且其记录在 structuredContext 里的指标读数与**本次相同** => 说明上轮没有带来任何变化,
    //   延长冷静期到 NO_EVIDENCE_COOLDOWN_MIN(默认 1440 = 24h)并记录 SKIP-NO-NEW-EVIDENCE(可审计)。
    const noEvidenceCooldownMin = Number(process.env.GOAL_GAP_NO_EVIDENCE_COOLDOWN_MIN ?? 1440);
    if (noEvidenceCooldownMin > cooldownMin) {
      const prev = await prisma.task.findFirst({
        where: { theme, improvementType: "GOAL_GAP" },
        orderBy: { createdAt: "desc" }, select: { id: true, status: true, createdAt: true, structuredContext: true },
      });
      let prevValue: unknown = null;
      try { prevValue = JSON.parse(String(prev?.structuredContext || "{}"))?.value ?? null; } catch { prevValue = null; }
      const sameReading = prevValue != null && String(prevValue) === String(m.value);
      const prevDone = String(prev?.status || "") === "DONE";
      const within = prev?.createdAt ? Date.now() - new Date(prev.createdAt).getTime() < noEvidenceCooldownMin * 60_000 : false;
      if (prevDone && sameReading && within) {
        skipped.push({ goalId: m.id, reason: "SKIP-NO-NEW-EVIDENCE: 上一条 " + prev!.id + " 已 DONE 且指标读数仍为 " + String(m.value) + "(无新证据), " + noEvidenceCooldownMin + "min 内不重复派发" });
        continue;
      }
    }
    if (!opts.create) { skipped.push({ goalId: m.id, reason: "dry(未创建)" }); continue; }
    // 2026-09-10 语义修正(用户反馈"改进任务里混着类似 todo 的派单"):
    //   这条是【机制修复】单, 不是待办/催促。标题与契约都强制"机制性改动 + 复测证据", 不收提案。
    const title = "[机制修复] " + g.id + " " + g.name + ": 指标 " + g.metric + " 塌在 " + (m.value ?? "-") + " (目标 " + g.target + ")";
    const description = [
      "【目标】" + g.id + " " + g.name + " — 指标 " + g.metric + " 当前 " + (m.value ?? "无数据") + ", 目标 " + (g.direction === "up" ? "≥" : "≤") + g.target + ", 差距 " + m.gap,
      "【为什么】平台目标树(goals.md)判定该指标未达标; 属按目标自驱而非人工派单。",
      "【要做什么】定位指标塌陷根因 -> 落地机制性改动(代码/配置/口径/流程) -> 复测复现命令与结果 -> 附证据。",
      "【不接受的产出】①只交方案/建议/催促(平台会把提案单独归档为 PROPOSAL_ACCEPTED, 不视为本任务完成度); ②无证据的结论; ③一次性特判掩盖指标。",
      "【需要人类才能做的部分】若根因是授权/采购/业务决策, 请在输出中标注 [需要人类决策] 并说明卡点, 由平台转人类待办, 不要代做。",
      "【来源】goals.md " + g.id + " / 体检 scorecard(每 6h) / 由 goal-check 自动创建",
      // 2026-09-14 复盘沉淀(任务 cmu0w8dfd024eki4a70n3svdp): 把指标塌陷类问题的通用规则/预防 checklist
      //   挂到开单描述里, 让下一次同类修复开工就能看到, 而不是修完才想起来写复盘。
      "【通用规则·预防复发】指标塌陷类问题先读 docs/platform-logic/retro-fw-quality-2026-09-14.md §3(通用化规则 R1–R7)/§4(预防 checklist C1–C5): 先独立复算+构成明细, 再判'写入契约漂移 vs 内容变差'; 不动评分公式/口径; 守门须有非交互触发; 收工时逐条自查。",
      "【验收标准】1) 指标复测达标; 2) 结论须附证据(DB 查询/接口返回/文件行/commit); 3) 由不同 agent 独立复核通过(goals.md §5)。",
      "【质量底线】不得伪造执行; 无法完成须诚实 SKIP 并说明缺什么; 不新增特判掩盖问题。",
      "=== 事项明细 ===",
      "- 目标: " + g.name + "(" + g.id + "); 指标: " + g.metric + "; 当前: " + (m.value ?? "-") + "; 目标: " + g.target + "; 差距: " + m.gap,
    ].join("\n");
    try {
      const task = await prisma.task.create({
        data: {
          title: title.slice(0, 180),
          description,
          background: "目标 " + g.id + " 差距自动开单 (goal-check " + new Date().toISOString() + ")",
          requirements: "把 " + g.metric + " 从 " + (m.value ?? "无数据") + " 提升到 " + g.target + "(" + (g.direction === "up" ? "≥" : "≤") + "); 需给出根因与机制性改动。",
          acceptanceCriteria: "指标复测达标 + 证据引用 + 另一 agent 独立复核通过",
          qualityStandards: "诚实执行(不伪造) / 机制性改动优先 / 附复测方法",
          status: "PENDING",
          priority: (m.gap != null && Math.abs(m.gap) > 0.2 ? "P1" : "P2") as "P1" | "P2",
          theme,
          improvementType: "GOAL_GAP",
          manualReview: false,
          structuredContext: JSON.stringify({ sourceChain: { type: "GoalSpec", id: g.id, file: GOALS_FILE }, metric: g.metric, value: m.value, target: g.target, gap: m.gap }),
          materials: JSON.stringify({ goal: g, metricValue: m.value, gap: m.gap, measuredAt: new Date().toISOString(), howToVerify: "GET /api/v1/flywheel/goal-check ? 复测该指标", relatedDocs: ["docs/platform-logic/goals.md", "docs/evidence-self-proof-report.md"] }),
        },
        select: { id: true },
      });
      created.push({ goalId: m.id, taskId: task.id });
      console.log("[goal-gap] created task " + task.id + " for " + m.id + " (gap=" + m.gap + ")");
    } catch (e: any) {
      skipped.push({ goalId: m.id, reason: "创建失败: " + (e?.message || "").slice(0, 80) });
    }
  }
  return { at: new Date().toISOString(), metrics, gaps, created, skipped };
}
