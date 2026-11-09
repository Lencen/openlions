"use client";
import { humanError } from "@/lib/humanError";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 实践列表 —— 详情改在侧边抽屉内打开,
// 关闭后仍在原列表位置与筛选条件; 筛选状态写回 URL (?search/sortBy/sortOrder/page/open)。
// 2026-11-05 P2 批9（呈现层）：内联 style 清零（含原内联常量 linkBtn）+ 手写 .tbl 裸表 → 白名单
//   @/components/DataTable；筛选取数、URL 状态、列/文案/抽屉交互一字未改。
import KPICard from "@/components/KPICard";
import ListControls from "@/components/ListControls";
import { useApi } from "@/lib/api";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { Alert } from "@/components/primitives";
import CognitiveDetailDrawer from "@/components/cognitive/CognitiveDetailDrawer";
import { useCognitiveListUrlState } from "@/components/cognitive/useCognitiveListUrlState";
import { getQuickFilters } from "@/config/cognitiveQuickFilters";
import TableCopyButton from "@/components/TableCopyButton";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./page.module.css";
interface P { items?: Array<{ id: string; title: string; theme?: string; description?: string; type?: string; difficulty?: string; outcome?: string; qualityScore?: number; createdAt?: string; updatedAt?: string }>; total?: number }
type PracticeItem = NonNullable<P["items"]>[number];
const fmt = (n: number) => n.toLocaleString();
export default function PracticePage() {
  const { search, sortBy, sortOrder, page, openId, quick, setSearch, setSortBy, setSortOrder, setPage, setOpenId, setQuick, closeOpen } = useCognitiveListUrlState();
  const pageSize = 10;
  // 2026-10-13 round 76-CK: 接入顶栏时间范围(③) —— 透到 mind 的 tRPC list。
  const f = useGlobalFilter();
  const qs = `?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}&sortBy=${sortBy}&sortOrder=${sortOrder}&quick=${quick ?? ""}&range=${f.range}&_n=${f.nonce}`;
  const { data, loading, error } = useApi<P>(`/api/practice-list${qs}`);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  // 2026-11-05 P2 批9：列与改前表头逐列对应（标题/类型/难度/结果/质量分/主题/描述/更新时间/创建时间/操作）。
  //   本页是客户端组件（文件头 "use client"），可以传函数列（render / rowKey）。
  const columns: DataColumn<PracticeItem>[] = [
    {
      key: "title",
      title: "标题",
      render: (m) => (
        <button type="button" className={styles.linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情（不离开列表, 筛选与位置保持）">{m.title?.slice(0, 60) ?? m.id?.slice(0, 12) + "..."}</button>
      ),
    },
    { key: "type", title: "类型", render: (m) => <span className="nowrap">{m.type ?? "-"}</span> },
    { key: "difficulty", title: "难度", render: (m) => <span className="nowrap">{m.difficulty ?? "-"}</span> },
    {
      key: "outcome",
      title: "结果",
      render: (m) => (
        <span className="nowrap">
          <span className={`badge ${m.outcome === "FAILED" ? "badge-red" : m.outcome === "PARTIAL" ? "badge-yellow" : m.outcome ? "badge-green" : "badge-blue"}`}>{m.outcome ?? "-"}</span>
        </span>
      ),
    },
    { key: "qualityScore", title: "质量分", render: (m) => <span className="nowrap">{m.qualityScore != null ? m.qualityScore.toFixed(2) : "-"}</span> },
    { key: "theme", title: "主题", render: (m) => <span className="nowrap">{m.theme ?? "-"}</span> },
    { key: "description", title: "描述", render: (m) => <span className={styles.descCell}>{m.description?.slice(0, 100) ?? m.id?.slice(0, 8)}</span> },
    { key: "updatedAt", title: "更新时间", render: (m) => <span className={"nowrap mono " + styles.dateCell}>{m.updatedAt?.slice(0, 10) ?? m.createdAt?.slice(0, 10) ?? "-"}</span> },
    { key: "createdAt", title: "创建时间", render: (m) => <span className={"nowrap mono " + styles.dateCell}>{m.createdAt?.slice(0, 10) ?? "-"}</span> },
    {
      key: "op",
      title: "操作",
      width: 92,
      render: (m) => (
        <span className="nowrap">
          <button type="button" className={styles.linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情">详情</button>
          {" "}
          <a href={`/cognitive/practice/detail?id=${m.id}`} className={"tiny " + styles.extLink} title="在新标签打开完整详情页（深链接）">↗</a>
        </span>
      ),
    },
  ];
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.crumbDim}>记忆与知识</span><span className="sep">/</span><span className="current">实践</span></div>
    <PageHeader><PageTitle>实践</PageTitle><div className="page-subtitle">操作模板 · 流程沉淀 · 点标题用侧边抽屉看详情（不离开列表） {loading && "（加载中...）"}</div></PageHeader>
    <div className="kpi-grid"><KPICard label="实践总量" value={total > 0 ? fmt(total) : "..."} /></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">实践列表</span></div>
      <ListControls search={search} onSearch={setSearch} sortBy={sortBy} onSortBy={setSortBy} sortOrder={sortOrder} onSortOrder={setSortOrder} total={total} page={page} pageSize={pageSize} onPage={setPage} quickFilters={getQuickFilters("practice")} quick={quick} onQuick={setQuick} loading={loading} />
      {error && <div className={styles.errBox}><Alert type="error" message="实践加载失败" description={humanError(error, "这条详情")} /></div>}
      <TableCopyButton />
      {/* 2026-11-05 P2 批9：裸 .tbl → 白名单 DataTable；行 key 取记录 id，空态文案沿用改前的「无匹配记录」 */}
      <DataTable columns={columns} rows={items} rowKey={(m) => m.id} loading={loading} empty={{ title: "无匹配记录" }} />
    </div>
    <CognitiveDetailDrawer kind="practice" id={openId} open={!!openId} onClose={closeOpen} />
  </main></div>);
}
