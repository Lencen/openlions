"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface Caps {
  services: Array<{ name: string; url: string; description: string }>;
  apis: Record<string, string>;
  data: Record<string, string>;
  mcp_tools: string[];
}
interface AgentsResp {
  total: number;
  active: number;
  online: number;
  agents: Array<{
    agent_id: string;
    display_name: string;
    channel: string;
    status: string;
    online: boolean;
    last_seen_at: string | null;
  }>;
}

// 2026-10-22 CLS：四张表在接口返回前是空 tbody，数据到达时整页高度突增（实测 CLS 0.0935）。
//   按各表真实行数渲染骨架行（services 5 / 认知 6 / API 16 / agents 6），
//   既不产生位移，也不像 min-height 那样在行数少时留下大块空白。
function SkeletonRows({ cols, rows }: { cols: number; rows: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={"sk" + i} className="tbl-skel" aria-hidden="true">
          <td colSpan={cols}><span className="skel-line" /></td>
        </tr>
      ))}
    </>
  );
}

export default function PortalHome() {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [agents, setAgents] = useState<AgentsResp | null>(null);

  useEffect(() => {
    fetch("/api/portal/capabilities").then((r) => r.json()).then(setCaps).catch(() => {});
    fetch("/api/portal/agents").then((r) => r.json()).then(setAgents).catch(() => {});
  }, []);

  const dataEntries = caps ? Object.entries(caps.data) : [];

  return (
    <main className="main" style={{ marginLeft: 0, padding: "28px 32px", maxWidth: 1080 }}>
      {/* Hero */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 8 }}>LIONS 智能体平台</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13, maxWidth: 640, lineHeight: 1.7 }}>
          Layered Integration Of Neural Sessions — 认知飞轮驱动。AI 接入即获得全部能力,
          AI 离开可无 gap 接手。本门户面向外部 Agent 与开发者, 提供注册、认证与统一知识接入。
        </p>
      </div>

      {/* KPI */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(0, 160px))" }}>
        <div className="kpi-card">
          <span className="kpi-label">已注册 Agent</span>
          <span className="kpi-value">{agents?.total ?? "–"}</span>
          <span className="kpi-delta up">{agents?.online ?? 0} 在线</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">活跃 Agent</span>
          <span className="kpi-value">{agents?.active ?? "–"}</span>
          <span className="kpi-delta">状态 ACTIVE</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">接入服务</span>
          <span className="kpi-value">{caps?.services.length ?? "–"}</span>
          <span className="kpi-delta">平台服务</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">MCP 工具</span>
          <span className="kpi-value">{caps?.mcp_tools.length ?? "–"}</span>
          <span className="kpi-delta">跨 Agent 通信</span>
        </div>
      </div>

      <div className="grid-2">
        {/* 服务 */}
        <div className="panel">
          <div className="panel-header" style={{ borderRadius: "var(--radius-lg) var(--radius-lg) 0 0", margin: "calc(var(--sp-5) * -1) calc(var(--sp-5) * -1) var(--sp-4)" }}>
            <span className="panel-title" style={{ "--tab-color": "var(--module-core)" } as React.CSSProperties}>平台服务</span>
          </div>
          <table className="tbl">
            <thead>
              <tr><th>服务</th><th>地址</th><th>说明</th></tr>
            </thead>
            <tbody>
              {caps ? (caps.services ?? []).map((s) => (
                <tr key={s.name}>
                  <td className="nowrap"><span className="badge badge-blue">{s.name}</span></td>
                  <td><code style={{ fontSize: 11 }}>{s.url}</code></td>
                  <td>{s.description}</td>
                </tr>
              )) : <SkeletonRows cols={3} rows={5} />}
            </tbody>
          </table>
        </div>

        {/* 认知数据 */}
        <div className="panel">
          <div className="panel-header" style={{ borderRadius: "var(--radius-lg) var(--radius-lg) 0 0", margin: "calc(var(--sp-5) * -1) calc(var(--sp-5) * -1) var(--sp-4)" }}>
            <span className="panel-title" style={{ "--tab-color": "var(--module-builtin)" } as React.CSSProperties}>认知资产</span>
          </div>
          {dataEntries.length === 0 ? (
            <div className="skeleton" style={{ height: 200 }} />
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>数据域</th><th>规模</th></tr>
              </thead>
              <tbody>
                {caps ? dataEntries.map(([k, v]) => (
                  <tr key={k}>
                    <td className="nowrap">{k}</td>
                    <td>{v}</td>
                  </tr>
                )) : <SkeletonRows cols={2} rows={6} />}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* API 快速接入 */}
      <div className="panel">
        <div className="panel-header" style={{ borderRadius: "var(--radius-lg) var(--radius-lg) 0 0", margin: "calc(var(--sp-5) * -1) calc(var(--sp-5) * -1) var(--sp-4)" }}>
          <span className="panel-title" style={{ "--tab-color": "var(--module-extension)" } as React.CSSProperties}>快速接入 API</span>
          <Link href="/docs" style={{ fontSize: 12, color: "var(--primary)", textDecoration: "none" }}>查看全部 →</Link>
        </div>
        <table className="tbl">
          <thead>
            <tr><th style={{ width: 70 }}>方法</th><th>路径</th><th>说明</th></tr>
          </thead>
          <tbody>
            {caps ? Object.entries(caps.apis ?? {}).map(([k, v]) => (
              <tr key={k}>
                <td className="nowrap"><span className="badge badge-green">{v.includes("GET") ? "GET" : v.includes("POST") ? "POST" : "API"}</span></td>
                <td><code style={{ fontSize: 11 }}>{v.split(" -- ")[0]}</code></td>
                <td>{v.split(" -- ")[1] || ""}</td>
              </tr>
            )) : <SkeletonRows cols={3} rows={16} />}
          </tbody>
        </table>
      </div>

      {/* Agent 列表预览 */}
      <div className="panel">
        <div className="panel-header" style={{ borderRadius: "var(--radius-lg) var(--radius-lg) 0 0", margin: "calc(var(--sp-5) * -1) calc(var(--sp-5) * -1) var(--sp-4)" }}>
          <span className="panel-title" style={{ "--tab-color": "var(--module-audit)" } as React.CSSProperties}>Agent 状态</span>
          <Link href="/agents" style={{ fontSize: 12, color: "var(--primary)", textDecoration: "none" }}>全部 →</Link>
        </div>
        <table className="tbl">
          <thead>
            <tr><th>Agent</th><th>渠道</th><th>状态</th><th>在线</th><th>最近活跃</th></tr>
          </thead>
          <tbody>
            {agents ? (agents.agents ?? []).slice(0, 6).map((a) => (
              <tr key={a.agent_id}>
                <td className="nowrap"><strong>{a.display_name || a.agent_id}</strong></td>
                <td className="nowrap">{a.channel}</td>
                <td><span className={"badge " + (a.status === "ACTIVE" ? "badge-green" : "badge-red")}>{a.status}</span></td>
                <td><span className={"badge " + (a.online ? "badge-green" : "badge")}>{a.online ? "在线" : "离线"}</span></td>
                <td className="nowrap">{a.last_seen_at ? new Date(a.last_seen_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "–"}</td>
              </tr>
            )) : <SkeletonRows cols={5} rows={6} />}
          </tbody>
        </table>
      </div>
    </main>
  );
}
