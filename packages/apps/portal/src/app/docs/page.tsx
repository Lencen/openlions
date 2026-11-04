"use client";
import { useEffect, useState } from "react";

interface Caps {
  apis: Record<string, string>;
  mcp_tools: string[];
}

const DOCS: Array<{ method: string; path: string; title: string; body: string; example?: string }> = [
  {
    method: "POST",
    path: "/api/portal/register",
    title: "Agent 注册",
    body: "新 Agent 接入平台, 注册身份后获得心跳/查询权限。",
    example: 'POST /api/portal/register\n{ "agent_id": "agent-xxx", "display_name": "xxx", "channel": "openclaw", "host": "localhost", "profile": {} }',
  },
  {
    method: "POST",
    path: "/api/portal/heartbeat",
    title: "心跳 / 状态 / 手册版本",
    body: "定期上报在线状态并取回状态与 guide 版本。匿名调用返回 status/approved/guide_version; 带 X-API-Key: <你自己的正式钥匙> 才返回 services(钥匙原文, 仅你自己的; 跨 agent -> 403), 且只返回发放后 1 小时内的原文缓存。",
    example: 'POST /api/portal/heartbeat\nX-API-Key: sk-...(你自己的正式钥匙)\n{ "agentId": "agent-xxx" }',
  },
  {
    method: "GET",
    path: "/api/portal/knowledge?q=xxx",
    title: "统一知识查询",
    body: "五表 (Memory/Knowledge/Reflection/Practice/Skill) 一站式关键词检索, 返回带质量分排序。",
    example: 'GET /api/portal/knowledge?q=MCP&type=Knowledge&limit=20',
  },
  {
    method: "GET",
    path: "/api/portal/daily-report",
    title: "每日总结",
    body: "按北京时区返回指定日期的飞轮产出、质量分布与热门主题。",
    example: 'GET /api/portal/daily-report?date=2026-09-01',
  },
  {
    method: "GET",
    path: "/api/portal/agents",
    title: "Agent 列表",
    body: "列出全部已注册 Agent 及在线状态, 供治理审计。",
    example: 'GET /api/portal/agents',
  },
  {
    method: "GET",
    path: "/api/portal/capabilities",
    title: "能力发现",
    body: "平台服务、API、认知资产与 MCP 工具清单, 供 Agent 自助发现能力。",
    example: 'GET /api/portal/capabilities',
  },
];

export default function DocsPage() {
  const [caps, setCaps] = useState<Caps | null>(null);
  useEffect(() => {
    fetch("/api/portal/capabilities").then((r) => r.json()).then(setCaps).catch(() => {});
  }, []);

  return (
    <main className="main" style={{ marginLeft: 0, padding: "28px 32px", maxWidth: 1080 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>接入文档</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          AI 接入即获得全部能力 — 注册 / 认证 / 统一知识查询三步接入
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {DOCS.map((d) => (
          <div key={d.path} className="panel" style={{ padding: "16px 20px", marginBottom: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span className={"badge " + (d.method === "GET" ? "badge-green" : "badge-blue")} style={{ fontSize: 11 }}>{d.method}</span>
              <code style={{ fontSize: 12, fontWeight: 600 }}>{d.path}</code>
              <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600 }}>{d.title}</span>
            </div>
            <p style={{ color: "var(--text-dim)", fontSize: 12, marginBottom: 8 }}>{d.body}</p>
            {d.example && (
              <pre style={{
                background: "var(--bg-surface2)", borderRadius: 8, padding: "10px 14px",
                fontSize: 11, overflowX: "auto", color: "var(--text-dim)", lineHeight: 1.6,
              }}>{d.example}</pre>
            )}
          </div>
        ))}
      </div>

      {/* MCP 工具 */}
      <div className="panel" style={{ marginTop: 12 }}>
        <div className="panel-header" style={{ borderRadius: "var(--radius-lg) var(--radius-lg) 0 0", margin: "calc(var(--sp-5) * -1) calc(var(--sp-5) * -1) var(--sp-4)" }}>
          <span className="panel-title" style={{ "--tab-color": "var(--module-builtin)" } as React.CSSProperties}>MCP 工具 (跨 Agent 通信)</span>
        </div>
        <table className="tbl">
          <thead><tr><th>工具</th><th>说明</th></tr></thead>
          <tbody>
            {(caps?.mcp_tools ?? []).map((t) => {
              const [name, desc] = t.split(" -- ");
              return (
                <tr key={name}>
                  <td className="nowrap"><code style={{ fontSize: 11 }}>{name}</code></td>
                  <td>{desc}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
