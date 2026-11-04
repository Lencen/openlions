// [UI-S6 / 屏06 智能体详情 · 概览]
// 服务端组件 (force-dynamic): curl 该路由 HTML 即含真实字段(显示名 / 角色 / 能力分级 / 配额 / 在办任务)。
// 数据来源见 ../_data.ts; 只读。
import type { ReactNode } from "react";
import KPICard from "@/components/KPICard";
import AgentShell from "../_components/AgentShell";
import AgentMissing from "../_components/AgentMissing";
import AgentSourceError from "../_components/AgentSourceError";
import { TIER_LABELS, fmtAgo, fmtTime, loadAgent, loadLive, parseJson } from "../_data";
import { Alert } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";

export const dynamic = "force-dynamic";

const CAP_ROWS: Array<[string, string]> = [
  ["tools", "工具"],
  ["db", "数据库"],
  ["file", "文件"],
  ["network", "网络"],
];

function kv(label: string, value: ReactNode) {
  return (
    <tr key={label}>
      <th style={{ width: 120 }}>{label}</th>
      <td>{value}</td>
    </tr>
  );
}

export default async function AgentOverviewPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS] = await Promise.all([loadAgent(id), loadLive(id)]);
  if (!agentLoad.ok) return <AgentSourceError id={id} />;
  const agent = agentLoad.agent;
  const live = liveS.data;
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push("实时状态 /api/agents-live");
  if (!agent && !live) return <AgentMissing id={id} />;

  const profile = parseJson(agent?.profile);
  const perms = agent?.permissions ?? [];
  const tier = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;
  const caps = parseJson(profile.capabilities);
  const quota = parseJson(profile.quota);
  const ts = live?.taskStats ?? {};
  const current = live?.currentTask ?? agent?.currentTask ?? null;
  const pending = live?.assignedPending ?? [];

  return (
    <AgentShell id={id} active="overview" agent={agent} live={live}>
      {degraded.length ? <Alert type="warning" showIcon style={{ marginBottom: "var(--sp-4)" }} title="部分数据源降级" description={degraded.join("；")} /> : null}
      <div className="kpi-grid">
        <KPICard label="已办任务" value={(ts.done ?? 0).toLocaleString()} />
        <KPICard label="在办任务" value={(ts.running ?? 0).toLocaleString()} />
        <KPICard label="待开始任务" value={(ts.pending ?? 0).toLocaleString()} />
        <KPICard label="产出质量" value={live?.outputQuality != null ? `${Math.round(Number(live.outputQuality) * 100)}%` : "-"} />
        <KPICard label="近 24 小时消息" value={(live?.macsMessages24h ?? 0).toLocaleString()} />
        <KPICard label="已授权服务" value={perms.length.toLocaleString()} />
      </div>

      <div className="grid-2" style={{ marginBottom: "var(--sp-4)" }}>
        <div className="panel">
          <div className="panel-header"><span className="panel-title">基础信息</span></div>
          <TableCopyButton />
          <table className="tbl"><tbody>
            {kv("智能体编号", <span className="mono">{agent?.agent_id || id}</span>)}
            {kv("显示名", agent?.display_name || "-")}
            {kv("角色", live?.roleLabel || agent?.role || "-")}
            {kv("接入通道", agent?.channel || live?.channel || "-")}
            {kv("主机", agent?.host || live?.host || "-")}
            {kv("注册状态", <span className="badge badge-blue">{live?.registryStatus || agent?.status || "-"}</span>)}
            {kv("当前状态", live?.stateLabel || "-")}
            {kv("创建时间", <span className="mono" style={{ fontSize: "var(--fs-sm)" }}>{fmtTime(agent?.created_at)}</span>)}
            {kv("最近更新", <span className="mono" style={{ fontSize: "var(--fs-sm)" }}>{fmtTime(agent?.updated_at)}</span>)}
            {kv("最近露面", `${fmtTime(agent?.last_seen_at || live?.lastSeenAt)}（${fmtAgo(agent?.last_seen_at || live?.lastSeenAt)}）`)}
          </tbody></table>
        </div>

        <div className="panel">
          <div className="panel-header"><span className="panel-title">能力与配额</span></div>
          <TableCopyButton />
          <table className="tbl"><tbody>
            {kv("能力分级", tier != null ? TIER_LABELS[tier] : "-")}
            {kv("分级理由", profile.capabilityReason || "-")}
            {kv("模型", profile.model || "-")}
            {kv("运行方式", profile.driver || "-")}
            {kv("负责人", profile.owner || "-")}
            {kv("每日上限", quota.dailyLimit != null ? String(quota.dailyLimit) : "-")}
            {kv("配额模式", quota.mode || "-")}
            {kv("能力清单", (
              <span style={{ display: "inline-flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
                {CAP_ROWS.map(([key, label]) => (
                  <span key={key} className={caps[key] ? "badge badge-green" : "badge"}>
                    {label} {caps[key] ? "可用" : "不可用"}
                  </span>
                ))}
              </span>
            ))}
          </tbody></table>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: "var(--sp-4)" }}>
        <div className="panel-header"><span className="panel-title">当前任务</span></div>
        {current ? (
          <table className="tbl"><tbody>
            {kv("任务", current.title || current.id)}
            {kv("状态", <span className="badge badge-yellow">{current.status || "-"}</span>)}
            {kv("优先级", current.priority || "-")}
            {kv("主题", current.theme || "-")}
            {kv("静默时长", current.idleMin != null ? `${current.idleMin} 分钟` : "-")}
          </tbody></table>
        ) : (
          <div style={{ padding: "var(--sp-4)", color: "var(--text-dim)" }}>当前没有在办任务。</div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">待开始任务（{(live?.assignedPendingCount ?? pending.length).toLocaleString()}）</span>
        </div>
        <TableCopyButton />
        <table className="tbl">
          <thead><tr><th>任务</th><th style={{ width: 90 }}>优先级</th><th style={{ width: 130 }}>改进类型</th></tr></thead>
          <tbody>
            {pending.slice(0, 10).map((t) => (
              <tr key={t.id}>
                <td>{t.title || t.id}</td>
                <td>{t.priority || "-"}</td>
                <td>{t.improvementType || "-"}</td>
              </tr>
            ))}
            {pending.length === 0 && (
              <tr><td colSpan={3} style={{ padding: "var(--sp-4)", color: "var(--text-dim)", textAlign: "center" }}>没有待开始任务</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </AgentShell>
  );
}
