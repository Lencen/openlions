/**
 * GET /api/v1/flywheel/reflections/cron — 整点 cron 触发反思
 * V1.5 §2.4 API 5
 *
 * 建议调用频率: 每小时第 5 分钟 (cron: "5 * * * *")
 */
import { reflectWorker } from "@/server/pipeline/reflect";
import { findThemesNeedingReflection } from "@/server/pipeline/reflect-cron";
import { withCronTimeout } from "@/server/pipeline/cron-with-timeout";
// 2026-09-01: LLM API 健康探针 — 连续失败暂停反思 1h (故障窗口不烧额度)
import { isReflectionPaused, getPauseRemainingMs } from "@/server/pipeline/llm-health";
import { requireFeature } from "@/lib/license";

export async function GET(req: Request) {
  const gate = requireFeature("flywheel.reflect"); // 功能授权门禁
  if (!gate.ok) return Response.json(gate.body, { status: gate.status });
  // V1.8 Feature flag
  if (process.env.FLYWHEEL_V15_ENABLED === "false") {
    return Response.json({ skipped: true, reason: "FLYWHEEL_V15_ENABLED=false" });
  }
  // 2026-09-01: 健康探针 — 暂停期间直接跳过, 不调 LLM
  if (isReflectionPaused()) {
    const remaining = getPauseRemainingMs();
    console.log(`[reflect-cron] LLM API 暂停中, 跳过本轮反思 (剩余 ${Math.round(remaining / 60000)}min)`);
    return Response.json({
      skipped: true,
      reason: "llm-health paused",
      pauseRemainingMs: remaining,
    });
  }
  return withCronTimeout(
    async (signal) => {
      const t0 = Date.now();
      // 2026-09-10: 支持 ?limit=(默认 3, 上限 10) —— 单主题约 5-6 chunk, 一轮过多必撞超时
      const url = new URL(req.url);
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "3", 10) || 3, 10));
      const themes = await findThemesNeedingReflection({ limit });
      if (themes.length === 0) {
        return {
          scanned: 0,
          triggered: 0,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          duration: Date.now() - t0,
          message: "no themes need reflection",
        };
      }

      // 2026-10-17 P4 生产不可用修复(今晚两次): 并发默认 **3 -> 1**。
      //   为什么: 反思与 mind 的 HTTP 服务跑在**同一个 Node 进程**里(单线程 JS)。并发 3 个主题时,
      //   各自的同步 CPU 段(估 token/切 chunk/拼 prompt/SimHash/JSON 解析)互相叠加, 事件循环被
      //   长时间顶住 -> 端口 3000 `Recv-Q` 堆积(实测 15~39)、`/api/health/db` 与 `/` 双双超时。
      //   降为 1 + reflect.ts 的协作式让出(setImmediate) = HTTP 在反思期间保持可用。
      //   代价(诚实写明): 单轮吞吐下降(12 主题不再并行), 超出软预算的主题**如实报为 deferred**, 交下一轮。
      //   可用 `?concurrency=`(钳到 1..3)或 env `REFLECT_CRON_CONCURRENCY` 覆盖 —— 供复测做 A/B。
      const CONCURRENCY = Math.max(1, Math.min(
        parseInt(url.searchParams.get("concurrency") || process.env.REFLECT_CRON_CONCURRENCY || "1", 10) || 1,
        3,
      ));
      console.log(`[reflect-cron] concurrency=${CONCURRENCY}(默认 1: 保 HTTP 可用; 3 = 旧行为)`);
      // 软预算(默认 12min < 900s 硬超时): 到点停, 剩余主题报 deferred, 不被整体 abort。
      //   `?soft_budget_ms=`(钳 1000..1800000) 只为**夹具/复算**: 要证 deferred 分支时把它调到 1s 即可,
      //   不必真等 12min。生产不传 => env `REFLECT_CRON_SOFT_BUDGET_MS` => 默认 720000。
      //   (方向是安全的: 调小只会让本轮更早停, 不会让反思跑得比默认更久。)
      const SOFT_BUDGET_MS = Math.max(1000, Math.min(
        Number(url.searchParams.get("soft_budget_ms") || process.env.REFLECT_CRON_SOFT_BUDGET_MS || "720000") || 720000,
        1800000,
      ));
      const results: PromiseSettledResult<Awaited<ReturnType<typeof reflectWorker>>>[] = [];
      // P0-5 (2026-09-01) 跨主题熔断: 连续 2 批 (6 主题) 全失败 = LLM API 不可用
      //   停止本轮, 不再烧剩余主题的调用次数 (原行为: 20 主题全撞 API)
      let consecutiveFailedBatches = 0;
      let deferred = 0;
      for (let i = 0; i < themes.length; i += CONCURRENCY) {
        // P0-3: 检测到 abort 就停止再开新 batch
        if (signal.aborted) break;
        if (consecutiveFailedBatches >= 2) {
          console.warn(`[reflect-cron] 连续 ${consecutiveFailedBatches} 批全失败 (LLM API 不可用?), 熔断跳过剩余 ${themes.length - i} 主题`);
          deferred = themes.length - i;
          break;
        }
        // P4(2026-10-17): 软预算 —— 轮次内到点就让位, 剩余主题下一轮再来(避免硬 abort 把已跑的一起作废)
        if (Date.now() - t0 > SOFT_BUDGET_MS) {
          deferred = themes.length - i;
          console.warn(`[reflect-cron] 软预算 ${SOFT_BUDGET_MS}ms 到点, 剩余 ${deferred} 主题 deferred 到下一轮(本轮已跑 ${results.length})`);
          break;
        }
        const batch = themes.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.allSettled(
          batch.map(theme => reflectWorker(theme, { trigger: "cron" }))
        );
        results.push(...batchResults);
        // 2026-10-09 round 67-D 修复: 原判据把 SKIPPED 也算"失败" -> 连续 2 批(6 个)主题都没料可比,
        //   熔断就 break 掉**整轮**, 后面的主题一条都不看。实测 2026-10-09 09:05 一轮:
        //   scanned=10 / succeeded=0 / skipped=6, 剩下 4 个主题的 detail 是 "skipped due to abort"
        //   (其实是被熔断 break, 不是 abort —— 该文案也一并纠正)。
        //   后果是**飞轮入口饿死**: 每天大批主题本就"无 live 产物"(如 CSS对齐技巧 的 1 条 Memory 已
        //   superseded/COLD), 它们把熔断喂饱; 真需要反思的主题排在后面, 永远轮不到 ->
        //   实测 FlywheelReflection 自 2026-10-08 21:09 起 12 小时零新增, 连带改进任务 22:36 起断流。
        //   语义纠正: SKIPPED = "本轮无需反思"(正常态, 且耗时仅 47-164ms), 只有 rejected 或
        //   status="FAILED"(真出错) 才计入熔断 —— 熔断保护的是 "LLM API 不可用", 不是 "主题没料"。
        const allFailed = batchResults.every(r =>
          r.status === "rejected" || (r.status === "fulfilled" && r.value.status === "FAILED")
        );
        if (batchResults.every(r => r.status === "fulfilled" && r.value.status === "SKIPPED")) {
          console.log(`[reflect-cron] 本批 ${batch.length} 个主题全部无料可反思(SKIPPED, 非故障, 不计熔断)`);
        }
        consecutiveFailedBatches = allFailed ? consecutiveFailedBatches + 1 : 0;
      }

      // ★ P2 fix: succeeded 只算 status=OK 的, SKIPPED 单独统计 (不污染 failed)
      const succeeded = results.filter(r => r.status === "fulfilled" && r.value.status === "OK").length;
      const skipped = results.filter(r => r.status === "fulfilled" && r.value.status === "SKIPPED").length;
      const failed = results.length - succeeded - skipped;

      console.log(`[reflect-cron] themes=${themes.length} concurrency=${CONCURRENCY} ok=${succeeded} skip=${skipped} fail=${failed} deferred=${deferred} aborted=${signal.aborted} duration=${Date.now() - t0}ms`);

      return {
        scanned: themes.length,
        triggered: themes.length,
        attempted: results.length,
        deferred,
        concurrency: CONCURRENCY,
        succeeded,
        failed,
        skipped,
        duration: Date.now() - t0,
        aborted: signal.aborted,
        details: themes.map((theme, i) => ({
          theme,
          status: results[i]?.status,
          result: results[i]?.status === "fulfilled"
            ? {
                status: results[i].value.status,
                coverageScore: results[i].value.coverageScore,
                missedTopics: results[i].value.missedTopics.length,
                improvements: results[i].value.improvements.length,
                duration: results[i].value.duration,
              }
            : results[i]
              ? { error: (results[i] as any).reason?.message?.slice(0, 200) }
              // 2026-10-09 round 67-D: 此处同时覆盖"熔断 break 掉剩余主题"的情形, 原文案
              //   "skipped due to abort" 会把人引向 abort 方向排查(实测就是这么被误导的), 改为如实描述。
              : { error: "not attempted (circuit breaker or abort before this batch)" },
        })),
      };
    },
    // 2026-09-10 修复: 原 90s 会让多 chunk 主题全部 abort(实测 12:05 一轮 ok=0 fail=6 aborted=true)
    { timeoutMs: Number(process.env.REFLECT_CRON_TIMEOUT_MS ?? "900000"), label: "reflect-cron" },
  );
}
