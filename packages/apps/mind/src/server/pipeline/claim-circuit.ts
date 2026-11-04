/**
 * claim-circuit.ts — 按 agent 的认领熔断（2026-10-25）
 *
 * 背景：外部故障豁免（P2）之后，通道坏掉的 agent 会以"每个任务 10 分钟一次"的速度继续撞队列。
 *   冷却窗只保护单个任务，保护不了队列和 agent 本身。
 *   这里加一层按 agent 的熔断：同一 agent 在窗口内累计 N 次外部故障 -> 暂停它的认领 M 分钟。
 *
 * 设计取舍：
 *   - 内存计数（单进程）而不是查 FlywheelEvent —— 认领是热路径，不能每次都扫大表；
 *   - 只熔断**出故障的那个 agent**，不连累健康 agent；
 *   - 恢复靠时间窗口自然过期，不需要人工解锁。
 */
export type CircuitState = { paused: boolean; faults: number; retryAfterMs: number };

const WINDOW_MS = Math.max(60_000, Number(process.env.CLAIM_CIRCUIT_WINDOW_MS ?? 10 * 60_000));
const THRESHOLD = Math.max(1, Number(process.env.CLAIM_CIRCUIT_THRESHOLD ?? 10));
const PAUSE_MS = Math.max(60_000, Number(process.env.CLAIM_CIRCUIT_PAUSE_MS ?? 10 * 60_000));

const faultsByAgent = new Map<string, number[]>();
const pausedUntil = new Map<string, number>();

/** 纯函数：窗口内故障数是否达到阈值（单测用） */
export function shouldPause(timestamps: number[], now: number, opts?: { windowMs?: number; threshold?: number }): boolean {
  const w = opts?.windowMs ?? WINDOW_MS;
  const th = opts?.threshold ?? THRESHOLD;
  return timestamps.filter((t) => now - t <= w).length >= th;
}

export function noteExternalFault(agentId: string, now = Date.now()): CircuitState {
  const id = String(agentId || "").trim();
  if (!id) return { paused: false, faults: 0, retryAfterMs: 0 };
  const arr = (faultsByAgent.get(id) || []).filter((t) => now - t <= WINDOW_MS);
  arr.push(now);
  faultsByAgent.set(id, arr);
  if (shouldPause(arr, now)) {
    pausedUntil.set(id, now + PAUSE_MS);
    return { paused: true, faults: arr.length, retryAfterMs: PAUSE_MS };
  }
  return { paused: false, faults: arr.length, retryAfterMs: 0 };
}

export function circuitState(agentId: string, now = Date.now()): CircuitState {
  const id = String(agentId || "").trim();
  const until = pausedUntil.get(id) || 0;
  const arr = (faultsByAgent.get(id) || []).filter((t) => now - t <= WINDOW_MS);
  if (until > now) return { paused: true, faults: arr.length, retryAfterMs: until - now };
  return { paused: false, faults: arr.length, retryAfterMs: 0 };
}
