/**
 * useWebSocket — 通用 WebSocket 订阅 hook
 *
 * 特性:
 *   - SSR 安全 (在 useEffect 内实例化, 不访问 window)
 *   - 自动重连, 指数退避: 1s, 2s, 4s, 8s, 16s, 30s (封顶)
 *   - 5s 静默无消息就 reconnect (防半死连接)
 *   - 连接状态: connecting | open | reconnecting | closed
 *   - 收到消息时按 type 字段分派: 框架消息 (welcome/subscribed/...) 走 onControl,
 *     业务帧 (update / bus-event / flywheel-event) 走 onMessage
 *   - 自动拼装 ?channels=a,b,c
 *
 * 用法:
 *   const { status, send } = useWebSocket("ws://localhost:3003", {
 *     channels: ["dashboard:overview", "flywheel:event"],
 *     onMessage: (msg) => {
 *       if (msg.channel === "dashboard:overview") {
 *         queryClient.setQueryData(["dashboard","overview"], msg.data);
 *       } else if (msg.channel === "flywheel:event") {
 *         // append-only
 *       }
 *     },
 *     onStatusChange: (s) => setStatus(s),
 *   });
 */
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WsFrame<T = any> {
  type: string;
  channel: string | null;
  data: T;
  ts: number;
}

export interface UseWebSocketOptions {
  channels?: string[];
  onMessage?: (frame: WsFrame) => void;
  onControl?: (frame: WsFrame) => void; // 框架消息(welcome / subscribed / pong)
  onStatusChange?: (status: WsStatus) => void;
  /** 静默超时 (ms), 默认 5000, 超过则强制重连 */
  silenceTimeoutMs?: number;
  /** 是否启用, 默认 true */
  enabled?: boolean;
}

const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000];

export function useWebSocket(
  url: string,
  options: UseWebSocketOptions = {}
): { status: WsStatus; send: (data: any) => void; reconnect: () => void } {
  const {
    channels = [],
    onMessage,
    onControl,
    onStatusChange,
    silenceTimeoutMs = 5000,
    enabled = true,
  } = options;

  const [status, setStatus] = useState<WsStatus>('connecting');
  const statusRef = useRef<WsStatus>('connecting');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelsRef = useRef<string[]>(channels);
  const callbacksRef = useRef({ onMessage, onControl, onStatusChange });
  const manualCloseRef = useRef(false);
  const enabledRef = useRef(enabled);

  // 保持最新回调
  useEffect(() => {
    callbacksRef.current = { onMessage, onControl, onStatusChange };
  }, [onMessage, onControl, onStatusChange]);

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const setAndEmitStatus = useCallback((s: WsStatus) => {
    if (statusRef.current === s) return;
    statusRef.current = s;
    setStatus(s);
    try { callbacksRef.current.onStatusChange?.(s); } catch {}
  }, []);

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const armSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      // 5s 没收到任何消息 → 视为死链
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try { wsRef.current.close(4000, 'silence-timeout'); } catch {}
      }
    }, silenceTimeoutMs);
  }, [silenceTimeoutMs]);

  const scheduleReconnect = useCallback(() => {
    if (manualCloseRef.current || !enabledRef.current) return;
    const idx = Math.min(reconnectAttemptsRef.current, BACKOFF_SCHEDULE.length - 1);
    const delay = BACKOFF_SCHEDULE[idx];
    reconnectAttemptsRef.current++;
    setAndEmitStatus('reconnecting');
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, delay);
  }, [setAndEmitStatus]);

  const connect = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (!enabledRef.current) return;
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
    setAndEmitStatus('connecting');

    const u = new URL(url, window.location.href);
    if (channelsRef.current.length > 0) {
      u.searchParams.set('channels', channelsRef.current.join(','));
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(u.toString());
    } catch (e) {
      err(`ws construct failed: ${(e as Error).message}`);
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setAndEmitStatus('open');
      armSilenceTimer();
    };

    ws.onmessage = (ev) => {
      armSilenceTimer();
      let frame: WsFrame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      // 框架消息 vs 业务帧
      if (
        frame.type === 'welcome' ||
        frame.type === 'subscribed' ||
        frame.type === 'unsubscribed' ||
        frame.type === 'pong' ||
        frame.type === 'connected'
      ) {
        try { callbacksRef.current.onControl?.(frame); } catch {}
        return;
      }
      try { callbacksRef.current.onMessage?.(frame); } catch {}
    };

    ws.onerror = () => {
      // onerror 之后必跟 onclose, 不在这里重连
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      if (manualCloseRef.current || !enabledRef.current) {
        setAndEmitStatus('closed');
      } else {
        scheduleReconnect();
      }
    };
  }, [url, armSilenceTimer, scheduleReconnect, setAndEmitStatus]);

  // 启动 / 清理
  useEffect(() => {
    if (typeof window === 'undefined') return;
    manualCloseRef.current = false;
    connect();
    return () => {
      manualCloseRef.current = true;
      clearTimers();
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
      setAndEmitStatus('closed');
    };
  }, [connect, clearTimers]);

  const send = useCallback((data: any) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch {}
    }
  }, []);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
    setAndEmitStatus('reconnecting');
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connect();
    }, 200);
  }, [connect, setAndEmitStatus]);

  return { status, send, reconnect };
}

function err(msg: string) {
  // eslint-disable-next-line no-console
  console.warn('[useWebSocket]', msg);
}
