// 2026-11-19 F6 四态（B-01）：?state= 必须由**服务端**生效，否则 curl/截图判据看不到（客户端 window 读取只在 hydrate 后）。
//   约定：state ∈ {empty,error,unavailable,forbidden}；非法值一律忽略（回落真实取数，不静默变成某种态）。
export type ForcedState = "empty" | "error" | "unavailable" | "forbidden";

const ALLOWED: readonly string[] = ["empty", "error", "unavailable", "forbidden"];

export function parseForcedState(
  sp?: Record<string, string | string[] | undefined>
): ForcedState | null {
  const raw = sp?.state;
  const v = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (!v || !ALLOWED.includes(v)) return null;
  return v as ForcedState;
}
