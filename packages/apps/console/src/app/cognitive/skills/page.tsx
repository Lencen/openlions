"use client";
import { humanError } from "@/lib/humanError";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 技能列表 —— 详情改在侧边抽屉内打开,
// 关闭后仍在原列表位置与筛选条件; 筛选状态写回 URL (?search/sortBy/sortOrder/page/open)。
// 2026-11-05 P2 批6（呈现层）：内联 style 清零 + 手写 .tbl 裸表 → 白名单 @/components/DataTable。
//   列（14 列：名称/分类/等级/步骤/质量分/归属/可见性/来源/使用次数/版本/描述/更新时间/创建时间/操作）与数据一条不少；
//   td 上的 nowrap / mono / 小字 / 暗色改由全局工具类 + 本目录 page.module.css 承载；
//   操作列 th 的 92px 宽走 DataTable 的 width 档位（w90）。
//   取数（/api/skills-list 的分页/筛选/时间范围参数）、URL 参数、文案、抽屉行为均未动。
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
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "./page.module.css";
interface S { items?: Array<{ id: string; name: string; category?: string; level?: string; description?: string; qualityScore?: number; totalUsageCount?: number; source?: string; trigger?: string; content?: string; verification?: string; version?: number; legacy?: boolean; hasContent?: boolean; createdAt?: string; updatedAt?: string }>; total?: number }
type SkillRow = NonNullable<S["items"]>[number];
const fmt = (n: number) => n.toLocaleString();
// 2026-09-23 agent-x #2: 列表接口不再下发 content 全文, 改为 hasContent 布尔徽标 (有步骤全文=✓)。
const hasSteps = (m: any) => m.hasContent === true || (m.content && String(m.content).trim().length > 0) || (m.steps && String(m.steps).length > 0);
export default function SkillsPage() {
  const { search, sortBy, sortOrder, page, openId, quick, setSearch, setSortBy, setSortOrder, setPage, setOpenId, setQuick, closeOpen } = useCognitiveListUrlState();
  const pageSize = 10;
  // 2026-10-13 round 76-CJ: 接入顶栏时间范围(③) —— 透到 mind 的 tRPC list(memory.list / skills.list)。
  const f = useGlobalFilter();
  const qs = `?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}&sortBy=${sortBy}&sortOrder=${sortOrder}&quick=${quick ?? ""}&range=${f.range}&_n=${f.nonce}`;
  const { data, loading, error } = useApi<S>(`/api/skills-list${qs}`);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  // 2026-11-05 P2 批6：列定义与改前表头逐列对应（含操作列宽 92px -> DataTable width 档位）
  const columns: DataColumn<SkillRow>[] = [
    { key: "name", title: "名称", render: (m) => (
      <>
        <button type="button" className={styles.linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情（不离开列表, 筛选与位置保持）">
          {(m as any).businessName || m.name || m.id?.slice(0, 12) + "..."}
        </button>
        {/* 实测 (2026-10-26)：存量 technicalName 与 businessName 往往**同值**（Unicode 词字符保留），
            此时再显示一遍只是噪声 → 只有两者不同时才作副标题。 */}
        {(m as any).technicalName && (m as any).technicalName !== ((m as any).businessName || m.name)
          ? <div className="td-tech-name mono">{(m as any).technicalName}</div> : null}
      </>
    ) },
    { key: "category", title: "分类", render: (m) => <span className="nowrap">{m.category ?? "-"}</span> },
    { key: "level", title: "等级", render: (m) => <span className="nowrap">{m.level ?? "-"}</span> },
    { key: "steps", title: "步骤", render: (m) => (
      <span className="nowrap">{hasSteps(m) ? <span className="badge badge-green" title="含可执行步骤">✓ 有</span> : <span className="badge badge-red" title={m.legacy ? "2026-08-28 前存量, 无步骤" : "缺失步骤"}>✗ 无</span>}</span>
    ) },
    { key: "qualityScore", title: "质量分", align: "right", render: (m) => <span className="mono">{m.qualityScore != null ? m.qualityScore.toFixed(2) : "-"}</span> },
    { key: "owner", title: "归属", render: (m) => <span className={"nowrap " + styles.smDim}>{ownerLabel(m as any)}</span> },
    { key: "visibility", title: "可见性", render: (m) => <span className={"nowrap " + styles.smDim}>{visibility(m as any)}</span> },
    { key: "source", title: "来源", render: (m) => <span className="nowrap">{m.source ?? "-"}</span> },
    { key: "totalUsageCount", title: "使用次数", render: (m) => <span className="nowrap">{m.totalUsageCount ?? 0}</span> },
    { key: "version", title: "版本", render: (m) => <span className="nowrap">{m.version ?? 1}</span> },
    { key: "description", title: "描述", render: (m) => <span className={styles.descCell}>{m.description?.slice(0, 100) ?? "-"}</span> },
    { key: "updatedAt", title: "更新时间", render: (m) => <span className={"nowrap mono " + styles.sm}>{m.updatedAt?.slice(0, 10) ?? m.createdAt?.slice(0, 10) ?? "-"}</span> },
    { key: "createdAt", title: "创建时间", render: (m) => <span className={"nowrap mono " + styles.sm}>{m.createdAt?.slice(0, 10) ?? "-"}</span> },
    { key: "ops", title: "操作", width: 92, render: (m) => (
      <span className="nowrap"><button type="button" className={styles.linkBtn} onClick={() => setOpenId(m.id)} title="侧边抽屉打开详情">详情</button> <a href={`/cognitive/skills/detail?id=${m.id}`} className={styles.detailLink} title="在新标签打开完整详情页（深链接）">↗</a></span>
    ) },
  ];
  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.bcDim}>记忆与知识</span><span className="sep">/</span><span className="current">技能</span></div>
    <PageHeader><PageTitle>技能</PageTitle><div className="page-subtitle">技能管理 · 分类 · 熟练度 · SKILL-SPEC 7 字段 · 点名称用侧边抽屉看详情（不离开列表） {loading && "（加载中...）"}</div></PageHeader>
    <div className="kpi-grid"><KPICard label="技能总量" value={total > 0 ? fmt(total) : "..."} /></div>
    <div className="panel"><div className="panel-header"><span className="panel-title">技能列表</span></div>
      <ListControls search={search} onSearch={setSearch} sortBy={sortBy} onSortBy={setSortBy} sortOrder={sortOrder} onSortOrder={setSortOrder} total={total} page={page} pageSize={pageSize} onPage={setPage} quickFilters={getQuickFilters("skill")} quick={quick} onQuick={setQuick} loading={loading} />
      {error && <div className={styles.errPad}><Alert type="error" message="技能加载失败" description={humanError(error, "这条详情")} /></div>}
      <TableCopyButton />
      <DataTable
        columns={columns}
        rows={items}
        rowKey={(m) => m.id}
        loading={loading}
        empty={{ title: error ? "技能加载失败（见上方提示）" : "无匹配记录" }}
      /></div>
    <CognitiveDetailDrawer kind="skill" id={openId} open={!!openId} onClose={closeOpen} />
  </main></div>);
}
