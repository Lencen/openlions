"use client";
import { humanError } from "@/lib/humanError";
// 2026-09-14 UI-3 (todo_a76adfd6303d4e6d9f16): 记忆列表 —— 详情改在侧边抽屉内打开,
// 关闭后仍在原列表位置与筛选条件; 筛选状态写回 URL (?search/sortBy/sortOrder/page/open)。
// ---------------------------------------------------------------------------
// 2026-11-04 · P1 试点页呈现层改造（ord-20261104-032）· 模板 A 列表
// 取数 0 改动：/api/stats 与 /api/memories 的 URL/参数原样（含 page/pageSize/search/sortBy/sortOrder/quick/range/_n）。
// 四态落点：
//   · 加载：列表 DataTable loading（骨架行）；两个统计区块各自 StateBlock loading
//   · 错误：列表 DataTable error + 重试（mutate）；统计 ErrorBlock + 重试
//   · 空  ：「没有匹配」（有搜索/快捷筛选且 0 条，给清除）与「还没有记忆」（本来 0 条）分开
//   · 无权限：error 文案 401/403 或含「无权限/未授权」-> 整页 StateBlock「无权限访问」（缺 core.memory）
import { useEffect, useRef, useState } from "react";
import BarChart from "@/components/BarChart";
import ListControls from "@/components/ListControls";
import { useApi } from "@/lib/api";
import { useGlobalFilter } from "@/components/GlobalFilter";
import CognitiveDetailDrawer from "@/components/cognitive/CognitiveDetailDrawer";
import { useCognitiveListUrlState } from "@/components/cognitive/useCognitiveListUrlState";
import { getQuickFilters } from "@/config/cognitiveQuickFilters";
import { artifactLabel } from "@/config/artifactTypes";
import { t as tr } from "@/i18n";
import TableCopyButton from "@/components/TableCopyButton";
import DataMoment from "@/components/DataMoment";
import { hasOwnership, ownerLabel, visibilityLabel, scopeOffNotice } from "@/lib/asset-ownership";
import { KpiCard, DataTable, StateChip, StateBlock, ErrorBlock, FilterBar, PageHeader, PageTitle, Pill } from "@/components/ui";
import styles from "./page.module.css";
interface S { success: boolean; data: { tables: any; topics: any; quality: any; coverageDistribution: Record<string, number> } }
interface M { total: number; items: any[] }
const fmt = (n: number) => n.toLocaleString();

/** 无权限的唯一判定口：401/403 或文案含「无权限 / 未授权」。只决定渲染哪个四态，不吞错误。 */
const FORBIDDEN_RE = /401|403|无权限|未授权|unauthori[sz]ed|forbidden/i;

export default function MemoryPage() {
  const { data: r, error: statsErr, mutate: statsMutate } = useApi<S>("/api/stats");
  const { search, sortBy, sortOrder, page, openId, quick, setSearch, setSortBy, setSortOrder, setPage, setOpenId, setQuick, closeOpen } = useCognitiveListUrlState();
  const pageSize = 10;
  // 2026-10-13 round 76-CJ: 接入顶栏时间范围(③) —— 透到 mind 的 tRPC list(memory.list / skills.list)。
  const f = useGlobalFilter();
  const qs = `?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}&sortBy=${sortBy}&sortOrder=${sortOrder}&quick=${quick ?? ""}&range=${f.range}&_n=${f.nonce}`;
  const { data: m, loading, error: listError, mutate: listMutate } = useApi<M>(`/api/memories${qs}`);
  const s = r?.data; const t = s?.tables; const q = s?.quality;
  const cov = s?.coverageDistribution ?? {};
  const items = m?.items ?? [];
  const total = m?.total ?? 0;

  // 搜索防抖 250ms（模板 A §搜索）：输入框吃本地值，250ms 后才写进 URL 状态（也就是才触发取数）。
  // 状态来源仍是 useCognitiveListUrlState（URL 可刷新/可分享），只是把「每次按键都请求」降为防抖一次。
  const [searchInput, setSearchInput] = useState(search);
  const applied = useRef(search);
  useEffect(() => {
    // 只有「外部」改动（URL 恢复 / 程序化清除）才回灌输入框，避免把用户正在输入的字覆盖掉
    if (search !== applied.current) { applied.current = search; setSearchInput(search); }
  }, [search]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onSearchInput = (v: string) => {
    setSearchInput(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { applied.current = v; setSearch(v); }, 250);
  };
  const clearFilters = () => {
    if (timer.current) clearTimeout(timer.current);
    applied.current = ""; setSearchInput(""); setSearch(""); setQuick(null); setPage(1);
  };

  const statErr = statsErr ? humanError(statsErr, "统计") : "";
  const listErr = listError ? String((listError as Error)?.message || listError) : "";
  const forbidden = FORBIDDEN_RE.test(listErr) || FORBIDDEN_RE.test(String((statsErr as Error)?.message ?? ""));
  // 页码 > 1 也算「筛选态」：那种情况下的空列表是「翻过头了」，不是「本来没有记忆」
  const hasFilter = !!search || !!quick || page > 1;
  const covKeys = Object.keys(cov);

  const filterItems = [
    { key: "all", label: "全部" },
    ...getQuickFilters("memory").map((x) => ({ key: x.key, label: x.label })),
  ];

  return (<div className="layout-with-sidebar"><main className="main">
    <div className="breadcrumb"><span className={styles.bcDim}>记忆与知识</span><span className="sep">/</span><span className="current">记忆库</span></div>
    <PageHeader>
      <PageTitle>记忆库</PageTitle>
      <div className="page-subtitle">5 表记忆管理 · 数据质量 · 去重 · 时间排序 · 点标题用侧边抽屉看详情（不离开列表）<DataMoment items={[{ label: "统计", at: (r as any)?.asOf }, { label: "列表", at: (m as any)?.asOf }]} /></div>
      <div className={styles.headerTags}>
        <Pill tone="mute">只读</Pill>
        <Pill tone="info">口径 · 5 表 · 默认更新时间倒序</Pill>
      </div>
    </PageHeader>

    {forbidden ? (
      // 四态 · 无权限：整页替换（缺哪个权限点 + 找谁开通 + 申请授权）
      <StateBlock
        title="无权限访问"
        desc={<>
          缺少记忆库的读权限点 <code>core.memory</code>（口径见 <code>config/submodules.ts</code>）。<br />
          找平台管理员开通；也可在「权限管理」页发起授权申请。
        </>}
        action={<a className="btn btn-sm" href="/system/permissions">申请授权</a>}
      />
    ) : (<>
      <div className="kpi-grid">
        {/* PILOT-10 §11 指标带要求「记忆总量 / 今日新增 / 生效中 / 平均置信度」。
            其中「今日新增 / 生效中比例 / 平均置信度」**当前没有字段**（数据卡 6「数据缺口」：mind 侧 2026-11-10 前补），
            按字典「缺失一律 n/a + 原因，不写 0」——先保留现有 4 个真实值，缺的写在 TODO 里，不编造。
            TODO(data)：今日新增 = Memory.createdAt 当日计数；生效中 = supersededBy IS NULL 占比；平均置信度 = 字典未定义口径。 */}
        <KpiCard label="总量" value={t ? fmt(t.memory) : "—"} hint="5 张表中的记忆表" />
        <KpiCard label={tr('biz.coverage.avg')} value={s ? fmt(s.topics.avgCoverage) : "—"} hint="主题覆盖率均值" />
        <KpiCard label="空 Hash" value={q ? fmt(q.emptyHash) : "—"} delta={q ? (q.emptyHash === 0 ? "已清理" : "待修") : undefined} deltaDir={q?.emptyHash === 0 ? "up" : "down"} hint="去重键缺失的脏数据" />
        <KpiCard label={tr('biz.coverage.topicTotal')} value={s ? fmt(s.topics.total) : "—"} hint="覆盖到的主题总数" />
      </div>

      <div className="grid-2">
        <div className="panel"><div className="panel-header"><span className="panel-title">5 表分布</span></div>
          {t ? <BarChart bars={[{ label: artifactLabel("Memory"), value: t.memory, color: "var(--table-memory)" }, { label: artifactLabel("Knowledge"), value: t.knowledge, color: "var(--table-knowledge)" }, { label: artifactLabel("Practice"), value: t.practice, color: "var(--table-practice)" }, { label: artifactLabel("Reflection"), value: t.reflection, color: "var(--table-reflection)" }, { label: artifactLabel("Skill"), value: t.skill, color: "var(--table-skill)" }]} />
            : statsErr ? <ErrorBlock message={statErr} onRetry={() => { statsMutate(); }} />
              : <StateBlock loading rows={3} />}
        </div>
        <div className="panel"><div className="panel-header"><span className="panel-title">{tr('biz.coverage.dist')}</span></div>
          {covKeys.length > 0 ? <BarChart bars={[{ label: "0-0.2", value: cov["0-0.2"] ?? 0, color: "var(--cov-0-2)" }, { label: "0.2-0.4", value: cov["0.2-0.4"] ?? 0, color: "var(--cov-0-4)" }, { label: "0.4-0.6", value: cov["0.4-0.6"] ?? 0, color: "var(--cov-0-6)" }, { label: "0.6-0.8", value: cov["0.6-0.8"] ?? 0, color: "var(--cov-0-8)" }, { label: "0.8-1.0", value: cov["0.8-1.0"] ?? 0, color: "var(--cov-1-0)" }]} />
            : statsErr ? <ErrorBlock message={statErr} onRetry={() => { statsMutate(); }} />
              : s ? <StateBlock title="覆盖率分布为空" desc="触发条件：/api/stats 的 coverageDistribution 没有桶（该时段没有记忆被打分）。" />
                : <StateBlock loading rows={3} />}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">记忆列表{loading && "（加载中...）"}</span>
          <span className={styles.panelNote}>默认更新时间倒序 · 点标题用侧边抽屉看详情</span>
        </div>
        {/* ListControls = 共享工具条（搜索 / 排序 / 分页）。它没有白名单替代件，且删掉就是删功能，
            故保留；「快捷筛选」改由下方 FilterBar 承担（筛选只用 FilterBar）。 */}
        <ListControls search={searchInput} onSearch={onSearchInput} sortBy={sortBy} onSortBy={setSortBy} sortOrder={sortOrder} onSortOrder={setSortOrder} total={total} page={page} pageSize={pageSize} onPage={setPage} loading={loading} />
        <div className={styles.filterBarWrap}>
          <FilterBar
            items={filterItems}
            active={quick ?? "all"}
            onSelect={(k) => { setQuick(k === "all" ? null : k); }}
            right={loading ? <>加载中…（不显示假计数）</> : <>共 {total.toLocaleString()} 条{hasFilter ? "（筛选后）" : ""}</>}
          />
        </div>
        {/* 2026-10-26 R4（契约 §9⑤）：scope 关闭时 fail-open —— 不隐藏数据，只明示状态与判据来源。 */}
        {scopeOffNotice((m as any)?.meta) ? (
          <div className="data-health" data-state="idle">
            <span className="dh-text">{scopeOffNotice((m as any)?.meta)}</span>
          </div>
        ) : null}
        <TableCopyButton />
        <DataTable
          rows={items}
          rowKey={(x: any, i) => String(x.id ?? i)}
          loading={loading && items.length === 0}
          error={listError ? humanError(listError, "这份列表") : null}
          onRetry={() => { listMutate(); }}
          empty={hasFilter
            ? { title: "没有匹配的记录", desc: "触发条件：搜索词或快捷筛选命中 0 条（列表本身有数据）。返回 / 刷新会保留当前搜索与排序。", action: <button className="btn" onClick={clearFilters}>清除搜索与筛选</button> }
            : { title: "还没有记忆", desc: "触发条件：库内 0 条 active 记忆（supersededBy 为空的行也没有）。近 7 日新增为 0 时应先查提炼链路，而不是先改检索。" }}
          columns={[
            {
              key: "content", title: "内容", width: "300px",
              render: (x: any) => (
                <button type="button" className={styles.linkBtn} onClick={() => setOpenId(x.id)} title="侧边抽屉打开详情（不离开列表, 筛选与位置保持）">
                  {x.title?.slice(0, 50) ?? x.content?.slice(0, 50) ?? String(x.id ?? "").slice(0, 12) + "..."}
                </button>
              ),
            },
            {
              key: "type", title: "类型 / 层级 / 域", width: "150px",
              render: (x: any) => (
                <span className={styles.typeCell}>
                  <Pill tone="info">{x.type ?? "—"}</Pill>
                  <span className={styles.cellDim}>{x.tier ?? "—"} · {x.domain ?? "—"}</span>
                </span>
              ),
            },
            { key: "theme", title: "主题", width: "120px", render: (x: any) => x.theme ?? "—" },
            { key: "valueScore", title: "价值分", align: "right", width: "88px", render: (x: any) => (x.valueScore?.toFixed(2) ?? "—") },
            { key: "qualityScore", title: "质量分", align: "right", width: "88px", render: (x: any) => (x.qualityScore != null ? x.qualityScore.toFixed(2) : "—") },
            // 「引用数」字典/接口都没有（PILOT §11 想列「引用」）—— 这里用真实字段 accessCount，列名叫「访问」，不改口径。
            // TODO(data)：引用数（被其他资产引用次数）待数据卡给口径后再加列。
            { key: "accessCount", title: "访问", align: "right", width: "80px", render: (x: any) => (x.accessCount ?? 0) },
            {
              key: "state", title: "状态", width: "110px",
              render: (x: any) => (x.supersededBy ? <StateChip state="idle" text="已被取代" /> : <StateChip state="ok" text="生效中" />),
            },
            {
              key: "owner", title: "归属 / 可见性", width: "170px",
              render: (x: any) => <span className={styles.cellDim}>{ownerLabel(x)} · {visibilityLabel(x)}</span>,
            },
            {
              key: "source", title: "来源", width: "190px",
              // TODO(link)：PILOT §11 要求「来源会话 ID → 会话详情」，但接口只给 sourceType/sourceId，
              //   未规范化为 session_uid（现有值形如 CLAUDE_CONVERSATION），贸然拼 /sessions/detail?id= 会跳到错记录，
              //   故先按原样文字展示；等后端给出规范化 sessionId 再加链接。
              render: (x: any) => (
                <span className={styles.cellDim}>
                  {x.agentSource ?? x.sourceType ?? "—"}{x.sourceId ? " · " + String(x.sourceId).slice(0, 18) : ""}
                </span>
              ),
            },
            { key: "updatedAt", title: "更新时间", align: "right", width: "120px", render: (x: any) => <span className={styles.cellDim + " mono"}>{x.updatedAt?.slice(0, 10) ?? x.createdAt?.slice(0, 10) ?? "—"}</span> },
            { key: "createdAt", title: "创建时间", align: "right", width: "120px", render: (x: any) => <span className={styles.cellDim + " mono"}>{x.createdAt?.slice(0, 10) ?? "—"}</span> },
            {
              key: "ops", title: "操作", width: "110px",
              render: (x: any) => (
                <span className="nowrap">
                  <button type="button" className={styles.linkBtn} onClick={() => setOpenId(x.id)} title="侧边抽屉打开详情">详情</button>
                  <a href={`/cognitive/memory/detail?id=${x.id}`} className={styles.detailGap + " tiny"} title="在新标签打开完整详情页（深链接）">↗</a>
                </span>
              ),
            },
          ]}
        />
        <div className={styles.panelNote}>
          默认排序：更新时间倒序（同值按创建时间兜底）。排序控件在工具条（更新时间 / 创建时间）；「置信度 / 引用数」当前无字段，未参与排序。
        </div>
      </div>
    </>)}
    <CognitiveDetailDrawer kind="memory" id={openId} open={!!openId} onClose={closeOpen} />
  </main></div>);
}
