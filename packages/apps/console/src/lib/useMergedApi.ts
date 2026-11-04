"use client";
// 2026-10-26：并行取多个 URL 并合并 rows 的小 hook。
// 为什么需要：mind 的 todos 接口**不支持多状态**（`status=OPEN,DOING` 返回空；重复 status 只取第一个），
//   而 /todo 的「未完成」tab 需要 OPEN + DOING 两个状态。若仍用「先取 status=ALL 再在客户端按
//   tab 过滤」，limit=500 的窗口会先被 4000+ 条 DONE/DROPPED 占满 —— 实测未完成 96 条一条都进不来，
//   页面显示「没有未完成待办 —— 清爽！」。所以必须**服务端按状态过滤、前端合并**。
// 语义与 lib/api.ts 的 useApi 对齐：带全局 nonce、只接受最新一次响应（序号守卫）、非 2xx 走 error。
import { useCallback, useEffect, useRef, useState } from "react";
import { useGlobalFilterValue } from "@/components/GlobalFilter";

export function useMergedApi<T = any>(urls: string[], opts?: { pollMs?: number }) {
  const gf = useGlobalFilterValue();
  const key = urls.join("|");
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    const withNonce = (p: string) => (gf?.nonce ? p + (p.includes("?") ? "&" : "?") + "_gf=" + gf.nonce : p);
    try {
      const res = await Promise.all(urls.map((u) =>
        fetch(withNonce(u)).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) }))
      ));
      const bad = res.find((r) => !r.ok);
      if (bad) throw new Error((bad.json as any)?.error || "请求失败（状态码 " + bad.status + "）");
      if (my !== seq.current) return;
      const first: any = res[0]?.json || {};
      const rows = res.flatMap((r: any) => (Array.isArray(r.json?.rows) ? r.json.rows : []));
      setData(Object.assign({}, first, { rows }) as T);
      setError(undefined);
    } catch (e) {
      if (my === seq.current) setError(e as Error);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const ms = opts?.pollMs;
    if (!ms) return;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [load, opts?.pollMs]);
  return { data, loading, error, mutate: load };
}
