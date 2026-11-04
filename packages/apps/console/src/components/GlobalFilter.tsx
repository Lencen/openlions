"use client";
// 2026-09-10 商业化改版: 顶部全局筛选 (时间范围 / Agent / 主题)
// 状态存放在 React Context + localStorage, 新页面通过 useGlobalFilter() 读取并拼 query 给 API。
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Button, Select, Segmented, Tooltip } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { ReloadOutlined } from "@/components/primitives"; // 2026-09-18 antd 绞杀(同 API 形状)
import { t as tr } from "@/i18n";
import { usePathname } from "next/navigation";

export type RangeKey = "1h" | "24h" | "7d" | "30d" | "all";

export interface GlobalFilterValue {
  range: RangeKey;
  agent: string | null;
  theme: string | null;
}

interface Ctx extends GlobalFilterValue {
  setRange: (r: RangeKey) => void;
  setAgent: (a: string | null) => void;
  setTheme: (t: string | null) => void;
  reset: () => void;
  /** 拼好的查询串, 例: range=24h&agent=agent-operator (无筛选则为 range=24h) */
  query: string;
  /** 给 fetch 用的完整路径 */
  withQuery: (path: string) => string;
  /** 用户点"刷新"时自增, 页面 useApi 依赖它重新拉取 */
  nonce: number;
  refresh: () => void;
  /** 2026-10-13 round 76-CS: 本页是否**确实消费**了全局筛选(由 useGlobalFilter 自动登记, 无需维护路由清单)。
   *  为什么需要: 65 页里有 48 页展示的是"当前状态"(组织结构/权限矩阵/服务清单等) —— 时间范围对它们
   *  在语义上就**不该生效**; 但筛选条是全壳的, 用户会以为筛选坏了。这里让筛选条能自动判断并如实说明。 */
  consumedFor: string | null;
  currentPath: string;
  markConsumed: () => void;
}

const DEFAULT_VALUE: GlobalFilterValue = { range: "24h", agent: null, theme: null };
const STORAGE_KEY = "lions.console.globalFilter.v1";

const FilterCtx = createContext<Ctx>({
  ...DEFAULT_VALUE,
  setRange: () => {},
  setAgent: () => {},
  setTheme: () => {},
  reset: () => {},
  query: "range=24h",
  withQuery: (p) => p,
  nonce: 0,
  refresh: () => {},
  consumedFor: null,
  currentPath: "",
  markConsumed: () => {},
});

export const RANGE_OPTIONS: { label: string; value: RangeKey }[] = [
  { label: "近 1 小时", value: "1h" },
  { label: "近 24 小时", value: "24h" },
  { label: "近 7 天", value: "7d" },
  { label: "近 30 天", value: "30d" },
  { label: "全部", value: "all" },
];

export function GlobalFilterProvider({ children }: { children: React.ReactNode }) {
  const [value, setValue] = useState<GlobalFilterValue>(DEFAULT_VALUE);
  const [nonce, setNonce] = useState(0);
  // 2026-10-13 round 76-CS: 记录"哪个路由消费了筛选"; 用 pathname 做键, 导航到新页时自然失效
  const pathname = usePathname();
  const [consumedFor, setConsumedFor] = useState<string | null>(null);
  const markConsumed = useCallback(() => setConsumedFor(pathname), [pathname]);

  // 读取本地保存的筛选 (首屏后生效, 避免 SSR/CSR 不一致)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setValue({
          range: RANGE_OPTIONS.some((r) => r.value === parsed?.range) ? parsed.range : "24h",
          agent: typeof parsed?.agent === "string" ? parsed.agent : null,
          theme: typeof parsed?.theme === "string" ? parsed.theme : null,
        });
      }
    } catch { /* 本地存储不可用时使用默认值 */ }
  }, []);

  const persist = useCallback((next: GlobalFilterValue) => {
    setValue(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const ctxValue = useMemo<Ctx>(() => {
    const params = new URLSearchParams();
    params.set("range", value.range);
    if (value.agent) params.set("agent", value.agent);
    if (value.theme) params.set("theme", value.theme);
    const query = params.toString();
    return {
      ...value,
      setRange: (range) => persist({ ...value, range }),
      setAgent: (agent) => persist({ ...value, agent }),
      setTheme: (theme) => persist({ ...value, theme }),
      reset: () => persist(DEFAULT_VALUE),
      query,
      withQuery: (path: string) => (path.includes("?") ? path + "&" + query : path + "?" + query),
      nonce,
      refresh: () => setNonce((n) => n + 1),
      consumedFor,
      currentPath: pathname,
      markConsumed,
    };
  }, [value, persist, nonce, consumedFor, pathname, markConsumed]);

  return <FilterCtx.Provider value={ctxValue}>{children}</FilterCtx.Provider>;
}

/** 壳层组件(筛选条自己等)读取用 —— **不登记"消费"**, 否则筛选条会把自己算成消费方。 */
/** 2026-10-13 round 76-DK: 供**原生 fetch** 的页面接入全局刷新。
 *  76-DJ 已让 useApi 统一带上全局 nonce; 但仍有若干页面是**自己 fetch 且只挂载拉一次**,
 *  它们的数据只能靠刷新整页。用法: `const gf = useGlobalNonce();` 然后把 `&_gf=${gf}` 拼到 URL
 *  (服务端不关心该参数, 只作 cache-buster), 并把它放进 effect 依赖。
 *  非消费标记: 调它**不会**让本页被判定为"已消费时间范围"。 */
export function useGlobalNonce(): number {
  return useGlobalFilterValue().nonce;
}

export function useGlobalFilterValue(): Ctx {
  return useContext(FilterCtx);
}

/** 页面读取用 —— 会自动登记"本页消费了筛选", 供筛选条判断本页适不适用。 */
export function useGlobalFilter(): Ctx {
  const ctx = useContext(FilterCtx);
  // 2026-10-13 round 76-CS: **自动登记"本页消费了筛选"** —— 因此不需要维护一份会过时的路由清单。
  const mark = ctx.markConsumed;
  useEffect(() => { mark(); }, [mark]);
  return ctx;
}

interface Options {
  agents: { value: string; label: string; online?: boolean }[];
  themes: string[];
}

export function GlobalFilterBar() {
  // 2026-10-13 round 76-CS: 用**不登记**的读取口 —— 否则筛选条把自己算成"本页消费了筛选", 提示永远不显示。
  const f = useGlobalFilterValue();
  const [opts, setOpts] = useState<Options>({ agents: [], themes: [] });
  // 首屏不渲染时间文本, 避免 SSR/CSR 时间不一致导致的 hydration mismatch
  const [tick, setTick] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/filter-options")
      .then((r) => r.json())
      .then((d) => { if (alive) setOpts({ agents: d?.agents ?? [], themes: d?.themes ?? [] }); })
      .catch(() => { /* 选项拉取失败不影响筛选本身 */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    setTick(new Date());
    const t = setInterval(() => setTick(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const dirty = f.agent || f.theme || f.range !== "24h";
  // 2026-10-13 round 76-CS: 首屏后若本页**没有**消费全局筛选, 说明它展示的是"当前状态"(组织结构/权限矩阵/
  //   服务清单等) —— 时间范围对它不生效。明确说出来, 而不是让用户以为筛选坏了。
  //   (延迟 600ms 再显示, 避免消费页在 effect 登记之前闪一下提示。)
  const [armed, setArmed] = useState(false);
  useEffect(() => { const id = setTimeout(() => setArmed(true), 600); return () => clearTimeout(id); }, []);
  const applies = f.consumedFor === f.currentPath;

  return (
    <div className="global-filter" role="region" aria-label={tr('filter.region')}>
      {/* 2026-10-25 R3: 本页不消费全局筛选时**不渲染控件**。
          旧做法是照常渲染三个控件再补一句「（本页按当前状态展示，不受时间范围影响）」——
          等于承认控件是坏的（评审 §2 第 2 条：无效控件）。现在只保留时间戳与刷新。 */}
      {applies || !armed ? (
        <>
          <span className="gf-label">{tr('filter.range')}</span>
          <Segmented
            size="small"
            value={f.range}
            onChange={(v) => f.setRange(v as RangeKey)}
            options={RANGE_OPTIONS.map((r) => ({ label: r.label, value: r.value }))}
          />
          <span className="gf-label">{tr('filter.agent')}</span>
          <Select
            size="small"
            style={{ minWidth: 168 }}
            placeholder={tr('filter.allAgents')}
            allowClear
            showSearch
            optionFilterProp="label"
            value={f.agent ?? undefined}
            onChange={(v) => f.setAgent(v ?? null)}
            options={opts.agents}
            notFoundContent={tr('filter.noAgents')}
          />
          <span className="gf-label">{tr('filter.theme')}</span>
          <Select
            size="small"
            style={{ minWidth: 168 }}
            placeholder={tr('filter.allThemes')}
            allowClear
            showSearch
            optionFilterProp="label"
            value={f.theme ?? undefined}
            onChange={(v) => f.setTheme(v ?? null)}
            options={opts.themes.map((t) => ({ value: t, label: t }))}
            notFoundContent={tr('filter.noThemes')}
          />
          {dirty ? <Button size="small" type="link" onClick={f.reset}>{tr('filter.clear')}</Button> : null}
        </>
      ) : (
        <span className="gf-label" style={{ fontWeight: 400 }}>{tr('filter.notApplicable')}</span>
      )}
      <span className="gf-spacer" />
      <span className="gf-asof">{tr('common.dataTime')} {tick ? tick.toLocaleTimeString("zh-CN", { hour12: false }) : "--:--:--"}</span>
      <Tooltip title={tr('filter.refreshTip')}>
        <Button size="small" icon={<ReloadOutlined />} onClick={f.refresh}>{tr('common.refresh')}</Button>
      </Tooltip>
    </div>
  );
}
