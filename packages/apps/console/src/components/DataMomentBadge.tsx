"use client";
// 2026-10-15（round 76-GP, 规范铁律 2「每个数字带数据时刻」）**系统性的做法**。
//   背景: 我此前逐页手加 asOf(补了 12 页), 而全站普查显示 66 个路由里至少 53 个没有 ✗。
//   做法: lib/api.ts 在**任何一次成功取数**时广播 `lions:data`; 这里监听并显示
//         「本页数据取自 HH:MM:SS」—— 一处实现, 全站生效。
//   语义: 说的是"**这份数据是什么时候取的**"（= 取数时刻）✓;
//         **不是**"上游数据本身多新" ✗ —— 所以文案用「取自」而不是「截至」, 不夸大 ✓。
import { useEffect, useState } from "react";

export default function DataMomentBadge() {
  // 2026-10-15（round 76-GT）**兜底: 用"页面打开时刻"**。
  //   76-GS 的普查显示: 66 个路由里有 9 个没有这个徽标, 其中 8 个是 /agents 系页面 ——
  //   它们很可能是**服务端组件**(渲染时才取数, 浏览器里根本不发 /api/ 请求) ✗,
  //   而本徽标的机制是"观察浏览器里的取数" ✓ -> 它们**天然拿不到** ✗。
  //   这里补一个诚实的兜底: 若还没有观察到任何取数, 就显示**页面打开的时刻** ——
  //   对服务端渲染的页面来说, **那正是数据被取回的时刻** ✓, 语义不变 ✓。
  const [at, setAt] = useState<number | null>(null);   // 首帧与 SSR 一致(都是 null) -> 避免水合不一致 ✗
  const [count, setCount] = useState(0);

  useEffect(() => {
    // 2026-10-15（round 76-GP 再续）**只靠 useApi/useLazyApi 不够**：
    //   实测 /audit 与 /flywheel/logs 正文已渲染完整(1340 / 4323 字)却仍没有这个徽标 ✗，
    //   因为它们**自己写 fetch** ✗。=> 在**外壳**里统一观察 window.fetch ✓，一处覆盖所有页面 ✓。
    //   纪律: **只观察, 绝不改行为** —— 原样返回原 promise, 观察代码自身抛错也不外传 ✓；
    //         并且只认**同源 /api/** 的请求(页面数据), 不把静态资源/导航算进来 ✓。
    const orig = window.fetch;
    if (!(orig as any).__lionsWrapped) {
      const wrapped: typeof window.fetch = function (input: any, init?: any) {
        const pr = orig.call(window, input, init);
        try {
          const url = typeof input === "string" ? input : (input && input.url) || "";
          if (url.includes("/api/")) {
            pr.then((res: Response) => {
              if (res && res.ok) {
                window.dispatchEvent(new CustomEvent("lions:data", { detail: { at: Date.now(), path: url } }));
              }
            }).catch(() => { /* 失败不广播, 也不外传 */ });
          }
        } catch { /* 观察失败绝不影响请求 */ }
        return pr;
      } as typeof window.fetch;
      (wrapped as any).__lionsWrapped = true;
      window.fetch = wrapped;
    }
    const onData = (e: Event) => {
      const d = (e as CustomEvent).detail as { at?: number } | undefined;
      if (d && typeof d.at === "number") { setAt(d.at); setCount((n) => n + 1); }
    };
    // 兜底: 挂载时若还没有任何取数事件, 用**页面打开时刻** —— 对服务端组件而言那就是取数时刻 ✓。
    //   放在 effect 里(而不是 useState 初值)是为了**避免水合不一致** ✗。
    setAt((v) => (v === null ? Date.now() : v));
    window.addEventListener("lions:data", onData as EventListener);
    return () => window.removeEventListener("lions:data", onData as EventListener);
  }, []);

  // at 现在总有一个值(兜底=页面打开时刻) ✓; 只有在完全无法确定时才不显示。
  if (at === null) return null;
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return (
    // 2026-10-15（round 76-GV）**把"来源"标出来**, 好让普查能区分两种情形:
    //   76-GT 加了兜底之后, 每页都会显示时刻 -> 普查再也分不出"真有取数"与"只有兜底" ✗。
    //   这里在 title 里写清来源(data-source), 普查读 title 即可分别统计 ✓。
    <span
      className="tiny"
      data-source={count > 0 ? "fetch" : "open"}
      title={"来源: " + (count > 0 ? "本页接口取数" : "页面打开时刻") + "；本页共 " + count + " 次成功取数"}
      style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}
    >
      本页数据取自 {hh}:{mm}:{ss}
    </span>
  );
}
