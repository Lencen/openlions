"use client";
// system/api 页 · MCP 服务表 (可展开工具行) (从 page.tsx 抽出, 页面瘦身)
import { useState } from "react";
import { t } from "@/i18n";
import type { McpTool, Svc } from "./types";
import TableCopyButton from "@/components/TableCopyButton";

function permText(p: any) {
  if (typeof p === "string") {
    try {
      return JSON.parse(p).join(", ");
    } catch {
      return p;
    }
  }
  return Array.isArray(p) ? p.join(", ") : "-";
}

export default function McpServiceTable({
  services,
  toolsByService,
  onPickTool,
}: {
  services: Svc[];
  toolsByService: Record<string, McpTool[]>;
  onPickTool: (t: McpTool) => void;
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">{t('api.panel.mcp')}</span>
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)" }}>
          点击服务行展开工具，再点击工具进入调测
        </span>
      </div>
      <TableCopyButton />
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 24 }}></th>
            <th>服务名</th>
            <th>显示名</th>
            <th>版本</th>
            <th>端点</th>
            <th>权限</th>
            <th>工具</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const tools = toolsByService[s.name] || [];
            return (
              <ExpandableServiceRow
                key={s.name}
                svc={s}
                tools={tools}
                onPickTool={onPickTool}
                permText={permText(s.available_perms)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExpandableServiceRow({
  svc,
  tools,
  onPickTool,
  permText,
}: {
  svc: Svc;
  tools: McpTool[];
  onPickTool: (t: McpTool) => void;
  permText: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        style={{ cursor: "pointer" }}
        onClick={() => setOpen(!open)}
      >
        <td>{open ? "▼" : "▶"}</td>
        <td className="nowrap">
          <b>{svc.name}</b>
        </td>
        <td className="nowrap">{svc.display_name}</td>
        <td className="nowrap mono" style={{ fontSize: "var(--fs-sm)" }}>
          {svc.version}
        </td>
        <td
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-xs)",
            maxWidth: 300,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {svc.endpoint}
        </td>
        <td style={{ fontSize: "var(--fs-sm)" }}>{permText}</td>
        <td>
          <span className="badge badge-blue">{tools.length}</span>
        </td>
        <td>
          <span
            className={`badge ${svc.status === "ACTIVE" ? "badge-green" : "badge-yellow"}`}
          >
            {svc.status}
          </span>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} style={{ background: "var(--bg-surface2)", padding: "var(--sp-3)" }}>
            {tools.length === 0 ? (
              <div style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>
                暂无可用工具 (服务未返回 tools/list)
              </div>
            ) : (
              <div style={{ display: "grid", gap: "var(--sp-1-5)" }}>
                {tools.map((t) => (
                  <div
                    key={t.name}
                    onClick={() => onPickTool(t)}
                    style={{
                      padding: "var(--sp-2) var(--sp-3)",
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-xs)",
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--primary)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--border)";
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: "var(--fs-base)", color: "var(--primary)" }}>
                      🔧 {t.name}
                    </div>
                    {t.description && (
                      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginTop: "var(--sp-1)" }}>
                        {t.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
