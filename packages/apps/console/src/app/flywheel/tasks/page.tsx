"use client";
// /flywheel/tasks —— P1 试点页呈现层改造（ord-20261104-032 · 列表模板 A）
// 区块顺序：页头 → 指标带(≤4) → 工具条(作用域 FilterBar + 状态 FilterBar + 搜索/类型/排序) → DataTable → 计数
// 只动呈现层：取数（/api/flywheel-tasks?...，含 status/scope/type/theme/range/limit 参数）与字段口径一行未改。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { useApi } from "@/lib/api";
import { TASK_SCOPES } from "@/config/taskScopes";
import QueueBoundary from "@/components/common/QueueBoundary";
import TableCopyButton from "@/components/TableCopyButton";
import DataMoment from "@/components/DataMoment";
import { Select } from "@/components/primitives";
import { PageHeader, PageTitle, KpiCard, DataTable, FilterBar, StateBlock, Pill } from "@/components/ui";
import TaskDetailPanel from "./_components/TaskDetailPanel";
import RowClick from "./_components/RowClick";
import { buildTaskColumns } from "./_components/taskColumns";
import { fmtNum } from "./_components/shared";
import type { Counts, Detail, Item, ScopeCount } from "./_components/shared";
import styles from "./page.module.css";

/** 四态之「无权限」：API 401/403 或错误文案带权限字样时整页替换（TEMPLATES §1）。 */
const FORBIDDEN_RE = /401|403|无权限|未授权/;

const STATUS_TABS: Array<[string, string]> = [
  ["ALL", "全部"],
  ["PENDING", "待做"],
  ["IN_PROGRESS", "进行中"],
  ["DONE", "完成"],
  ["FAILED", "失败"],
];

const SORTS = [
  { value: "created", label: "创建时间倒序（默认）" },
  { value: "updated", label: "更新时间倒序" },
  { value: "priority", label: "优先级 P0→P2" },
];

export default function TasksBoard() {
  const [scope, setScope] = useState("ALL"); // 2026-09-10 任务语义分层: 全部/机制修复/验证/对话/其他
  const [status, setStatus] = useState("ALL");
  const [type, setType] = useState("");
  const [qInput, setQInput] = useState("");
  // 服务端过滤参数 theme 仍由这个值驱动；只是把「每次按键就发请求」改成 250ms 防抖（模板 A §搜索）。
  const [themeQ, setThemeQ] = useState("");
  const [sort, setSort] = useState("created");
  // 2026-10-13 (round 75-H): 该页原来只有 loading, 主列表 fetch 的 catch 是 /* ignore */
  //   -> 加载失败与【加载中】在界面上无法区分。
  // 2026-10-13 (round 76-CF): 主列表改用 useApi(path, { pollMs: 0 }) —— path 由本地筛选 + 顶栏 range 拼成,
  //   它自带**序号守卫**与非 2xx 错误通道, 于是删掉手写的 alive 守卫。详情仍按需手拉。
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null);
  // 2026-10-13 round 76-BG: 接入全局时间范围(用户决策③)。该页原来自成一套 filter, 完全无视顶栏 range。
  const f = useGlobalFilter();
  // 2026-11-05（数据卡 7 §6）：积压数取 FlywheelJob 队列（既有只读端点 /api/flywheel-flow 的 queues）。
  //   完成(7d) / 失败(7d) / P95(7d) 在 console 没有只读接口 -> 卡片显示「不可得」+ 原因，不写 0。
  const flowQ = useApi<any>("/api/flywheel-flow", { pollMs: 0 });
  // 2026-11-06（数据卡 7 §6）：完成/失败/P95 的只读值改由 /api/flywheel/tasks-metrics 提供；
  //   取不到仍是「不可得 + 原因」，绝不写 0（与卡 7 的 n/a 规则一致）。
  const tmQ = useApi<any>("/api/flywheel/tasks-metrics", { pollMs: 60000 });

  useEffect(() => {
    const id = setTimeout(() => setThemeQ(qInput.trim()), 250);
    return () => clearTimeout(id);
  }, [qInput]);

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
  const forbidden = FORBIDDEN_RE.test(err || "");

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const focus = sp.get("focus");
      if (focus) { setExpandedId(focus); fetchDetail(focus); }
      // 2026-09-10: 支持从任务详情页"查看同类任务"带 scope 跳进来
      const sc = sp.get("scope");
      // 2026-10-19 B5: 补 ?status= 支持 —— 否则「看失败的任务」这类下钻链接点进来**不过滤** ✗（实测踩到）
      const st = sp.get("status");
      if (st) setStatus(st);
      if (sc && TASK_SCOPES.some((s) => s.key === sc)) setScope(sc);
      const qv = sp.get("q");
      if (qv) { setQInput(qv); setThemeQ(qv.trim()); }
      const sv = sp.get("sort");
      if (sv && SORTS.some((s) => s.value === sv)) setSort(sv);
    } catch { /* ignore */ }
  }, []);

  // 搜索词进 URL（?q=），返回 / 刷新不丢；离开列表时不带到别的列表（在这里只写本页 URL）。
  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (themeQ) sp.set("q", themeQ);
      else sp.delete("q");
      sp.set("sort", sort); // 排序进 URL（?sort=），返回 / 刷新不丢
      const next = sp.toString();
      window.history.replaceState(null, "", window.location.pathname + (next ? "?" + next : ""));
    } catch { /* ignore */ }
  }, [themeQ, sort]);

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
  const curScope = TASK_SCOPES.find((s) => s.key === scope) || TASK_SCOPES[0];
  const typeOptions = data?.scopeTypes && data.scopeTypes.length ? data.scopeTypes : curScope.types;
  const bs = counts.byStatus || {};
  const pendingCount = (bs.PENDING ?? 0) + (bs.PROCESSING ?? 0) + (bs.IN_PROGRESS ?? 0);
  // 积压数 = FlywheelJob 的 PENDING/QUEUED + PROCESSING（字典「飞轮任务积压数」同表）。
  //   两个值都拿得到才给数字；否则 null -> 卡片显示「不可得」，不写 0。
  const flowQueues = flowQ.data?.queues || {};
  const jobPendingN = Number(flowQueues.jobPending);
  const jobRunningN = Number(flowQueues.jobRunning);
  const backlog = !flowQ.error && flowQueues.jobPending != null && flowQueues.jobRunning != null
    && Number.isFinite(jobPendingN) && Number.isFinite(jobRunningN)
    ? jobPendingN + jobRunningN
    : null;
  const backlogReason = flowQ.error
    ? String((flowQ.error as Error)?.message || flowQ.error)
    : (flowQ.data?.error || "飞轮队列接口未返回 queues.jobPending / queues.jobRunning");

  // 客户端搜索：改进项（标题）/ ID / 主题 / 类型。theme 已由服务端过滤（参数未改），这里只是把
  // 「改进项 / 来源 ID」也纳入同一关键词，避免出现"搜得到主题、搜不到 ID"的两套行为。
  const rows = useMemo(() => {
    const kw = themeQ.trim().toLowerCase();
    const list = items.filter((m) => {
      if (!kw) return true;
      return [m.title, m.id, m.theme, m.type].filter(Boolean).join(" ").toLowerCase().includes(kw);
    });
    const pr = { P0: 0, P1: 1, P2: 2 } as Record<string, number>;
    const at = (v?: string | null) => (v ? new Date(v).getTime() || 0 : 0);
    return list.slice().sort((a, b) => {
      if (sort === "priority") {
        const d = (pr[String(a.priority || "")] ?? 9) - (pr[String(b.priority || "")] ?? 9);
        if (d) return d;
        return at(b.createdAt) - at(a.createdAt);
      }
      if (sort === "updated") return at(b.updatedAt ?? b.createdAt) - at(a.updatedAt ?? a.createdAt);
      return at(b.createdAt) - at(a.createdAt);
    });
  }, [items, themeQ, sort]);

  const columns = useMemo(() => buildTaskColumns(), []);

  // 执行体分布（改前在表格 panel 表头里显示，改成 DataTable 后挪到工具条右侧，口径与代码不变）。
  const actorSummary = (() => {
    const m = new Map<string, number>();
    for (const it of items) {
      const k = it.assignedAgent || (it.completedBy ? (it.completedBy.startsWith("cron:") || it.completedBy.startsWith("system:") ? "平台定时任务" : it.completedBy) : "未指派(公开队列)");
      m.set(k, (m.get(k) || 0) + 1);
    }
    const top = Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return top.length ? top.map(([k, v]) => k + " " + v).join(" · ") : "—";
  })();

  // 数据没回来时不给计数（不显示假的 0）。
  const scopeItems = TASK_SCOPES.map((s) => ({
    key: s.key,
    label: s.short,
    count: data ? scopeCounts[s.key]?.count : undefined,
  }));
  const statusItems = STATUS_TABS.map(([key, label]) => ({
    key,
    label,
    count: !data ? undefined : key === "ALL" ? counts.total : key === "PENDING" ? pendingCount : bs[key] ?? 0,
  }));
  const statusLabel = (STATUS_TABS.find(([k]) => k === status) || ["", status])[1];

  return (
    <div className="layout-with-sidebar">
      <main className="main">
        <div className="breadcrumb">
          <span className={styles.crumbDim}>飞轮引擎</span>
          <span className="sep">/</span>
          <span className="current">改进任务看板</span>
        </div>
        <PageHeader>
          <PageTitle>改进任务看板</PageTitle>
          {/* PILOT §8：页头写清与 /todo 待办的语义差别（改进任务=机制修复；待办=具体行动项） */}
          <div className="page-subtitle">
            机制修复类改进项（来源：飞轮自省）· 与 <Link href="/todo">待办</Link> 是两个队列：待办是具体行动项，
            改进任务是机制修复，互不计入统计。{loading ? "（加载中…）" : "全库 " + fmtNum(counts.total) + " 条 · 当前列表 " + items.length + " 条"}
          </div>
          <div className={styles.headMeta}>
            <Pill tone="mute">只读</Pill>
            <Link href="/flywheel/tasks/new" className={styles.rowLink}>新建任务 →</Link>
          </div>
        </PageHeader>

        {/* UI-9: 说清「改进任务」与「待办」的区别 (从哪来 / 谁做) —— 保留原卡片与互链 */}
        <QueueBoundary current="task" />

        {forbidden ? (
          <StateBlock
            title="无权限访问"
            desc={
              <>
                当前账号缺少「飞轮引擎 · 改进任务」的读权限 <code>flywheel.tasks</code>（或后端返回 403）。
                请联系平台管理员在权限配置里为该线开通 <code>flywheel.tasks</code>，开通后刷新本页。
              </>
            }
          />
        ) : (
          <>
            {/* 指标带（4 张 KpiCard）= 数据卡 7 §6 的四项 FlywheelJob 指标；取不到一律「不可得」+ 原因，不写 0。
                说明：任务总数 / 待做 / 完成 / 失败（Task 口径）仍在页头副标题与状态 FilterBar 的计数里，没有丢。 */}
            <div className="kpi-grid">
              <KpiCard
                label="飞轮任务积压数"
                value={flowQ.loading ? "…" : backlog != null ? fmtNum(backlog) : "不可得"}
                hint={backlog != null
                  ? "源：飞轮作业队列（排队中 + 处理中；排队含已入队未开工）· 与下方改进项不是同一张表"
                  : "原因：" + backlogReason + " · 不写 0"}
              />
              <KpiCard
                label="飞轮任务完成数（近7日）"
                value={tmQ.data?.done7d != null ? fmtNum(tmQ.data.done7d) : "不可得"}
                hint={tmQ.data?.done7d != null
                  ? "源：近 7 日已完成任务（按完成时间）· 阈值 ≥ 20（低于即停滞）"
                  : "原因：" + (tmQ.data?.reason || tmQ.error?.message || "接口未返回") + " · 不写 0"}
              />
              <KpiCard
                label="飞轮任务失败数（近7日）"
                value={tmQ.data?.failed7d != null ? fmtNum(tmQ.data.failed7d) : "不可得"}
                hint={tmQ.data?.failed7d != null
                  ? "源：近 7 日失败任务（按创建时间）· 阈值 ≤ 10"
                  : "原因：" + (tmQ.data?.reason || tmQ.error?.message || "接口未返回") + " · 不写 0"}
              />
              <KpiCard
                label="飞轮任务 P95 耗时（近7日，秒）"
                value={tmQ.data?.p95s != null ? String(tmQ.data.p95s) : "不可得"}
                hint={tmQ.data?.p95s != null
                  ? "样本 " + (tmQ.data.p95Sample ?? "?") + " 条 · 阈值 ≤ 300 秒（样本 <10 条应判不可判）"
                  : "原因：" + (tmQ.data?.reason || tmQ.error?.message || "接口未返回") + " · 不写 0"}
              />
            </div>

            {/* 工具条 1：作用域分段（FilterBar）+ 右侧口径说明 */}
            <div className={styles.toolbar}>
              <FilterBar
                items={scopeItems}
                active={scope}
                onSelect={(k) => { setScope(k); setType(""); }}
                right={<><b>{curScope.label}</b>：{curScope.desc}</>}
              />
            </div>
            {/* 工具条 2：搜索 + 状态筛选（FilterBar）+ 类型 / 排序 */}
            <div className={styles.toolbar}>
              <input
                className={styles.search}
                type="search"
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQInput("");
                  if (e.key === "Enter") setThemeQ(qInput.trim());
                }}
                placeholder="搜索改进项 / 来源编号 / 主题"
                aria-label="搜索改进任务：标题、编号、主题、类型"
              />
              <FilterBar
                items={statusItems}
                active={status}
                onSelect={setStatus}
                right={<>共 {rows.length} 条（当前视图）· 只读</>}
              />
            </div>
            <div className={styles.subToolbar}>
              <span>类型</span>
              <Select
                ariaLabel="任务类型"
                className={styles.sortSelect}
                value={type}
                onChange={(v: any) => setType(String(v ?? ""))}
                options={[{ value: "", label: curScope.key === "ALL" ? "全部类型" : curScope.short + "·全部类型" },
                  ...typeOptions.map((t) => ({ value: t, label: t + ((counts.byType || {})[t] != null ? "（" + fmtNum((counts.byType || {})[t]) + "）" : "") }))]}
              />
              <span>排序</span>
              <Select
                ariaLabel="排序方式"
                className={styles.sortSelect}
                value={sort}
                onChange={(v: any) => setSort(String(v || "created"))}
                options={SORTS}
              />
              <span>默认创建时间倒序 · 时间范围为顶栏全局筛选（{f.range}）</span>
              {/* 2026-09-15: 一屏看清"这些活是谁在干"（用户反馈看不出执行体）—— 保留改前的执行体分布 */}
              <span className={styles.actorDist}>执行体分布: {actorSummary}</span>
              {/* 数据展示规范 §2：每张表提供复制/导出（自动定位本按钮之后最近的一张表） */}
              <TableCopyButton />
            </div>

            <RowClick className={styles.clickable} onPick={(i) => { const m = rows[i]; if (m) toggle(m.id); }}>
              <DataTable
                rows={rows}
                columns={columns}
                rowKey={(m: Item, i: number) => m.id || i}
                loading={loading && !data}
                error={err}
                onRetry={() => { mutate(); }}
                empty={{
                  title: themeQ ? "没有匹配的改进任务" : "暂无改进任务",
                  desc: themeQ
                    ? "改进项 / 来源编号 / 主题 / 类型里都没有匹配项 —— 清空搜索、切换作用域或状态。"
                    : "接口返回 0 条（/api/flywheel-tasks，当前作用域「" + curScope.label + "」/ 状态「" + statusLabel + "」/ 时间范围「" + f.range + "」）。飞轮跑过一轮自省后这里才会有改进项。",
                  action: themeQ ? (
                    <button type="button" className="btn" onClick={() => setQInput("")}>清除搜索</button>
                  ) : (
                    <Link className="btn" href="/flywheel/reflections">去反思页 →</Link>
                  ),
                }}
              />
            </RowClick>
            <div className={styles.count}>
              共 {items.length} 条 · 当前视图 {rows.length} 条（搜索/排序后）· 点行展开详情，行末「详情 →」进独立详情页
            </div>

            <TaskDetailPanel
              id={expandedId}
              detail={expandedId ? details[expandedId] : undefined}
              loading={!!expandedId && detailLoading === expandedId}
            />

            {/* 页脚：逐源数据时刻 + 口径（卡片 7 §11：取不到显示不可得，不留空） */}
            <footer className={styles.foot}>
              <DataMoment
                items={[
                  { label: "改进任务", at: raw?.asOf },
                  { label: "飞轮队列", at: flowQ.data?.timestamp },
                ]}
                showPrefix={false}
              />
              <span className="tiny">
                口径：积压数 = 飞轮作业（排队中 + 处理中）；完成 / 失败 / P95 耗时 = 近 7 日飞轮作业（字典条目「飞轮任务完成数（近7日）」「飞轮任务失败数（近7日）」「飞轮任务 P95 耗时（近7日，秒）」）。
                取不到显示「不可得」+ 原因，不写 0。
              </span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
