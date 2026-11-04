"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useGlobalFilterValue } from "@/components/GlobalFilter";
import type { ApiResponse } from "./types";

// 业务看板取数：只读 /api/flywheel-business。60s 轮询 + 页面隐藏暂停 + 序号守卫。
// 与 useApi 的差别：支持 ?refresh=1（让服务端重生成业务快照），且返回快照自身的截止时刻。
export function useBusinessSnapshot() {
  const gf = useGlobalFilterValue();
  const [data, setData] = useState<ApiResponse | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (force = false) => {
    const my = ++seq.current;
    try {
      const qs = (force ? "?refresh=1" : "?") + (gf && gf.nonce ? (force ? "&" : "") + "_gf=" + gf.nonce : "");
      if (force) setRefreshing(true);
      const res = await fetch("/api/flywheel-business" + qs, { cache: "no-store" });
      const json = (await res.json()) as ApiResponse;
      if (my !== seq.current) return;
      if (!res.ok) throw new Error(json.error || "请求失败（状态码 " + res.status + "）");
      setData(json);
      setError(undefined);
      if (typeof window !== "undefined") {
        try { window.dispatchEvent(new CustomEvent("lions:data", { detail: { at: Date.now(), path: "/api/flywheel-business" } })); } catch { /* ignore */ }
      }
    } catch (e) {
      if (my === seq.current) setError(e as Error);
    } finally {
      if (my === seq.current) { setLoading(false); setRefreshing(false); }
    }
  }, [gf]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(false); }, 60000);
    return () => clearInterval(t);
  }, [load]);

  return { data, error, loading, refreshing, refresh: () => load(true), reload: () => load(false) };
}
