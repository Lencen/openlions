"use client";
import { humanError } from "@/lib/humanError";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 反思列表 —— 详情改在侧边抽屉内打开,
// 关闭后仍在原列表位置与筛选条件; 筛选状态写回 URL (?search/sortBy/sortOrder/page/open)。
// 2026-11-05 P2 批6（呈现层）：内联 style 清零 + 手写 .tbl 裸表 → 白名单 @/components/DataTable。
//   列（11 列：标题/状态/分类/优先级/主题/分数/动作类型/教训/更新时间/创建时间/操作）与数据一条不少；
//   原先挂在 td 上的 nowrap / mono / 小字 / 暗色改由全局工具类 + 本目录 page.module.css 承载；
//   原来操作列 th 的 92px 宽走 DataTable 的 width 档位（w90）。
//   取数（/api/reflection-list 的分页/筛选/时间范围参数）、URL 参数、文案、抽屉行为均未动。
import Link from "next/link";
import KPICard from "@/components/KPICard";
import ListControls from "@/components/ListControls";
import { useApi } from "@/lib/api";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { Alert } from "@/components/primitives";
import CognitiveDetailDrawer from "@/components/cognitive/CognitiveDetailDrawer";
import { useCognitiveListUrlState } from "@/components/cognitive/useCognitiveListUrlState";
import { getQuickFilters } from "@/config/cognitiveQuickFilters";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";
interface R { items?: Array<{ id: string; title: string; status?: string; category?: string; priority?: string; theme?: string; score?: number; actionType?: string; lesson?: string; description?: string; createdAt?: string; updatedAt?: string }>; total?: number }
type ReflectionRow = NonNullable<R["items"]>[number];
const fmt = (n: number) => n.toLocaleString();
export default function ReflectionPage() {
  const { search, sortBy, sortOrder, page, openId, quick, setSearch, setSortBy, setSortOrder, setPage, setOpenId, setQuick, closeOpen } = useCognitiveListUrlState({ quickKeys: getQuickFilters("reflection").map((f) => f.key) });
  const pageSize = 10;
  // 2026-10-13 round 76-CL: 接入顶栏时间范围(③) —— 透到 mind 的 tRPC reflection.list。
  const f = useGlobalFilter();
  const qs = `?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}&sortBy=${sortBy}&sortOrder=${sortOrder}&quick=${quick ?? ""}&range=${f.range}&_n=${f.nonce}`;
  const { data, loading, error } = useApi<R>(`/api/reflection-list${qs}`);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  // 2026-11-05 P2 批6：列定义与改前表头逐列对应（含操作列宽 92px -> DataTable width 档位）
  const columns: DataColumn<ReflectionRow>[] = [
    { key: "title", title: "标题", render: (m) => (
      <button type="button" className={styles.linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情（不离开列表, 筛选与位置保持）">{m.title?.slice(0, 50) ?? m.id?.slice(0, 12) + "..."}</button>
    ) },
    { key: "status", title: "状态", render: (m) => (
      <span className="nowrap"><span className={`badge ${m.status === "COMPLETED" || m.status === "RESOLVED" ? "badge-green" : m.status === "FAILED" ? "badge-red" : "badge-yellow"}`}>{m.status ?? "-"}</span></span>
    ) },
    { key: "category", title: "分类", render: (m) => <span className="nowrap">{m.category ?? "-"}</span> },
    { key: "priority", title: "优先级", render: (m) => <span className="nowrap">{m.priority ?? "-"}</span> },
    { key: "theme", title: "主题", render: (m) => <span className="nowrap">{m.theme ?? "-"}</span> },
    { key: "score", title: "分数", align: "right", render: (m) => <span className="mono">{m.score?.toFixed(2) ?? "-"}</span> },
    { key: "actionType", title: "动作类型", render: (m) => <span className={"nowrap " + styles.sm}>{m.actionType ?? "-"}</span> },
    { key: "lesson", title: "教训", render: (m) => <span className={styles.smDim}>{m.lesson?.slice(0, 60) ?? m.description?.slice(0, 60) ?? "-"}</span> },
    { key: "updatedAt", title: "更新时间", render: (m) => <span className={"nowrap mono " + styles.sm}>{m.updatedAt?.slice(0, 10) ?? m.createdAt?.slice(0, 10) ?? "-"}</span> },
    { key: "createdAt", title: "创建时间", render: (m) => <span className={"nowrap mono " + styles.sm}>{m.createdAt?.slice(0, 10) ?? "-"}</span> },
    { key: "ops", title: "操作", width: 92, render: (m) => (
      <span className="nowrap"><button type="button" className={styles.linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情">详情</button> <a href={`/cognitive/reflection/detail?id=${m.id}`} className={styles.detailLink} title="在新标签打开完整详情页（深链接）">↗</a></span>
    ) },
  ];
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.bcDim}>记忆与知识</span><span className="sep">/</span><span className="current">反思</span></div>
    <PageHeader><PageTitle>反思</PageTitle><div className="page-subtitle">AI 反思记录 · 教训 · 经验总结 · 点标题用侧边抽屉看详情（不离开列表） {loading && "（加载中...）"}</div></PageHeader>
    <div className="kpi-grid"><KPICard label="反思总量" value={total > 0 ? fmt(total) : "..."} /></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">反思列表</span></div>
      <ListControls search={search} onSearch={setSearch} sortBy={sortBy} onSortBy={setSortBy} sortOrder={sortOrder} onSortOrder={setSortOrder} total={total} page={page} pageSize={pageSize} onPage={setPage} quickFilters={getQuickFilters("reflection")} quick={quick} onQuick={setQuick} loading={loading} />
      {error && <div className={styles.errPad}><Alert type="error" message="反思加载失败" description={humanError(error, "这条详情")} /></div>}
      <TableCopyButton />
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(m) => m.id}
        loading={loading}
        empty={{ title: error ? "反思加载失败（见上方提示）" : "无匹配记录" }}
      /></div>
    <CognitiveDetailDrawer kind="reflection" id={openId} open={!!openId} onClose={closeOpen} />
    {/* 2026-10-19 B5: 修前正文 0 出链 ✗；补"相关视图"（每条指向真实相关页）✓ */}
    <div className={"tiny " + styles.footLinks}>
      <span>相关视图：</span>
      <Link href="/cognitive">统一大脑 →</Link>
      <Link href="/flywheel/reflections">飞轮反思 →</Link>
    </div>
  </main></div>);
}
