"use client";
import { humanError } from "@/lib/humanError";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 知识列表 —— 详情改在侧边抽屉内打开,
// 关闭后仍在原列表位置与筛选条件; 筛选状态写回 URL (?search/sortBy/sortOrder/page/open)。
// 2026-09-24 IA 整改 (todo_c73421c8e82c424e97e7): 原独立菜单项 /cognitive/knowledge/governance
// 「知识治理」是知识库的子页, 按 2026-09-21 IA 重构改为本页页内 Tab:
//   · 默认 Tab=知识列表; Tab=知识治理 承载原治理概览, 深链 /cognitive/knowledge?tab=governance;
//   · 旧路由 /cognitive/knowledge/governance 保留为重定向到该深链(见同目录 governance/page.tsx);
//   · nav.ts 里 { id:'governance' } 菜单项已撤掉。
import { useEffect, useState, type CSSProperties } from "react";
import KPICard from "@/components/KPICard";
import ListControls from "@/components/ListControls";
import { useApi } from "@/lib/api";
import { useGlobalFilter } from "@/components/GlobalFilter";
import { Alert, Segmented } from "@/components/primitives";
import CognitiveDetailDrawer from "@/components/cognitive/CognitiveDetailDrawer";
import { useCognitiveListUrlState } from "@/components/cognitive/useCognitiveListUrlState";
import { getQuickFilters } from "@/config/cognitiveQuickFilters";
import { t } from "@/i18n";
import KnowledgeGovernancePanel from "./_components/KnowledgeGovernancePanel";
import TableCopyButton from "@/components/TableCopyButton";
import { ownerLabel, visibilityLabel as visibility } from "@/lib/asset-ownership";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
interface K { items?: Array<{ id: string; title: string; category?: string; confidence?: number; theme?: string; domain?: string; usageCount?: number; tags?: string; agentSource?: string; sourceType?: string; qualityScore?: number; createdAt?: string; updatedAt?: string }>; total?: number }
const fmt = (n: number) => n.toLocaleString();
const linkBtn: CSSProperties = { background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--primary)", font: "inherit", textAlign: "left" };

// 知识库页内 Tab 的合法值 (URL ?tab= 只认这两个, 脏值回落 list, 防深链脏参数)
const TABS = [
  { key: "list", label: "知识列表" },
  { key: "governance", label: "知识治理" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const asTab = (v: string | null): TabKey => (v === "governance" ? "governance" : "list");

export default function KnowledgePage() {
  const { search, sortBy, sortOrder, page, openId, quick, setSearch, setSortBy, setSortOrder, setPage, setOpenId, setQuick, closeOpen } = useCognitiveListUrlState();
  const [tab, setTab] = useState<TabKey>("list");
  // 挂载后从 URL 恢复 Tab (深链 / 刷新), 与 useCognitiveListUrlState 的做法一致, 避免 SSR/CSR 水合不一致。
  useEffect(() => {
    try {
      setTab(asTab(new URLSearchParams(window.location.search).get("tab")));
    } catch { /* ignore */ }
  }, []);
  // Tab 切换写回 URL (replaceState, 不跳路由), 保留列表筛选等其他参数, 使 Tab 可分享/可刷新。
  const changeTab = (next: TabKey) => {
    setTab(next);
    try {
      const sp = new URLSearchParams(window.location.search);
      if (next === "list") sp.delete("tab"); else sp.set("tab", next);
      const qs = sp.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
    } catch { /* ignore */ }
  };
  const pageSize = 10;
  // 2026-10-13 round 76-CK: 接入顶栏时间范围(③) —— 透到 mind 的 tRPC list。
  const f = useGlobalFilter();
  const qs = `?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}&sortBy=${sortBy}&sortOrder=${sortOrder}&quick=${quick ?? ""}&range=${f.range}&_n=${f.nonce}`;
  const { data, loading, error } = useApi<K>(`/api/knowledge-list${qs}`);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>记忆与知识</span><span className="sep">/</span><span className="current">知识库</span></div>
    <PageHeader><PageTitle>知识库</PageTitle><div className="page-subtitle">知识条目 · 分类 · 来源 · 语义检索 · 点标题用侧边抽屉看详情（不离开列表） {loading && tab === "list" && "（加载中...）"}</div></PageHeader>
    {/* 2026-09-24 IA 整改: 子页(知识治理)走页内 Tab, 不再单占菜单位; 均可深链 (?tab=governance) */}
    <div style={{ marginBottom: "var(--sp-3)" }}>
      <Segmented options={TABS.map((tb) => ({ label: tb.label, value: tb.key }))} value={tab} onChange={(v) => changeTab(v as TabKey)} />
    </div>
    {tab === "list" ? (<>
    <div className="kpi-grid"><KPICard label="知识总量" value={total > 0 ? fmt(total) : "..."} /></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">知识列表</span></div>
      <ListControls search={search} onSearch={setSearch} sortBy={sortBy} onSortBy={setSortBy} sortOrder={sortOrder} onSortOrder={setSortOrder} total={total} page={page} pageSize={pageSize} onPage={setPage} quickFilters={getQuickFilters("knowledge")} quick={quick} onQuick={setQuick} loading={loading} />
      {error && <div style={{ padding: "var(--sp-3)" }}><Alert type="error" message="知识库加载失败" description={humanError(error, "这条详情")} /></div>}
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>标题</th><th>分类</th><th>置信度</th><th>主题</th><th>{t('field.domain')}</th><th>质量分</th><th>使用次数</th><th>标签</th><th>归属</th><th>可见性</th><th>来源</th><th>更新时间</th><th style={{ width: 92 }}>操作</th></tr></thead><tbody>
        {items.map((m, i) => (<tr key={i}>
          <td><button type="button" style={linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情（不离开列表, 筛选与位置保持）">{m.title?.slice(0, 50) ?? m.id?.slice(0, 12) + "..."}</button></td>
          <td className="nowrap">{m.category ?? "-"}</td><td className="num">{m.confidence?.toFixed(2) ?? "-"}</td><td className="nowrap">{m.theme ?? "-"}</td><td className="nowrap">{m.domain ?? "-"}</td><td className="num">{m.qualityScore != null ? m.qualityScore.toFixed(2) : "-"}</td><td className="num">{m.usageCount ?? 0}</td><td style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{m.tags?.slice(0, 40) ?? "-"}</td>
          <td className="nowrap" style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{ownerLabel(m as any)}</td>
          <td className="nowrap" style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{visibility(m as any)}</td>
          <td className="nowrap" style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{m.agentSource ?? m.sourceType ?? "-"}</td><td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{m.updatedAt?.slice(0, 10) ?? m.createdAt?.slice(0, 10) ?? "-"}</td>
          <td className="nowrap"><button type="button" style={linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情">详情</button> <a href={`/cognitive/knowledge/detail?id=${m.id}`} className="tiny" style={{ marginLeft: "var(--sp-1-5)", color: "var(--text-dim)" }} title="在新标签打开完整详情页（深链接）">↗</a></td>
        </tr>))}
        {!loading && !error && items.length === 0 && <tr><td colSpan={13} style={{ padding: "var(--sp-5)", color: "var(--text-dim)", textAlign: "center" }}>无匹配记录</td></tr>}
      </tbody></table></div>
    </>) : (
      <KnowledgeGovernancePanel />
    )}
    <CognitiveDetailDrawer kind="knowledge" id={openId} open={!!openId} onClose={closeOpen} />
  </main></div>);
}
