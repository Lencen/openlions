// Stub WebSocket client for legacy health page.
// Production should wire to a real WS endpoint or eventsource.
import { useEffect } from "react";

export type WsStatus = "connecting" | "open" | "closed" | "error";

export interface UseWebSocketOpts {
  onStatusChange?: (s: WsStatus) => void;
  // 遗留#8 (2026-09-01): onMessage 放宽为 any (stub 场景, 调用方自行防御字段), 消除 health 页 84 个连锁类型错误
  onMessage?: (data: any) => void;
  channels?: string[]; // stub 忽略, 保持调用方兼容
  url?: string;
}

export function useWebSocket(url: string | null, opts: UseWebSocketOpts = {}): void {
  useEffect(() => {
    // Stub: report 'closed' immediately. Health page falls back to polling.
    opts.onStatusChange?.("closed");
  }, [url, opts]);
}
