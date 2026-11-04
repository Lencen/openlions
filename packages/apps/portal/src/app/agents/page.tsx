"use client";
import { useEffect, useState } from "react";

interface Agent {
  agent_id: string;
  display_name: string;
  channel: string;
  host: string;
  status: string;
  online: boolean;
  last_seen_at: string | null;
  profile: Record<string, unknown> | null;
}

interface Resp {
  total: number;
  active: number;
  online: number;
  agents: Agent[];
}

// 2026-10-19: Profile 列原先直接把原始对象 JSON.stringify 塞进单元格(技术自嗨挤首屏)。
//   改为**人话摘要**: 能力等级 + 已开通权限 + 日配额; 原始原因(capabilityReason)放 title 悬停可见。
const TIER_LABEL: Record<number, string> = { 1: "只读", 2: "受限", 3: "完整" };
const CAP_LABEL: Array<[string, string]> = [["tools", "工具"], ["db", "数据库"], ["file", "文件"], ["network", "网络"]];

export default function AgentsPage() {
  const [data, setData] = useState<Resp | null>(null);

  useEffect(() => {
    fetch("/api/portal/agents").then((r) => r.json()).then(setData).catch(() => {});
  }, []);

  return (
    <main className="main" style={{ marginLeft: 0, padding: "28px 32px", maxWidth: 1080 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Agent 生态</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>已接入平台的 Agent 及其运行状态</p>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(0, 160px))" }}>
        <div className="kpi-card">
          <span className="kpi-label">注册总数</span>
          <span className="kpi-value">{data?.total ?? "–"}</span>
          <span className="kpi-delta">AgentRegistry</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">活跃</span>
          <span className="kpi-value">{data?.active ?? "–"}</span>
          <span className="kpi-delta up">ACTIVE</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">当前在线</span>
          <span className="kpi-value">{data?.online ?? "–"}</span>
          <span className="kpi-delta up">5min 内活跃</span>
        </div>
      </div>

      <div className="panel">
        <table className="tbl">
          <thead>
            <tr>
              <th>Agent</th><th>显示名</th><th>渠道</th><th>接入位置</th>
              <th>状态</th><th>在线</th><th>最近活跃</th><th>能力</th>
            </tr>
          </thead>
          <tbody>
            {(data?.agents ?? []).map((a) => (
              <tr key={a.agent_id}>
                <td className="nowrap"><code style={{ fontSize: 11 }}>{a.agent_id}</code></td>
                <td className="nowrap"><strong>{a.display_name}</strong></td>
                <td className="nowrap">{a.channel}</td>
                <td className="nowrap">{a.host ? "内部接入" : "–"}</td>
                <td><span className={"badge " + (a.status === "ACTIVE" ? "badge-green" : "badge-red")}>{a.status}</span></td>
                <td><span className={"badge " + (a.online ? "badge-green" : "badge")}>{a.online ? "在线" : "离线"}</span></td>
                <td className="nowrap">{a.last_seen_at ? new Date(a.last_seen_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "–"}</td>
                <td>
                  {a.profile ? (() => {
                    const p = a.profile as any;
                    const tier = Number(p.capabilityTier);
                    const caps = (p.capabilities || {}) as Record<string, unknown>;
                    const quota = p.quota as any;
                    return (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }} title={String(p.capabilityReason || "")}>
                        <span className={"badge " + (tier >= 3 ? "badge-green" : tier === 2 ? "badge-blue" : "")}>
                          {isNaN(tier) ? "能力 –" : "等级 " + tier + (TIER_LABEL[tier] ? " · " + TIER_LABEL[tier] : "")}
                        </span>
                        {CAP_LABEL.filter(([k]) => caps[k]).map(([k, label]) => (
                          <span key={k} className="badge" style={{ background: "var(--bg-surface)", color: "var(--text-muted)", fontSize: 10 }}>{label}</span>
                        ))}
                        {quota && quota.dailyLimit ? (
                          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{quota.dailyLimit}/日</span>
                        ) : null}
                      </span>
                    );
                  })() : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(data?.agents ?? []).length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>暂无 Agent 数据</div>
        )}
      </div>
    </main>
  );
}
