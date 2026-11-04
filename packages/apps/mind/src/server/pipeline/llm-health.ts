/**
 * llm-health.ts — LLM API 健康探针 (2026-09-01)
 *
 * 背景 (FLYWHEEL-HEALTH-REVIEW / FIX-PLAN-FLYWHEEL-LOGIC):
 *   MiniMax API 故障窗口 (如 2026-09-01 00:00–13:00, 16:00–18:00) 期间,
 *   反思 cron 每小时整点照常触发, 20 主题 × 3 并发全部撞 API 失败,
 *   白白消耗调用次数 (按调用计费的 Token Plan)。
 *
 * 方案:
 *   - 连续 N 次 LLM 调用失败 → 暂停反思 1h (pausedUntil)
 *   - 暂停期间 cron/autoTrigger 直接跳过, 不调 LLM
 *   - 任意一次成功 → 计数清零并立即解除暂停 (API 恢复即自愈)
 *   - 暂停到期后: FAILED 主题会被 findThemesNeedingReflection 重新捞起 (补跑)
 *
 * 只依赖进程内状态 (无需 DB), 重启即重置为健康态 — 简单且符合探针定位。
 */
let consecutiveFailures = 0;
let pausedUntil = 0;

const FAIL_THRESHOLD = 5;              // 连续失败阈值 (5 次 chunk/主题失败)
const PAUSE_DURATION_MS = 60 * 60 * 1000; // 暂停时长 1h

/** 记录一次 LLM 失败; 达到阈值即触发暂停 */
export function recordLlmFailure(reason?: string): void {
  consecutiveFailures++;
  if (consecutiveFailures >= FAIL_THRESHOLD && pausedUntil === 0) {
    pausedUntil = Date.now() + PAUSE_DURATION_MS;
    console.warn(
      `[llm-health] 连续 ${consecutiveFailures} 次 LLM 失败, 暂停反思 ${PAUSE_DURATION_MS / 60000}min` +
        (reason ? ` (last: ${reason.slice(0, 80)})` : "")
    );
  }
}

/** 记录一次 LLM 成功; 清零计数并立即解除暂停 */
export function recordLlmSuccess(): void {
  if (consecutiveFailures >= FAIL_THRESHOLD || pausedUntil !== 0) {
    console.log(`[llm-health] LLM 恢复, 解除暂停 (连续失败 ${consecutiveFailures} 次后)`);
  }
  consecutiveFailures = 0;
  pausedUntil = 0;
}

/** 反思是否处于暂停期 */
export function isReflectionPaused(): boolean {
  if (pausedUntil === 0) return false;
  if (Date.now() >= pausedUntil) {
    pausedUntil = 0;
    consecutiveFailures = 0;
    console.log("[llm-health] 暂停期结束, 反思恢复 (FAILED 主题将被补跑)");
    return false;
  }
  return true;
}

/** 剩余暂停毫秒 (用于观测) */
export function getPauseRemainingMs(): number {
  return pausedUntil === 0 ? 0 : Math.max(0, pausedUntil - Date.now());
}

export function getLlmHealthState() {
  return {
    consecutiveFailures,
    paused: isReflectionPaused(),
    pauseRemainingMs: getPauseRemainingMs(),
  };
}
