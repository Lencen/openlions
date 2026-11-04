"use client";
// 2026-10-19 B3(方案 L3-3): **视图状态进 URL** 的通用小 hook。
//   为什么要有它: 全站 17 个"视图筛选页"里, 13 个本来就有 URL 能力 ✓, 但另有 4 个页面
//   **一个 URL API 都没用**(实测判据: 没有 window.location / URLSearchParams / useSearchParams / router.*
//   就**不可能**同步), 导致"筛选后的视图"没法分享、后退也不回退。
//   三处以上同类需求 -> 抽一个 hook, 而不是每页抄 20 行 ✗。
//
//   做法与仓库既有惯例一致(/system/guards、/audit/daily-summary):
//     · 用 window.location / URLSearchParams 读, **不引 useSearchParams**
//       (静态预渲染的页面引它会被要求加 Suspense 边界 ✗);
//     · 监听 popstate -> 浏览器前进/后退时把 URL 同步回状态, 且**参数缺失时回到初始值**
//       (漏了这条会导致后退不跟随, 实测踩过 ✗);
//     · 默认用 replace 写(筛选是"原地微调", 不该灌满历史); 需要"每次变化都可后退"时传 push。
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

export function useUrlParam(key: string, initial: string, mode: "replace" | "push" = "replace") {
  const [value, setValue] = useState(initial);
  const router = useRouter();
  const pathname = usePathname() || "/";

  useEffect(() => {
    const read = () => {
      try {
        const v = new URLSearchParams(window.location.search).get(key);
        setValue(v ?? initial);
      } catch {}
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [key, initial]);

  const set = useCallback(
    (v: string) => {
      setValue(v);
      try {
        const u = new URLSearchParams(window.location.search);
        if (v) u.set(key, v);
        else u.delete(key);
        const qs = u.toString();
        const url = pathname + (qs ? "?" + qs : "");
        if (mode === "push") router.push(url, { scroll: false });
        else router.replace(url, { scroll: false });
      } catch {}
    },
    [key, mode, pathname, router]
  );

  return [value, set] as const;
}
