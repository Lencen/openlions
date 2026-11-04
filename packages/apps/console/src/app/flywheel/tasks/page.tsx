"use client";
// 2026-09-14 页面瘦身: 分节控件抽到 ./_components/*, 本文件只负责取数与拼装 (<200 行)。
import { useEffect, useState } from "react";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { useApi } from "@/lib/api";
import { TASK_SCOPES } from "@/config/taskScopes";
import TasksHeader from "./_components/TasksHeader";
import TasksFilters from "./_components/TasksFilters";
import TasksTable from "./_components/TasksTable";
import QueueBoundary from "@/components/common/QueueBoundary";
import type { Counts, Detail, Item, ScopeCount } from "./_components/shared";
import ErrorAlert from "@/components/ErrorAlert";

export default function TasksBoard() {
  const [scope, setScope] = useState("ALL");        // 2026-09-10 任务语义分层: 全部/机制修复/验证/对话/其他
  const [status, setStatus] = useState("ALL");
  const [type, setType] = useState("");
  const [themeQ, setThemeQ] = useState("");
  // 2026-10-13 (round 75-H): 该页原来只有 loading, 主列表 fetch 的 catch 是 /* ignore */
  //   -> 加载失败与【加载中】在界面上无法区分。
  // 2026-10-13 (round 76-CF): 主列表改用 useApi(path, { pollMs: 0 }) —— path 由本地筛选 + 顶栏 range 拼成,
  //   它自带**序号守卫**与非 2xx 错误通道, 于是删掉手写的 alive 守卫。详情仍按需手拉。
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  // 2026-10-13 round 76-BG: 接入全局时间范围(用户决策③)。该页原来自成一套 filter, 完全无视顶栏 range。
  const f = useGlobalFilter();

  const qs = (() => {
    const q = new URLSearchParams({ status, scope, limit: "300", range: f.range });
    if (type) q.set("type", type);
    if (themeQ.trim()) q.set("theme", themeQ.trim());
    return q.toString();
  })();
  const { data: raw, error: fetchErr, loading, mutate } = useApi<any>("/api/flywheel-tasks?" + qs, { pollMs: 0 });
  const data = raw ? {
    items: (raw.items ?? []) as Item[],
    counts: (raw.counts ?? { byStatus: {}, byType: {}, total: 0 }) as Counts,
    scopeCounts: (raw.scopeCounts ?? {}) as Record<string, ScopeCount>,
    scopeTypes: (raw.scopeTypes ?? []) as string[],
  } : null;
  const err = fetchErr ? String((fetchErr as Error)?.message || fetchErr) : null;

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const f = sp.get("focus");
      if (f) { setExpandedId(f); fetchDetail(f); }
      // 2026-09-10: 支持从任务详情页"查看同类任务"带 scope 跳进来
      const sc = sp.get("scope");
      // 2026-10-19 B5: 补 ?status= 支持 —— 否则「看失败的任务」这类下钻链接点进来**不过滤** ✗（实测踩到）
      const st = sp.get("status");
      if (st) setStatus(st);
      if (sc && TASK_SCOPES.some((s) => s.key === sc)) setScope(sc);
    } catch { /* ignore */ }
  }, []);

  const fetchDetail = async (id: string) => {
    if (details[id]) return;
    setDetailLoading(id);
    try {
      const res = await fetch("/api/flywheel-tasks?detail=" + encodeURIComponent(id), { cache: "no-store" });
      const d = await res.json();
      setDetails((prev) => ({ ...prev, [id]: d }));
    } catch { /* ignore */ }
    setDetailLoading(null);
  };

  const toggle = (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    fetchDetail(id);
  };

  const counts = data?.counts ?? { byStatus: {}, byType: {}, total: 0 };
  const items = data?.items ?? [];
  const scopeCounts = data?.scopeCounts ?? {};

  return (
    <div className="layout-with-sidebar"><main className="main">
      <TasksHeader loading={loading} counts={counts} itemCount={items.length} />
      {err ? <div style={{ padding: "var(--sp-2) var(--sp-4)" }}><ErrorAlert title="任务列表加载失败" message={String(err)} onRetry={() => { mutate(); }} /></div> : null}
      {/* UI-9: 说清「改进任务」与「待办」的区别 (从哪来 / 谁做) */}
      <QueueBoundary current="task" />
      <TasksFilters
        scope={scope}
        status={status}
        type={type}
        themeQ={themeQ}
        setScope={setScope}
        setType={setType}
        setStatus={setStatus}
        setThemeQ={setThemeQ}
        counts={counts}
        scopeCounts={scopeCounts}
        scopeTypes={data?.scopeTypes}
      />
      <TasksTable
        items={items}
        loading={loading}
        expandedId={expandedId}
        details={details}
        detailLoading={detailLoading}
        onToggle={toggle}
      />
    </main></div>
  );
}
