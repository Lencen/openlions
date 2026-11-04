// [UI-S6 / 屏06 智能体详情] 页壳: 面包屑 + 头部 + 对象页签 (概览 / 配置 / 运行 / 版本)
// 页签走真链接 -> 每个页签是可深链、可后退、可中键新开的独立路由 (决策 #12 嵌套路由)。
import Link from "next/link";
import type { ReactNode } from "react";
import { fmtAgo, type AgentRow, type LiveAgent } from "../_data";

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
  children,
}: {
  id: string;
  active: string;
  agent: AgentRow | null;
  live: LiveAgent | null;
  children: ReactNode;
}) {
  const tabs = agentTabs(id);
  const display = agent?.display_name || live?.displayName || id;
  const roleLabel = live?.roleLabel || agent?.role || "";
  const channel = live?.channel || agent?.channel || "-";
  const host = live?.host || agent?.host || "-";
  const stateLabel = live?.stateLabel || "-";

  return (
    <div className="layout-with-sidebar">
      <main className="main">
        <div className="breadcrumb">
          <Link href="/">概览</Link>
          <span className="sep">/</span>
          <Link href="/agents">智能体</Link>
          <span className="sep">/</span>
          <span className="current">{display}</span>
        </div>

        <div className="page-header">
          <div className="page-title">{display}</div>
          <div className="page-subtitle">
            <span className="mono">{agent?.agent_id || id}</span>
            {roleLabel ? ` · ${roleLabel}` : ""}
            {` · ${channel} · ${host}`}
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)", alignItems: "center", marginBottom: "var(--sp-3)" }}>
          <span className={stateBadgeClass(live?.state)}>{stateLabel}</span>
          <span className="badge badge-blue">注册 {live?.registryStatus || agent?.status || "-"}</span>
          <span className="badge">通信服务 {live?.macsStatus || "-"}</span>
          <span style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>
            最近露面 {fmtAgo(live?.lastSeenAt || agent?.last_seen_at)}
          </span>
          <Link
            href={`/agents/detail?id=${encodeURIComponent(agent?.agent_id || id)}`}
            style={{ marginLeft: "auto", color: "var(--primary)", fontSize: "var(--fs-base)", textDecoration: "none" }}
          >
            权限调整入口
          </Link>
        </div>

        <nav
          aria-label="智能体详情页签"
          style={{ display: "flex", gap: "var(--sp-1)", borderBottom: "1px solid var(--border)", marginBottom: "var(--sp-4)" }}
        >
          {tabs.map((tb) => {
            const on = tb.key === active;
            return (
              <Link
                key={tb.key}
                href={tb.href}
                style={{
                  padding: "var(--sp-2) var(--sp-3-5)",
                  fontSize: "var(--fs-md)",
                  fontWeight: on ? 600 : 500,
                  color: on ? "var(--primary)" : "var(--text-dim)",
                  textDecoration: "none",
                  borderBottom: on ? "2px solid var(--primary)" : "2px solid transparent",
                  marginBottom: -1,
                }}
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
