"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useGlobalFilterValue } from "@/components/GlobalFilter";

// 2026-10-13 round 76-CD: 加 opts.pollMs —— 有些页面(如用量看板)只要**按需重取**, 不需要 10s 轮询;
//   此前这些页面只能自己手写 fetch, 于是**必须自己再实现一遍序号守卫**(76-CA/CB/CC 连踩三次)。
//   有了 pollMs: 0, 它们可以直接用 useApi 拿到"带守卫的按需拉取", 不必再手写。
export function useApi<T>(path: string, opts?: { pollMs?: number }) {
  // 2026-10-13 round 76-DJ: **统一接入全局刷新**。
  //   此前只有少数页面在自己拼 URL 时带上 nonce; 实测 41 个用 useApi 的客户端组件里,
  //   **28 个完全没有 nonce** -> 点顶栏的「刷新」对它们**毫无作用**(只有切筛选/切范围时才重取)。
  //   这里在 hook 内部把全局 nonce 拼到 URL 上 —— 一处改动覆盖全站;
  //   无 provider 时默认 ctx.nonce=0, URL 不变, 行为与改动前一致。
  const gf = useGlobalFilterValue();
  const pathWithNonce = gf && gf.nonce ? path + (path.includes("?") ? "&" : "?") + "_gf=" + gf.nonce : path;
  const pollMs = opts?.pollMs ?? 10000;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // 2026-09-15 UI-7 D1 修复(独立复核 REJECTED): 只接受"最新一次请求"的响应。
  //   根因: 深链接/刷新 ?quick=<x> 时, 首帧先发**未过滤**请求, 挂载后 effect 再从 URL 恢复 quick 并发过滤请求;
  //   两个请求并发, 未过滤响应若晚到会 setData 覆盖已渲染的过滤结果 -> URL/chip 显示已筛选, 列表却是全量。
  //   修法: 每次请求领一个自增序号, 响应回来时序号不是最新则丢弃(不再 setData/setLoading)。
  const seq = useRef(0);

  const fetchData = useCallback(async () => {
    const my = ++seq.current;
    try {
      const res = await fetch(pathWithNonce);
      const json = await res.json();
      // 2026-10-13 round 76-O: HTTP 非 2xx 也走 error 通道。
      //   此前只 catch fetch/json 抛错 -> 接口返回 500 + JSON 错误体时走到 setData(错误体),
      //   页面把错误体当数据渲染(0/空表/假空态), 与"接口挂了"一样是静默失败。
      if (!res.ok) {
        const detail = (json as any)?.error;
        throw new Error(detail ? String(detail) : "请求失败（状态码 " + res.status + "）");
      }
      if (my !== seq.current) return; // 已被更新的请求取代(如 ?quick= 恢复) -> 丢弃过期响应
      setData(json);
      // 2026-10-15（round 76-FF）**修一个"错误状态粘住"的系统性 bug**：
      //   此前只在失败时 setError, **成功时从不清** -> 一旦某页出过错, error 就永远留着,
      //   用户点[重试]之后**数据明明回来了、红色错误横幅却一直挂在页面上** ✗（实测复现）。
      //   useLazyApi 本来就是清的(见其 67/72 行), useApi 漏了。
      setError(undefined);
      // 2026-10-15（round 76-GP, 规范铁律 2）**系统性地提供"数据时刻"**：
      //   我此前是**逐页手加** asOf(补了 12 页就以为差不多了) ✗ —— 而全站普查显示 66 个路由里
      //   至少 53 个没有 ✗。逐页手加不可持续。
      //   这里在"**任何一次成功取数**"时广播一个事件 -> 外壳里的 DataMomentBadge 统一显示
      //   「本页数据取自 HH:MM:SS」 ✓ —— **一处实现, 全站每一页都有** ✓。
      //   语义诚实: 它说的是"**这份数据是什么时候取的**" ✓（与我给 BFF 加 asOf 的语义一致 ✓），
      //   而**不是**"上游数据本身多新" ✗。
      if (typeof window !== "undefined") {
        try { window.dispatchEvent(new CustomEvent("lions:data", { detail: { at: Date.now(), path } })); } catch { /* 事件派发失败不影响取数 */ }
      }
    } catch (e) {
      if (my === seq.current) setError(e as Error);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [pathWithNonce]); // 76-DJ: 依赖带 nonce 的 URL, 否则全局刷新会因闭包过期而不生效

  useEffect(() => {
    fetchData();
    if (!pollMs) return; // pollMs=0 -> 只按需拉取(不发轮询)
    // P1-2 (2026-09-07): 页面隐藏(标签切走/最小化)时跳过轮询, 减少空转请求/CPU
    const interval = setInterval(() => { if (!document.hidden) fetchData(); }, pollMs);
    return () => clearInterval(interval);
  }, [fetchData, pollMs]);

  return { data, error, loading, mutate: fetchData };
}

/** 按需拉取 (path 为 null 时不发请求), 用于"点开某条记录看详情"的场景 */
export function useLazyApi<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    if (!path) {
      setData(undefined);
      setError(undefined);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(undefined);
    // 2026-10-13 round 76-P: 与 useApi 同法, 非 2xx 也走 error 通道(此前静默为空 -> 抽屉显示"读取中…")
    fetch(path)
      .then(async (r) => {
        const json = await r.json().catch(() => null);
        if (!r.ok) {
          const detail = (json as any)?.error;
          throw new Error(detail ? String(detail) : "请求失败（状态码 " + r.status + "）");
        }
        return json;
      })
      .then((d) => {
        if (alive) {
          setData(d as T);
          // 2026-10-15（round 76-GP 续）**补上 useLazyApi 这一路**：
          //   实测只改 useApi 时, 6 个"此前没有数据时刻"的页面里只有 3 个出现了「本页数据取自 …」✗，
          //   因为另外几页走的是 useLazyApi / 自己写的 fetch ✗。这里补上 useLazyApi 的广播。
          if (typeof window !== "undefined") {
            try { window.dispatchEvent(new CustomEvent("lions:data", { detail: { at: Date.now(), path } })); } catch { /* 不影响取数 */ }
          }
        }
      })
      .catch((e) => { if (alive) { setData(undefined); setError(e as Error); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [path]);

  return { data, loading, error };
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return res.json();
}
