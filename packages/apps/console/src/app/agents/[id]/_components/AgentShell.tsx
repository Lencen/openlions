// [UI-S6 / 屏06 智能体详情] 页壳: 状态行 + 对象页签 (概览 / 配置 / 运行 / 版本 / 组织)
// 页签走真链接 -> 每个页签是可深链、可后退、可中键新开的独立路由 (决策 #12 嵌套路由)。
// 2026-11-05 页头口径（docs/design/uiux-bento-2026-11/PAGE-HEADER-31.md §3 第 1~5 行）：
//   五个页签的标题/一句说明各不相同（智能体详情 · 概览/配置/运行/版本/组织），
//   所以页头（面包屑 + <PageHeader>）下沉到各页签 page.tsx，用 header 属性传进来；
//   本壳只留布局、状态行、页签。面包屑 DOM 结构与 /flywheel/findings 一致
//   （.breadcrumb > span.sep / span.current，弱化段用既有 .breadcrumb 基色，不新建类）。
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import { fmtAgo, type AgentRow, type LiveAgent } from "../_data";
import styles from "../page.module.css";

export interface TabDef {
  key: string;
  label: string;
}

export function agentTabs(id: string): { key: string; label: string; href: string }[] {
  const base = `/agents/${encodeURIComponent(id)}`;
  return [
    { key: "overview", label: "概览", href: `${base}/overview` },
    { key: "config", label: "配置", href: `${base}/config` },
    { key: "runs", label: "运行", href: `${base}/runs` },
    { key: "versions", label: "版本", href: `${base}/versions` },
    { key: "org", label: "组织", href: `${base}/org` },
  ];
}

/** 面包屑与页头用的对象名（取页面已有字段，不新造查询） */
export function agentDisplayName(id: string, agent: AgentRow | null, live: LiveAgent | null): string {
  return agent?.display_name || live?.displayName || id;
}

/** 对象面包屑：成员 / 智能体 / {名称} / {页签} */
export function AgentBreadcrumb({ display, tab }: { display: string; tab: string }) {
  return (
    <div className="breadcrumb">
      <span>成员</span>
      <span className="sep">/</span>
      <Link href="/agents">智能体</Link>
      <span className="sep">/</span>
      <span>{display}</span>
      <span className="sep">/</span>
      <span className="current">{tab}</span>
    </div>
  );
}

/** 2026-11-06 D-03：页签页头（面包屑 + 标题 + 说明 + 副行）抽成可复用件。
 *  为什么要抽：这 5 个页签有三条早返回（名册取数失败 / 智能体不存在 / 正常），
 *  原来只有"正常"那条带 header，前两条 SSR 没有 page-header（0.4.31 dev 实测 5 页 70/75）。
 *  抽出来之后三条分支渲染同一个 header，数据缺失也先出标题。 */
export function AgentTabHeader({
  id, tab, title, subtitle, agent, live,
}: {
  id: string;
  tab: string;
  title: string;
  subtitle: string;
  agent?: AgentRow | null;
  live?: LiveAgent | null;
}) {
  return (
    <>
      <AgentBreadcrumb display={agentDisplayName(id, agent ?? null, live ?? null)} tab={tab} />
      <PageHeader>
        <PageTitle>{title}</PageTitle>
        <div className="page-subtitle">{subtitle}</div>
        <AgentHeaderMeta id={id} agent={agent ?? null} live={live ?? null} />
      </PageHeader>
    </>
  );
}

/** 页头副行：对象编号 · 角色 · 接入通道 · 主机（改造前页头副标题的同一行，一字未改） */
export function AgentHeaderMeta({ id, agent, live }: { id: string; agent: AgentRow | null; live: LiveAgent | null }) {
  const roleLabel = live?.roleLabel || agent?.role || "";
  const channel = live?.channel || agent?.channel || "-";
  const host = agent?.host || live?.host || "-";
  return (
    <div className="page-subtitle">
      <span className="mono">{agent?.agent_id || id}</span>
      {roleLabel ? ` · ${roleLabel}` : ""}
      {` · ${channel} · ${host}`}
    </div>
  );
}

function stateBadgeClass(state?: string | null): string {
  if (state === "busy") return "badge badge-green";
  if (state === "stuck") return "badge badge-red";
  if (state === "offline") return "badge";
  if (state === "idle") return "badge badge-yellow";
  return "badge badge-blue";
}

export default function AgentShell({
  id,
  active,
  agent,
  live,
  header,
  children,
}: {
  id: string;
  active: string;
  agent: AgentRow | null;
  live: LiveAgent | null;
  /** 页签页头（面包屑 + PageHeader）：由各页签 page.tsx 按口径表渲染后传入 */
  header?: ReactNode;
  children: ReactNode;
}) {
  const tabs = agentTabs(id);
  const stateLabel = live?.stateLabel || "-";

  return (
    <div className="layout-with-sidebar">
      <main className="main">
        {header}
        <div className={styles.statusRow}>
          <span className={stateBadgeClass(live?.state)}>{stateLabel}</span>
          <span className="badge badge-blue">注册 {live?.registryStatus || agent?.status || "-"}</span>
          <span className="badge">通信服务 {live?.macsStatus || "-"}</span>
          <span className={styles.lastSeen}>
            最近露面 {fmtAgo(live?.lastSeenAt || agent?.last_seen_at)}
          </span>
          <Link
            href={`/agents/detail?id=${encodeURIComponent(agent?.agent_id || id)}`}
            className={styles.permLink}
          >
            权限调整入口
          </Link>
        </div>

        <nav
          aria-label="智能体详情页签"
          className={styles.tabs}
        >
          {tabs.map((tb) => {
            const on = tb.key === active;
            return (
              <Link
                key={tb.key}
                href={tb.href}
                className={styles.tab}
                data-on={on ? "true" : "false"}
              >
                {tb.label}
              </Link>
            );
          })}
        </nav>

        {children}
      </main>
    </div>
  );
}
