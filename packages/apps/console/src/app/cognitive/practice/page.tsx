"use client";
import { humanError } from "@/lib/humanError";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 实践列表 —— 详情改在侧边抽屉内打开,
// 关闭后仍在原列表位置与筛选条件; 筛选状态写回 URL (?search/sortBy/sortOrder/page/open)。
import type { CSSProperties } from "react";
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
interface P { items?: Array<{ id: string; title: string; theme?: string; description?: string; type?: string; difficulty?: string; outcome?: string; qualityScore?: number; createdAt?: string; updatedAt?: string }>; total?: number }
const fmt = (n: number) => n.toLocaleString();
const linkBtn: CSSProperties = { background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--primary)", font: "inherit", textAlign: "left" };
export default function PracticePage() {
  const { search, sortBy, sortOrder, page, openId, quick, setSearch, setSortBy, setSortOrder, setPage, setOpenId, setQuick, closeOpen } = useCognitiveListUrlState();
  const pageSize = 10;
  // 2026-10-13 round 76-CK: 接入顶栏时间范围(③) —— 透到 mind 的 tRPC list。
  const f = useGlobalFilter();
  const qs = `?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}&sortBy=${sortBy}&sortOrder=${sortOrder}&quick=${quick ?? ""}&range=${f.range}&_n=${f.nonce}`;
  const { data, loading, error } = useApi<P>(`/api/practice-list${qs}`);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>记忆与知识</span><span className="sep">/</span><span className="current">实践</span></div>
    <PageHeader><PageTitle>实践</PageTitle><div className="page-subtitle">操作模板 · 流程沉淀 · 点标题用侧边抽屉看详情（不离开列表） {loading && "（加载中...）"}</div></PageHeader>
    <div className="kpi-grid"><KPICard label="实践总量" value={total > 0 ? fmt(total) : "..."} /></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">实践列表</span></div>
      <ListControls search={search} onSearch={setSearch} sortBy={sortBy} onSortBy={setSortBy} sortOrder={sortOrder} onSortOrder={setSortOrder} total={total} page={page} pageSize={pageSize} onPage={setPage} quickFilters={getQuickFilters("practice")} quick={quick} onQuick={setQuick} loading={loading} />
      {error && <div style={{ padding: "var(--sp-3)" }}><Alert type="error" message="实践加载失败" description={humanError(error, "这条详情")} /></div>}
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>标题</th><th>类型</th><th>难度</th><th>结果</th><th>质量分</th><th>主题</th><th>描述</th><th>更新时间</th><th>创建时间</th><th style={{ width: 92 }}>操作</th></tr></thead><tbody>
        {items.map((m, i) => (<tr key={i}>
          <td><button type="button" style={linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情（不离开列表, 筛选与位置保持）">{m.title?.slice(0, 60) ?? m.id?.slice(0, 12) + "..."}</button></td>
          <td className="nowrap">{m.type ?? "-"}</td><td className="nowrap">{m.difficulty ?? "-"}</td><td className="nowrap"><span className={`badge ${m.outcome === "FAILED" ? "badge-red" : m.outcome === "PARTIAL" ? "badge-yellow" : m.outcome ? "badge-green" : "badge-blue"}`}>{m.outcome ?? "-"}</span></td><td className="nowrap">{m.qualityScore != null ? m.qualityScore.toFixed(2) : "-"}</td><td className="nowrap">{m.theme ?? "-"}</td><td style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>{m.description?.slice(0, 100) ?? m.id?.slice(0, 8)}</td><td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{m.updatedAt?.slice(0, 10) ?? m.createdAt?.slice(0, 10) ?? "-"}</td><td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{m.createdAt?.slice(0, 10) ?? "-"}</td>
          <td className="nowrap"><button type="button" style={linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情">详情</button> <a href={`/cognitive/practice/detail?id=${m.id}`} className="tiny" style={{ marginLeft: "var(--sp-1-5)", color: "var(--text-dim)" }} title="在新标签打开完整详情页（深链接）">↗</a></td>
        </tr>))}
        {!loading && !error && items.length === 0 && <tr><td colSpan={10} style={{ padding: "var(--sp-5)", color: "var(--text-dim)", textAlign: "center" }}>无匹配记录</td></tr>}
      </tbody></table></div>
    <CognitiveDetailDrawer kind="practice" id={openId} open={!!openId} onClose={closeOpen} />
  </main></div>);
}
