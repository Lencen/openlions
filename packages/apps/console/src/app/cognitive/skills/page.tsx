"use client";
import { humanError } from "@/lib/humanError";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 技能列表 —— 详情改在侧边抽屉内打开,
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
import { ownerLabel, visibilityLabel as visibility } from "@/lib/asset-ownership";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
interface S { items?: Array<{ id: string; name: string; category?: string; level?: string; description?: string; qualityScore?: number; totalUsageCount?: number; source?: string; trigger?: string; content?: string; verification?: string; version?: number; legacy?: boolean; hasContent?: boolean; createdAt?: string; updatedAt?: string }>; total?: number }
const fmt = (n: number) => n.toLocaleString();
// 2026-09-23 agent-x #2: 列表接口不再下发 content 全文, 改为 hasContent 布尔徽标 (有步骤全文=✓)。
const hasSteps = (m: any) => m.hasContent === true || (m.content && String(m.content).trim().length > 0) || (m.steps && String(m.steps).length > 0);
const linkBtn: CSSProperties = { background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--primary)", font: "inherit", textAlign: "left" };
export default function SkillsPage() {
  const { search, sortBy, sortOrder, page, openId, quick, setSearch, setSortBy, setSortOrder, setPage, setOpenId, setQuick, closeOpen } = useCognitiveListUrlState();
  const pageSize = 10;
  // 2026-10-13 round 76-CJ: 接入顶栏时间范围(③) —— 透到 mind 的 tRPC list(memory.list / skills.list)。
  const f = useGlobalFilter();
  const qs = `?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}&sortBy=${sortBy}&sortOrder=${sortOrder}&quick=${quick ?? ""}&range=${f.range}&_n=${f.nonce}`;
  const { data, loading, error } = useApi<S>(`/api/skills-list${qs}`);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>记忆与知识</span><span className="sep">/</span><span className="current">技能</span></div>
    <PageHeader><PageTitle>技能</PageTitle><div className="page-subtitle">技能管理 · 分类 · 熟练度 · SKILL-SPEC 7 字段 · 点名称用侧边抽屉看详情（不离开列表） {loading && "（加载中...）"}</div></PageHeader>
    <div className="kpi-grid"><KPICard label="技能总量" value={total > 0 ? fmt(total) : "..."} /></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">技能列表</span></div>
      <ListControls search={search} onSearch={setSearch} sortBy={sortBy} onSortBy={setSortBy} sortOrder={sortOrder} onSortOrder={setSortOrder} total={total} page={page} pageSize={pageSize} onPage={setPage} quickFilters={getQuickFilters("skill")} quick={quick} onQuick={setQuick} loading={loading} />
      {error && <div style={{ padding: "var(--sp-3)" }}><Alert type="error" message="技能加载失败" description={humanError(error, "这条详情")} /></div>}
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>名称</th><th>分类</th><th>等级</th><th>步骤</th><th>质量分</th><th>归属</th><th>可见性</th><th>来源</th><th>使用次数</th><th>版本</th><th>描述</th><th>更新时间</th><th>创建时间</th><th style={{ width: 92 }}>操作</th></tr></thead><tbody>
        {items.map((m, i) => (<tr key={i}>
          {/* 2026-10-26（asset-line msg_78aa243222584b84）：技能现在有两个名字 ——
              businessName（给人看的业务名）与 technicalName（给查询/引用，桶内唯一）。
              列表主标题用业务名，技术名放副标题并用于检索，两者都可空 → 逐级回退到 name/id。 */}
          <td>
            <button type="button" style={linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情（不离开列表, 筛选与位置保持）">
              {(m as any).businessName || m.name || m.id?.slice(0, 12) + "..."}
            </button>
            {/* 实测 (2026-10-26)：存量 technicalName 与 businessName 往往**同值**（Unicode 词字符保留），
                此时再显示一遍只是噪声 → 只有两者不同时才作副标题。 */}
            {(m as any).technicalName && (m as any).technicalName !== ((m as any).businessName || m.name)
              ? <div className="td-tech-name mono">{(m as any).technicalName}</div> : null}
          </td>
          <td className="nowrap">{m.category ?? "-"}</td><td className="nowrap">{m.level ?? "-"}</td><td className="nowrap">{hasSteps(m) ? <span className="badge badge-green" title="含可执行步骤">✓ 有</span> : <span className="badge badge-red" title={m.legacy ? "2026-08-28 前存量, 无步骤" : "缺失步骤"}>✗ 无</span>}</td><td className="num">{m.qualityScore != null ? m.qualityScore.toFixed(2) : "-"}</td><td className="nowrap" style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{ownerLabel(m as any)}</td><td className="nowrap" style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>{visibility(m as any)}</td><td className="nowrap">{m.source ?? "-"}</td><td className="nowrap">{m.totalUsageCount ?? 0}</td><td className="nowrap">{m.version ?? 1}</td><td style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>{m.description?.slice(0, 100) ?? "-"}</td><td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{m.updatedAt?.slice(0, 10) ?? m.createdAt?.slice(0, 10) ?? "-"}</td><td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>{m.createdAt?.slice(0, 10) ?? "-"}</td>
          <td className="nowrap"><button type="button" style={linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情">详情</button> <a href={`/cognitive/skills/detail?id=${m.id}`} className="tiny" style={{ marginLeft: "var(--sp-1-5)", color: "var(--text-dim)" }} title="在新标签打开完整详情页（深链接）">↗</a></td>
        </tr>))}
        {!loading && !error && items.length === 0 && <tr><td colSpan={14} style={{ padding: "var(--sp-5)", color: "var(--text-dim)", textAlign: "center" }}>无匹配记录</td></tr>}
      </tbody></table></div>
    <CognitiveDetailDrawer kind="skill" id={openId} open={!!openId} onClose={closeOpen} />
  </main></div>);
}
