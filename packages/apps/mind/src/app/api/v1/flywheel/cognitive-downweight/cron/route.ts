/**
 * GET /api/v1/flywheel/cognitive-downweight/cron — 认知表(M/K/Skill)降权/升权重算
 * =============================================================================================
 * 2026-10-16 新增。**为什么有这个端点**: `scripts/downweight-cognitive-rows.cjs` 原先直连账本写,
 * 被统一维护窗口闸门正确拒绝(rc=3) -> 每日 04:00 的降权业务停摆; 人类裁决
 * "暂停检修不是一个可持续的办法" + "需要改统一核心服务入库, 不能分散各写各的"。
 * 于是把它搬进核心服务(mind 是 DB-ACCESS-RULE 下唯一允许读写生产库的进程), 脚本改为 HTTP 调用方。
 *
 * 与既有 flywheel cron 端点的约定一致(不是新风格):
 *   · 路径族       `flywheel/improving-tasks/cron`、`flywheel/reflections/cron`、`flywheel/structured/cron`
 *                  -> 本端点 `flywheel/cognitive-downweight/cron`(同族同后缀)。
 *   · 鉴权         **与本族完全一致: 无 token**(本机调度器直连; 三个兄弟端点
 *                  improving-tasks/cron/route.ts:12、structured/cron/route.ts:10、
 *                  reflections/cron/route.ts:14 均不校验凭据, 只有花钱调 LLM 的 reflections 多一道
 *                  `requireFeature("flywheel.reflect")` 授权门; 本端点是纯 DB 重算, 与
 *                  improving-tasks/structured 同类 -> 不引入 requireFeature, 否则交付模式下会被 402 打死)。
 *   · 返回信封     `withCronTimeout(...)` -> `{ ok, aborted, data, durationMs }`
 *                  (server/pipeline/cron-with-timeout.ts:41-57, 三个兄弟端点同款)。
 *   · 超时         server 侧超时后返回 408 + `aborted=true`(同 withCronTimeout)。
 *   · 跳过开关     `XXX_ENABLED=false` -> `{skipped:true, reason}` 200(同 reflections/cron:17-20)。
 *
 * 用法:
 *   curl -s "http://127.0.0.1:3000/api/v1/flywheel/cognitive-downweight/cron"                        # 干跑(只读)
 *   curl -s "http://127.0.0.1:3000/api/v1/flywheel/cognitive-downweight/cron?apply=1"                # 真写
 *   curl -s "...?apply=1&halflife=90&floor=0.3&deep=0.05&details=1"
 *   curl -s "...?apply=1&force=1"     # 绕过 30min 冷却窗(不绕过"有人正在跑")
 * 参数:
 *   apply=1            真写(缺省 = 干跑, 只读; 与脚本的 --apply 对应)
 *   halflife/floor/deep  公式参数(默认 90 / 0.3 / 0.05, 与直连脚本默认值相同)
 *   details=1          返回逐行候选清单(验收逐行比对用)
 *   now=<epoch_ms>     **仅干跑**允许: 固定"现在"以便确定性比对(生产不带); apply=1 时忽略
 * 状态码(**任何路径都返回结构化 JSON; 不再有空 body 500**):
 *   200  执行完成(含干跑); `data.dryRun` 区分
 *   200  `{skipped:true}`        开关关闭
 *   409  ALREADY_RUNNING         已有执行在跑(>租约才可接管) -> 显式, 不静默
 *   409  ALREADY_RAN_RECENTLY    冷却窗(DOWNWEIGHT_MIN_INTERVAL_MS, 默认 30min)内已成功跑过; `?force=1` 绕过
 *   503  LEDGER_NOT_WRITABLE     账本冻结/只读(drop-in / db-state=corrupt / 冻结单点文件) -> 拒绝写
 *   503  LEDGER_UNREADABLE       账本**读不出来**(SQLITE_CORRUPT=11 / malformed) -> 拒绝写
 *   503  LEDGER_OPEN_GATE_REFUSED 开库世代闸门 fail-closed(scripts/lib/mind-db-open-gate.cjs 不可用)
 *   408  ABORTED 超时 / 500 ENDPOINT_ERROR(含 errorName/errorCode/phase/message; 栈只进服务端日志)
 *
 * 2026-10-16 线上复盘(首发后"重复调用 500"的修复, 证据在 verification/cognitive-downweight-endpoint-2026-10-16/07*):
 *   · 现象: 17:56 首次干跑 200; 18:04 再调 -> **空 body 500**。
 *   · 真因(原始栈): 账本在 18:04 起真的坏了(SqliteError extended_code=11 "database disk image is malformed"),
 *     平台范围内 `prisma.flywheelJob.*` 全在失败(structure-fragments 同款报错);
 *     而**锁认领 `acquireDownweightLock()` 当时在错误信封之外** -> 抛错逃出路由 -> Next 打空 body 500。
 *     **不是**"锁泄漏"(锁行实测 status=DONE/attempts=31) —— 但**是**端点自身的两个缺陷:
 *     ① 干跑也写库(建锁) ② 锁路径不在统一错误信封内。
 *   · 修法: 干跑**不建锁不写库**(真只读, 账本坏了也能预览); 全流程包统一 try/catch -> 结构化错误 + 服务端 stack;
 *     锁的终态在安全网里兜底; 每次执行在服务端留一行日志。
 * 可观测: 每次真跑留一条 `AuditLog`(action=COGNITIVE_DOWNWEIGHT_RUN, 经
 *   src/server/lib/audit-log.ts 的单一实现); 末次状态写回 `FlywheelJob`
 *   (idempotencyKey="cognitive-downweight:lock", 摘要落 error 列 —— 与
 *   structure-fragments.ts 的 markJobDone 同约定)。
 */
import { withCronTimeout } from "@/server/pipeline/cron-with-timeout";
import { recordAudit } from "@/server/lib/audit-log";
import {
  DOWNWEIGHT_ACTOR,
  DEFAULT_LOCK_LEASE_MS,
  DEFAULT_MIN_INTERVAL_MS,
  acquireDownweightLock,
  classifyLedgerError,
  finishDownweightLock,
  ledgerWriteRefusals,
  runCognitiveDownweight,
  summarizeRun,
} from "@/server/pipeline/cognitive-downweight";

export const dynamic = "force-dynamic";

function qNum(url: URL, key: string): string | undefined {
  const v = url.searchParams.get(key);
  return v === null || v === "" ? undefined : v;
}

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const runId = "dw_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  /**
   * 阶段标记: 出错时随结构化错误一起返回并在服务端日志里点名 ——
   *   2026-10-16 首发时 `flywheelJob.updateMany`(锁)在**错误信封之外**抛错 -> Next 返回空 body 500,
   *   客户端与日志都定位不到是哪一步。本函数保证:**任何**阶段抛错都转成结构化 JSON + 服务端 stack。
   */
  let phase = "init";
  let lockAcquired = false;
  let apply = false;

  try {
    // ① 跳过开关(与 reflections/cron 的 FLYWHEEL_*_ENABLED=false 同款)
    if (process.env.LIONS_COGNITIVE_DOWNWEIGHT_ENABLED === "false") {
      return Response.json({ skipped: true, reason: "LIONS_COGNITIVE_DOWNWEIGHT_ENABLED=false" });
    }

    // ② 参数
    apply = url.searchParams.get("apply") === "1" || url.searchParams.get("apply") === "true";
    // now 覆盖**只在干跑**下生效: apply 时一律用真实时间, 不给"写错时间"的机会
    const nowRaw = qNum(url, "now");
    const nowMs = !apply && nowRaw !== undefined && Number.isFinite(Number(nowRaw)) ? Number(nowRaw) : undefined;
    const details = url.searchParams.get("details") === "1" || url.searchParams.get("details") === "true";
    const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
    const halflife = qNum(url, "halflife");
    const floor = qNum(url, "floor");
    const deep = qNum(url, "deep");

    // ③ 账本写保护: 只有真写才判(干跑**只读**, 事故期也该能看数据)
    if (apply) {
      phase = "guard";
      const guard = ledgerWriteRefusals();
      if (guard.refused) {
        console.warn(
          "[cognitive-downweight] 拒绝写入(账本不可写): " + guard.reasons.join(" / ").slice(0, 400),
        );
        return Response.json(
          {
            ok: false,
            error: "LEDGER_NOT_WRITABLE",
            reasons: guard.reasons,
            notes: guard.notes,
            ledger: guard.paths,
            runId,
            durationMs: Date.now() - t0,
          },
          { status: 503 },
        );
      }
    }

    // ④ 并发/冷却(CAS 认领; 既有 FlywheelJob 约定)
    //    **干跑不建锁、不写库** —— 预览不该开写句柄(同 backfill-skill-describe-2026-10-09.cjs 的处置),
    //    否则"账本坏了/冻结了, 干跑照样能看数据"这条承诺不成立(首发缺陷就是它)。
    if (apply) {
      phase = "lock";
      const leaseMs = Math.max(60_000, Number(process.env.DOWNWEIGHT_LOCK_LEASE_MS ?? DEFAULT_LOCK_LEASE_MS));
      const minIntervalMs = Math.max(0, Number(process.env.DOWNWEIGHT_MIN_INTERVAL_MS ?? DEFAULT_MIN_INTERVAL_MS));
      const lock = await acquireDownweightLock(leaseMs, DOWNWEIGHT_ACTOR, { minIntervalMs, force });
      if (!lock.acquired) {
        return Response.json(
          {
            ok: false,
            error: lock.reason || "ALREADY_RUNNING",
            heldSince: lock.heldSince,
            lastCompletedAt: lock.lastCompletedAt,
            lastSummary: lock.lastSummary,
            leaseMs,
            minIntervalMs,
            runId,
            durationMs: Date.now() - t0,
          },
          { status: 409 },
        );
      }
      lockAcquired = true;
    }

    // ⑤ 主体: 与本族其它 cron 端点同款信封(withCronTimeout)
    phase = "run";
    return await withCronTimeout(
      async (signal) => {
        try {
          phase = "scan";
          const result = await runCognitiveDownweight({ apply, halflife, floor, deep, nowMs, details, signal });
          phase = "record";
          // 每次执行留一条可查记录(经平台审计单一实现; 审计失败只记日志, 不吞掉业务结果 —— 同 ingest 的
          //   FlywheelEvent "事件是观测, 不该阻断写入" 约定, 见 api/v1/ingest/route.ts:57-70)
          await recordAudit({
            entityType: "CognitiveDownweight",
            entityId: runId,
            action: "COGNITIVE_DOWNWEIGHT_RUN",
            actor: DOWNWEIGHT_ACTOR,
            actorType: "CRON",
            after: summarizeRun(result).slice(0, 500),
            metadata: {
              runId,
              dryRun: result.dryRun,
              params: result.params,
              nowMs: result.nowMs,
              scanned: result.scanned,
              wouldUpdate: result.wouldUpdate,
              updated: result.updated,
              skipped: result.skipped,
              unchanged: result.unchanged,
              protected: result.protected,
              practiceScanned: result.practiceScanned,
              tables: result.tables.map((t) => ({
                table: t.table,
                scanned: t.scanned,
                wouldWarm: t.wouldWarm,
                wouldCold: t.wouldCold,
                wouldDeep: t.wouldDeep,
                protectedHotGlobal: t.protectedHotGlobal,
                wouldUpdate: t.wouldUpdate,
                updated: t.updated,
                skipped: t.skipped,
              })),
              durationMs: result.durationMs,
              actor: DOWNWEIGHT_ACTOR,
            },
          });
          if (lockAcquired) {
            phase = "finish";
            await finishDownweightLock("DONE", summarizeRun(result));
            // 关键: 终态已写 -> 关掉安全网开关(否则 finally 会把刚写的 DONE 又改成 FAILED)
            lockAcquired = false;
          }
          // 每次执行在服务端**留一行**(首发时 31 次成功一条日志都没有, 只能靠 DB 里的审计行倒推)
          console.log(
            "[cognitive-downweight] " + summarizeRun(result) +
            " dryRun=" + result.dryRun + " runId=" + runId + " durationMs=" + (Date.now() - t0),
          );
          return result;
        } catch (e: any) {
          // 失败显式: 锁标 FAILED 后**继续向上抛**(由外层统一转结构化错误), 绝不吞
          if (lockAcquired) {
            try {
              await finishDownweightLock(
                "FAILED",
                "ERROR@" + phase + " " + String(e?.name || "") + " " + String(e?.message || e).slice(0, 260),
              );
              lockAcquired = false;
            } catch (e2: any) {
              console.error("[cognitive-downweight] 锁置 FAILED 也失败: " + String(e2?.message || e2).slice(0, 200));
            }
          }
          throw e;
        }
      },
      // 与 reflections/cron 同量级的 server 侧超时(全表扫描实测 ~1s, 留足余量)
      { timeoutMs: Number(process.env.DOWNWEIGHT_CRON_TIMEOUT_MS ?? 900_000), label: "cognitive-downweight" },
    );
  } catch (e: any) {
    // ⑥ **统一错误信封**: 结构化 + 准确状态码 + 服务端 stack(不再有空 body 500)
    const info = classifyLedgerError(e);
    console.error(
      "[cognitive-downweight] 端点异常 phase=" + phase + " runId=" + runId +
      " -> " + info.error + "(" + info.status + ") " + info.errorName + " " + (info.errorCode || ""),
    );
    console.error(e?.stack || String(e));
    return Response.json(
      {
        ok: false,
        error: info.error,
        errorName: info.errorName,
        errorCode: info.errorCode,
        phase,
        message: info.message,
        dryRun: !apply,
        runId,
        durationMs: Date.now() - t0,
      },
      { status: info.status },
    );
  } finally {
    // ⑦ 安全网: 只兜"**本次**拿到了锁却仍停在 PROCESSING"的情况(超时/进程中断/异常路径漏标)
    if (lockAcquired) {
      try {
        await finishDownweightLock("FAILED", "UNFINISHED(超时或异常路径漏标终态, runId=" + runId + ")");
        console.warn("[cognitive-downweight] 安全网: 锁被标记 FAILED(runId=" + runId + ")");
      } catch { /* 兜底失败不覆盖上面的显式错误 */ }
    }
  }
}
