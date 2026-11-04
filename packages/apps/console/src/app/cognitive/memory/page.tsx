"use client";
import { humanError } from "@/lib/humanError";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 记忆列表 —— 详情改在侧边抽屉内打开,
// 关闭后仍在原列表位置与筛选条件; 筛选状态写回 URL (?search/sortBy/sortOrder/page/open)。
import type { CSSProperties } from "react";
import KPICard from "@/components/KPICard";
import BarChart from "@/components/BarChart";
import ListControls from "@/components/ListControls";
import { useApi } from "@/lib/api";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { Alert } from "@/components/primitives";
import CognitiveDetailDrawer from "@/components/cognitive/CognitiveDetailDrawer";
import { useCognitiveListUrlState } from "@/components/cognitive/useCognitiveListUrlState";
import { getQuickFilters } from "@/config/cognitiveQuickFilters";
import { artifactLabel } from "@/config/artifactTypes";
import { t as tr } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";
import DataMoment from "@/components/DataMoment";
import { hasOwnership, ownerLabel, visibilityLabel, scopeOffNotice } from "@/lib/asset-ownership";
interface S { success: boolean; data: { tables: any; topics: any; quality: any; coverageDistribution: Record<string, number> } }
interface M { total: number; items: any[] }
const fmt = (n: number) => n.toLocaleString();

const linkBtn: CSSProperties = { background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--primary)", font: "inherit", textAlign: "left" };
export default function MemoryPage() {
  const { data: r, error: statsErr } = useApi<S>("/api/stats");
  const { search, sortBy, sortOrder, page, openId, quick, setSearch, setSortBy, setSortOrder, setPage, setOpenId, setQuick, closeOpen } = useCognitiveListUrlState();
  const pageSize = 10;
  // 2026-10-13 round 76-CJ: 接入顶栏时间范围(③) —— 透到 mind 的 tRPC list(memory.list / skills.list)。
  const f = useGlobalFilter();
  const qs = `?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}&sortBy=${sortBy}&sortOrder=${sortOrder}&quick=${quick ?? ""}&range=${f.range}&_n=${f.nonce}`;
  const { data: m, loading, error: listError } = useApi<M>(`/api/memories${qs}`);
  const s = r?.data; const t = s?.tables; const q = s?.quality;
  const cov = s?.coverageDistribution ?? {};
  const items = m?.items ?? [];
  const total = m?.total ?? 0;
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>记忆与知识</span><span className="sep">/</span><span className="current">记忆库</span></div>
    <div className="page-header"><div className="page-title">记忆库</div><div className="page-subtitle">5 表记忆管理 · 数据质量 · 去重 · 时间排序 · 点标题用侧边抽屉看详情（不离开列表）<DataMoment items={[{ label: "统计", at: (r as any)?.asOf }, { label: "列表", at: (m as any)?.asOf }]} /></div></div>
    <div className="kpi-grid">
      <KPICard label="总量" value={t ? fmt(t.memory) : "..."} />
      <KPICard label={tr('biz.coverage.avg')} value={s ? fmt(s.topics.avgCoverage) : "..."} />
      <KPICard label="空 Hash" value={q ? fmt(q.emptyHash) : "..."} delta={q?.emptyHash === 0 ? "已清理" : "待修"} deltaDir={q?.emptyHash === 0 ? "up" : "down"} />
      <KPICard label={tr('biz.coverage.topicTotal')} value={s ? fmt(s.topics.total) : "..."} />
    </div>
    <div className="grid-2">
      <div className="panel"><div className="panel-header"><span className="panel-title">5 表分布</span></div>
        {t ? <BarChart bars={[{ label: artifactLabel("Memory"), value: t.memory, color: "var(--table-memory)" }, { label: artifactLabel("Knowledge"), value: t.knowledge, color: "var(--table-knowledge)" }, { label: artifactLabel("Practice"), value: t.practice, color: "var(--table-practice)" }, { label: artifactLabel("Reflection"), value: t.reflection, color: "var(--table-reflection)" }, { label: artifactLabel("Skill"), value: t.skill, color: "var(--table-skill)" }]} /> : <div style={{ padding: "var(--sp-5)", color: "var(--text-dim)" }}>{statsErr ? "统计加载失败" : "加载中..."}</div>}</div>
      <div className="panel"><div className="panel-header"><span className="panel-title">{tr('biz.coverage.dist')}</span></div>
        {cov["0-0.2"] ? <BarChart bars={[{ label: "0-0.2", value: cov["0-0.2"] ?? 0, color: "var(--cov-0-2)" }, { label: "0.2-0.4", value: cov["0.2-0.4"] ?? 0, color: "var(--cov-0-4)" }, { label: "0.4-0.6", value: cov["0.4-0.6"] ?? 0, color: "var(--cov-0-6)" }, { label: "0.6-0.8", value: cov["0.6-0.8"] ?? 0, color: "var(--cov-0-8)" }, { label: "0.8-1.0", value: cov["0.8-1.0"] ?? 0, color: "var(--cov-1-0)" }]} /> : <div style={{ padding: "var(--sp-5)", color: "var(--text-dim)" }}>{statsErr ? "统计加载失败" : "加载中..."}</div>}</div>
    </div>
    <div className="panel"><div className="panel-header"><span className="panel-title">记忆列表 {loading && "（加载中...）"}</span></div>
      <ListControls search={search} onSearch={setSearch} sortBy={sortBy} onSortBy={setSortBy} sortOrder={sortOrder} onSortOrder={setSortOrder} total={total} page={page} pageSize={pageSize} onPage={setPage} quickFilters={getQuickFilters("memory")} quick={quick} onQuick={setQuick} loading={loading} />
      {listError && <div style={{ padding: "var(--sp-3)" }}><Alert type="error" message="记忆库加载失败" description={humanError(listError, "这份列表")} /></div>}
      {/* 2026-10-26 R4（契约 §9⑤）：scope 关闭时 fail-open —— 不隐藏数据，只明示状态与判据来源。 */}
      {scopeOffNotice((m as any)?.meta) ? (
        <div className="data-health" data-state="idle" style={{ margin: "0 var(--sp-3) var(--sp-2)" }}>
          <span className="dh-text">{scopeOffNotice((m as any)?.meta)}</span>
        </div>
      ) : null}
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>标题</th><th>类型</th><th>{tr('field.tier')}</th><th>{tr('field.domain')}</th><th>主题</th><th>价值分</th><th>质量分</th><th>归属</th><th>可见性</th><th>来源</th><th>更新时间</th><th>创建时间</th><th style={{ width: 92 }}>操作</th></tr></thead><tbody>
        {items.map((m, i) => (<tr key={i}>
          <td><button type="button" style={linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情（不离开列表, 筛选与位置保持）">{m.title?.slice(0, 50) ?? m.content?.slice(0, 50) ?? m.id?.slice(0, 12) + "..."}</button></td>
          <td className="nowrap"><span className="badge badge-blue">{m.type ?? "-"}</span></td><td className="nowrap">{m.tier ?? "-"}</td><td className="nowrap">{m.domain ?? "-"}</td><td className="nowrap">{m.theme ?? "-"}</td><td className="num">{m.valueScore?.toFixed(2) ?? "-"}</td><td className="num">{m.qualityScore != null ? m.qualityScore.toFixed(2) : "-"}</td><td className="nowrap" style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{ownerLabel(m)}</td>
          <td className="nowrap" style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{visibilityLabel(m)}</td>
          <td className="nowrap" style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{m.agentSource ?? m.sourceType ?? "-"}</td><td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{m.updatedAt?.slice(0, 10) ?? m.createdAt?.slice(0, 10) ?? "-"}</td><td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{m.createdAt?.slice(0, 10) ?? "-"}</td>
          <td className="nowrap"><button type="button" style={linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情">详情</button> <a href={`/cognitive/memory/detail?id=${m.id}`} className="tiny" style={{ marginLeft: "var(--sp-1-5)", color: "var(--text-dim)" }} title="在新标签打开完整详情页（深链接）">↗</a></td>
        </tr>))}
        {!loading && !listError && items.length === 0 && <tr><td colSpan={13} style={{ padding: "var(--sp-5)", color: "var(--text-dim)", textAlign: "center" }}>无匹配记录</td></tr>}
      </tbody></table></div>
    <CognitiveDetailDrawer kind="memory" id={openId} open={!!openId} onClose={closeOpen} />
  </main></div>);
}
