"use client";
// /agents —— P1 试点页呈现层改造（ord-20261104-032 · 列表模板 A）
// 区块顺序：页头 → 功能入口带 → 指标带(≤4) → 工具条(搜索 + FilterBar) → DataTable → 计数
// 只动呈现层：取数（/api/agent-list、/api/session-stats、/api/stats、/api/services-list）与字段口径一行未改。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { t } from "@/i18n";
import { useApi } from "@/lib/api";
import { getSubmodules } from "@/config/submodules";
import DataMoment from "@/components/DataMoment";
import { Select } from "@/components/primitives";
import {
  PageHeader,
  PageTitle,
  KpiCard,
  DataTable,
  StateChip,
  FilterBar,
  StateBlock,
  Pill,
} from "@/components/ui";
import type { DataColumn } from "@/components/ui";
import RowClick from "./_components/RowClick";
import styles from "./page.module.css";

type Agent = { agent_id: string; display_name: string; channel: string; host: string; status: string; profile?: any };
interface A { result?: { data?: Agent[] } }
interface B extends Array<Agent> {}
type AR = A | B;

/** 四态之「无权限」：API 401/403 或错误文案带权限字样时整页替换（TEMPLATES §1）。 */
const FORBIDDEN_RE = /401|403|无权限|未授权/;

/** 状态键 → StateChip 的 state + 中文（与改前同一套映射，只是从 <Tag> 换成白名单 StateChip）。 */
function statusOf(a: any): { state: "ok" | "warn" | "crit" | "idle"; text: string } {
  const s = String(a.macsStatus || a.status || "").toUpperCase();
  if (s === "ACTIVE" || s === "ONLINE") return { state: "ok", text: "在线" };
  if (s === "INACTIVE" || s === "OFFLINE") return { state: "warn", text: "离线" };
  return { state: "idle", text: "未知" };
}

const FILTERS = [
  { key: "ALL", label: "全部" },
  { key: "ok", label: "在线" },
  { key: "warn", label: "离线" },
  { key: "idle", label: "未知" },
] as const;

const SORTS = [
  { value: "name", label: "名称 A→Z（默认）" },
  { value: "host", label: "运行时" },
  { value: "status", label: "状态" },
  { value: "seen", label: "最近活跃" },
];

export default function AgentsDashboard() {
  const router = useRouter();
  const subs = getSubmodules("agents");
  const { data, loading, error, mutate } = useApi<AR>("/api/agent-list");
  const asOf = (data as any)?.asOf as string | undefined; // 76-FZ: BFF 新给的"数据时刻"
  const agents = (Array.isArray(data) ? data : ((data as any)?.items ?? (data as any)?.result?.data)) ?? [];
  const { data: ssRaw } = useApi<{ result?: { data?: { total: number } } }>("/api/session-stats");
  const { data: statsRaw } = useApi<{ data?: { tables?: { skill: number } } }>("/api/stats");
  const { data: svcRaw } = useApi<{ name: string }[]>("/api/services-list");
  const sessionTotal = ssRaw?.result?.data?.total;
  const skillTotal = statsRaw?.data?.tables?.skill;
  const mcpCount = (svcRaw ?? []).filter((s) => s.name.toLowerCase().includes("mcp")).length;

  // 搜索（模板 A §「搜索」）：名称 / ID / 通道 / 宿主 / 状态文案，250ms 防抖；?q= 进 URL。
  const [q, setQ] = useState("");
  const [qApplied, setQApplied] = useState("");
  const [filter, setFilter] = useState<string>("ALL");
  const [sort, setSort] = useState<string>("name");

  useEffect(() => {
    const id = setTimeout(() => setQApplied(q.trim().toLowerCase()), 250);
    return () => clearTimeout(id);
  }, [q]);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      const v = sp.get("q");
      if (v) {
        setQ(v);
        setQApplied(v.trim().toLowerCase());
      }
      const sv = sp.get("sort");
      if (sv && SORTS.some((s) => s.value === sv)) setSort(sv);
    } catch { /* 无 window 时忽略 */ }
  }, []);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      if (qApplied) sp.set("q", qApplied);
      else sp.delete("q");
      sp.set("sort", sort); // 排序进 URL（?sort=），返回 / 刷新不丢
      const qs = sp.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
    } catch { /* 忽略 */ }
  }, [qApplied, sort]);

  const errText = error ? String((error as Error)?.message || error) : "";
  const forbidden = FORBIDDEN_RE.test(errText);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: agents.length, ok: 0, warn: 0, idle: 0 };
    for (const a of agents) c[statusOf(a).state] += 1;
    return c;
  }, [agents]);

  const filtered = useMemo(() => {
    const kw = qApplied;
    const list = (agents as any[]).filter((a) => {
      if (filter !== "ALL" && statusOf(a).state !== filter) return false;
      if (!kw) return true;
      const hay = [a.display_name, a.agent_id, a.channel, a.host, statusOf(a).text]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(kw);
    });
    const seen = (a: any) => (a.last_seen_at ? new Date(a.last_seen_at).getTime() || 0 : 0);
    return list.slice().sort((a, b) => {
      if (sort === "host") return String(a.host || "").localeCompare(String(b.host || ""));
      if (sort === "status") return String(a.macsStatus || a.status || "").localeCompare(String(b.macsStatus || b.status || ""));
      if (sort === "seen") return seen(b) - seen(a);
      return String(a.display_name || a.agent_id || "").localeCompare(String(b.display_name || b.agent_id || ""));
    });
  }, [agents, filter, qApplied, sort]);

  const detailHref = (a: any) => "/agents/detail?agentId=" + encodeURIComponent(a.agent_id || "");

  // 排序口径（PILOT §5「表头可排（会话数 / 成功率 / 成本），默认会话数降序」）：
  // TODO(数据卡 卡5 §8)：agent 维度的会话数 / 成功率 / P95 字典暂无口径，平台线补齐前不造列、也不编数字；
  //   当前按名称排序，补齐后把这三列加进 columns 并把默认排序改回「会话数降序」。
  const columns: DataColumn<any>[] = [
    {
      key: "who",
      title: "智能体",
      render: (a: any) => (
        <div className="dt-cell-who">
          <span className="dt-avatar">{(a.display_name || a.agent_id || "·").slice(0, 2)}</span>
          <span>
            <span className="dt-who-name">{a.display_name || a.agent_id}</span>
            <span className="dt-who-sub">
              {a.agent_id} · {a.channel || "未知通道"}
              {a.source === "macs" ? <span className="dt-src" title="只登记在协同服务里，没登记进智能体注册表">仅协同</span> : null}
            </span>
          </span>
        </div>
      ),
    },
    { key: "host", title: "运行时", render: (a: any) => <span className="dt-who-sub">{a.host || "—"}</span> },
    {
      key: "status",
      title: "状态",
      width: "110px",
      render: (a: any) => {
        const st = statusOf(a);
        return <StateChip state={st.state} text={st.text} />;
      },
    },
    { key: "permissions", title: "权限", align: "right", width: "88px", render: (a: any) => a.permissions?.length ?? 0 },
    {
      key: "currentTask",
      title: "当前任务",
      width: "240px",
      render: (a: any) =>
        a.currentTask?.title ? (
          <span className="dt-task" title={a.currentTask.title}>{a.currentTask.title}</span>
        ) : (
          <span className="dt-who-sub">—</span>
        ),
    },
    {
      key: "lastDone",
      title: "最近产物",
      width: "240px",
      render: (a: any) =>
        a.lastDone?.title ? (
          <span className="dt-task" title={a.lastDone.title + " · " + (a.lastDone.updatedAt || "")}>{a.lastDone.title}</span>
        ) : (
          <span className="dt-who-sub">—</span>
        ),
    },
    {
      key: "lastSeen",
      title: "最近活跃",
      align: "right",
      width: "150px",
      render: (a: any) => (
        <span className="dt-who-sub">
          {a.last_seen_at
            ? new Date(a.last_seen_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
            : "—"}
        </span>
      ),
    },
    {
      key: "open",
      title: "",
      width: "48px",
      align: "right",
      render: (a: any) => (
        <Link className={styles.rowLink} href={detailHref(a)} title="查看智能体详情" aria-label={"查看 " + (a.display_name || a.agent_id) + " 详情"}>
          ›
        </Link>
      ),
    },
  ];

  return (
    <div className="layout">
      <main className="main">
        {/* 页头：PageHeader/PageTitle（白名单）+ 一句话口径 + 只读 chip + 逐源数据时刻 */}
        <PageHeader>
          <PageTitle>{t("agentsPage.title")}</PageTitle>
          <div className="page-subtitle">
            {t("agentsPage.subtitle")}
          </div>
          <div className={styles.headMeta}>
            <Pill tone="mute">只读</Pill>
            {/* 77-AB：本页 4 个数据源分别喂 4 张卡，逐源标时刻，取不到写「未知」，绝不借别人的时刻。 */}
            <DataMoment
              items={[
                { label: "智能体", at: asOf },
                { label: "会话", at: (ssRaw as any)?.asOf },
                { label: "技能", at: (statsRaw as any)?.asOf },
                { label: "服务", at: (svcRaw as any)?.asOf },
              ]}
            />
          </div>
        </PageHeader>

        {/* 二级入口：从菜单搬到正文顶部，做成紧凑的「功能入口」带（PILOT §5）。
            注：PILOT 写「5 项」，而 config/submodules 的 agents 模块实际有 8 项 —— 按「不删功能」保留全部。 */}
        <nav className={styles.entryBand} aria-label="功能入口">
          {subs.map((s) => (
            <Link key={s.id} href={s.href} className={styles.entryLink}>
              {s.label} →
            </Link>
          ))}
        </nav>

        {forbidden ? (
          <StateBlock
            title="无权限访问"
            desc={
              <>
                当前账号缺少「智能体与能力」的读权限 <code>agents.read</code>（或后端返回 403）。
                请联系平台管理员在权限配置里为该线开通 <code>agents.read</code>，开通后刷新本页。
              </>
            }
          />
        ) : (
          <>
            <div className="kpi-grid">
              <KpiCard label={t("agentsPage.total")} value={agents.length > 0 ? agents.length : "..."} hint="已注册智能体数" />
              <KpiCard label="会话总数" value={sessionTotal !== undefined ? sessionTotal.toLocaleString() : "..."} hint="全部智能体累计" />
              <KpiCard label="技能" value={skillTotal !== undefined ? skillTotal.toLocaleString() : "..."} hint="技能库条目数" />
              <KpiCard label={t("agentsPage.mcp")} value={svcRaw ? mcpCount : "..."} hint="来自服务清单，按名称匹配统计" />
            </div>

            {/* 工具条：最左搜索 → 视图/状态筛选（FilterBar）→ 右侧只读说明与计数 */}
            <div className={styles.toolbar}>
              <input
                className={styles.search}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQ("");
                  if (e.key === "Enter") setQApplied(q.trim().toLowerCase());
                }}
                placeholder="搜索名称 / 编号 / 通道 / 宿主 / 状态"
                aria-label="搜索智能体：名称、编号、通道、宿主、状态"
              />
              <FilterBar
                items={FILTERS.map((f) => ({
                  key: f.key,
                  label: f.label,
                  // 数据没回来时不给计数（不显示假的 0）：count 走 undefined，FilterBar 只渲染标签。
                  count: loading && !data ? undefined : counts[f.key] || 0,
                }))}
                active={filter}
                onSelect={setFilter}
                right={<>共 {filtered.length} 条（筛选后）· 只读</>}
              />
            </div>
            <div className={styles.subToolbar}>
              <span>排序</span>
              <Select
                ariaLabel="排序方式"
                className={styles.sortSelect}
                value={sort}
                onChange={(v: any) => setSort(String(v || "name"))}
                options={SORTS}
              />
              <span>默认按名称；会话数 / 成功率 / 成本的排序口径待补齐</span>
            </div>

            <RowClick className={styles.clickable} onPick={(i) => { const a = filtered[i]; if (a) router.push(detailHref(a)); }}>
              <DataTable
                loading={loading && agents.length === 0}
                error={error ? errText : null}
                onRetry={() => { mutate(); }}
                rows={filtered}
                rowKey={(a: any, i) => a.agent_id || i}
                empty={{
                  title: qApplied ? "没有匹配的智能体" : "暂无智能体",
                  desc: qApplied
                    ? "名称 / 编号 / 通道 / 宿主 / 状态里都没有匹配项 —— 清空搜索或切换状态筛选。"
                    : "接口返回 0 条（/api/agent-list）。接入一个智能体后，这里会显示它的运行时、状态与权限。",
                  action: qApplied ? (
                    <button type="button" className="btn" onClick={() => setQ("")}>清除搜索</button>
                  ) : (
                    <Link className="btn" href="/agents/onboard">去接入向导 →</Link>
                  ),
                }}
                columns={columns}
              />
            </RowClick>
            <div className={styles.count}>
              共 {agents.length} 条 · 当前视图 {filtered.length} 条（筛选后）· 行点击进智能体详情
            </div>
          </>
        )}

      </main>
    </div>
  );
}
