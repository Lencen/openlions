import type { ReactNode } from "react";

/** 指标值：有值 或 n/a+原因（禁 0 冒充、禁「—」占位）。 */
export type Metric<T = ReactNode> =
  | { kind: "value"; value: T; unit?: string; hint?: ReactNode; asOf?: string | null; tone?: "info" | "ok" | "warn" | "crit" | "mute" }
  | { kind: "na"; reason: string };

/** 看板数据态（empty ≠ unavailable）。 */
export type BoardPhase = "loading" | "ok" | "empty" | "error" | "unavailable" | "forbidden";

export interface BoardStateInfo { phase: BoardPhase; title?: string; detail?: string; }
