"use client";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 认知列表 (记忆/知识/反思/实践/技能) 的筛选状态与 URL 双向同步。
// 目的: "详情用小抽屉打开, 关掉后还在原来的列表位置和筛选条件"。
//   1) 抽屉就地打开 -> 列表组件不卸载, 搜索/排序/页码/滚动位置天然保持;
//   2) 状态写回 URL (history.replaceState, 不触发路由跳转) -> 刷新 / 深链接 / 返回都还在同一筛选下;
//   3) ?open=<id> 可直接带着筛选条件打开某条详情抽屉 (可分享的深链接)。
// 说明: 初始渲染用默认值, 挂载后再从 URL 读取, 避免 SSR/CSR 水合不一致 (与既有页面读 ?open= 的做法一致)。
import { useEffect, useRef, useState } from "react";

export type SortOrder = "asc" | "desc";

const asOrder = (v: string | null): SortOrder => (v === "asc" ? "asc" : "desc");

// 2026-09-14 UI-7: 认识的常用筛选键 (与后端 cognitive-quick-filter.ts 对齐)。
// URL 上的 ?quick= 只接受该表实际提供的键, 防止脏值/跨表键把请求带成 400。
const QUICK_KEYS = new Set(["highQuality", "recent7d", "referenced", "pendingReview"]);

export function useCognitiveListUrlState(opts?: { sortBy?: string; quickKeys?: string[] }) {
  const defaultSortBy = opts?.sortBy ?? "updatedAt";
  const allowedQuick = opts?.quickKeys ? new Set(opts.quickKeys) : null;
  const asQuick = (v: string | null): string | null =>
    v && QUICK_KEYS.has(v) && (!allowedQuick || allowedQuick.has(v)) ? v : null;
  const [search, setSearchRaw] = useState("");
  const [sortBy, setSortByRaw] = useState(defaultSortBy);
  const [sortOrder, setSortOrderRaw] = useState<SortOrder>("desc");
  const [page, setPageRaw] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [quick, setQuickRaw] = useState<string | null>(null);
  const synced = useRef(false);

  // 挂载后: 从 URL 恢复筛选/页码/打开的详情 (深链接与刷新)。
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const s = sp.get("search");
      if (s != null && s !== "") setSearchRaw(s);
      const sb = sp.get("sortBy");
      if (sb) setSortByRaw(sb);
      const so = sp.get("sortOrder");
      if (so) setSortOrderRaw(asOrder(so));
      const p = Number(sp.get("page"));
      if (Number.isFinite(p) && p >= 1) setPageRaw(Math.floor(p));
      const o = sp.get("open");
      if (o) setOpenId(o);
      const qk = asQuick(sp.get("quick"));
      if (qk) setQuickRaw(qk);
    } catch { /* ignore */ }
  }, []);

  // 状态变化后写回 URL (replaceState: 不新增历史记录, 不触发页面跳转)。
  // 首次运行(挂载)跳过, 让上面的恢复逻辑先生效。
  useEffect(() => {
    if (!synced.current) { synced.current = true; return; }
    try {
      const sp = new URLSearchParams(window.location.search);
      if (search) sp.set("search", search); else sp.delete("search");
      if (sortBy && sortBy !== defaultSortBy) sp.set("sortBy", sortBy); else sp.delete("sortBy");
      if (sortOrder !== "desc") sp.set("sortOrder", sortOrder); else sp.delete("sortOrder");
      if (page > 1) sp.set("page", String(page)); else sp.delete("page");
      if (openId) sp.set("open", openId); else sp.delete("open");
      if (quick) sp.set("quick", quick); else sp.delete("quick");
      const qs = sp.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
    } catch { /* ignore */ }
  }, [search, sortBy, sortOrder, page, openId, quick, defaultSortBy]);

  const setSearch = (v: string) => { setSearchRaw(v); setPageRaw(1); };
  const setSortBy = (v: string) => { setSortByRaw(v); setPageRaw(1); };
  const setSortOrder = (v: SortOrder) => { setSortOrderRaw(v); setPageRaw(1); };
  const setQuick = (v: string | null) => { setQuickRaw(asQuick(v)); setPageRaw(1); };

  return {
    search, sortBy, sortOrder, page, openId, quick,
    setSearch, setSortBy, setSortOrder, setPage: setPageRaw, setOpenId, setQuick,
    closeOpen: () => setOpenId(null),
  };
}
