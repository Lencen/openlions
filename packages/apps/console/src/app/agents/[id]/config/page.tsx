// [UI-S6 / 屏06 智能体详情 · 配置]
// 只读展示: 能力分级 + 业务服务授权矩阵 + 配额。真正改动权限仍走既有可编辑页(/agents/detail)。
import type { ReactNode } from "react";
import Link from "next/link";
import AgentShell from "../_components/AgentShell";
import AgentMissing from "../_components/AgentMissing";
import AgentSourceError from "../_components/AgentSourceError";
import { TIER_LABELS, fmtTime, loadAgent, loadLive, loadServices, parseJson, parseList } from "../_data";
import { Alert } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";

export const dynamic = "force-dynamic";

function kv(label: string, value: ReactNode) {
  return (
    <tr key={label}>
      <th style={{ width: 120 }}>{label}</th>
      <td>{value}</td>
    </tr>
  );
}

export default async function AgentConfigPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS, servicesS] = await Promise.all([loadAgent(id), loadLive(id), loadServices(id)]);
  if (!agentLoad.ok) return <AgentSourceError id={id} />;
  const agent = agentLoad.agent;
  const live = liveS.data;
  const services = servicesS.data;
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push("实时状态 /api/agents-live");
  if (!servicesS.ok) degraded.push("服务目录 /api/agent-services");
  if (!agent && !live) return <AgentMissing id={id} />;

  const profile = parseJson(agent?.profile);
  const tier = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;
  const quota = parseJson(profile.quota);
  const permByService: Record<string, any> = {};
  for (const p of agent?.permissions ?? []) permByService[p.service_name] = p;

  return (
    <AgentShell id={id} active="config" agent={agent} live={live}>
      {degraded.length ? <Alert type="warning" showIcon style={{ marginBottom: "var(--sp-4)" }} title="部分数据源降级" description={degraded.join("；")} /> : null}
      <div className="grid-2" style={{ marginBottom: "var(--sp-4)" }}>
        <div className="panel">
          <div className="panel-header"><span className="panel-title">能力分级</span></div>
          <TableCopyButton />
          <table className="tbl"><tbody>
            {kv("当前分级", tier != null ? TIER_LABELS[tier] : "-")}
            {kv("分级理由", profile.capabilityReason || "-")}
            {kv("设置来源", profile.capabilitySetBy || "-")}
            {kv("设置时间", <span className="mono" style={{ fontSize: "var(--fs-sm)" }}>{fmtTime(profile.capabilitySetAt)}</span>)}
            {kv("工具能力", profile.toolCapable ? "有工具" : "无工具")}
            {kv("常驻执行器", profile.persistentWorker ? "是" : "否")}
          </tbody></table>
        </div>

        <div className="panel">
          <div className="panel-header"><span className="panel-title">配额</span></div>
          <TableCopyButton />
          <table className="tbl"><tbody>
            {kv("每日上限", quota.dailyLimit != null ? String(quota.dailyLimit) : "-")}
            {kv("模式", quota.mode || "-")}
            {kv("设置来源", quota.setBy || "-")}
            {kv("设置时间", <span className="mono" style={{ fontSize: "var(--fs-sm)" }}>{fmtTime(quota.setAt)}</span>)}
            {kv("说明", quota.note || "-")}
          </tbody></table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">服务授权矩阵（{services.length} 个业务服务）</span>
          <Link
            href={`/agents/detail?id=${encodeURIComponent(agent?.agent_id || id)}`}
            style={{ color: "var(--primary)", fontSize: "var(--fs-base)", textDecoration: "none" }}
          >
            去调整权限
          </Link>
        </div>
        <TableCopyButton />
        <table className="tbl">
          <thead>
            <tr>
              <th>服务</th>
              <th>说明</th>
              <th style={{ width: 70 }}>版本</th>
              <th style={{ width: 90 }}>目录状态</th>
              <th>已授权权限</th>
              <th>可授权权限</th>
              <th style={{ width: 110 }}>密钥到期</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => {
              const perm = permByService[s.name];
              const granted = parseList(perm?.permissions);
              const available = parseList(s.available_perms);
              return (
                <tr key={s.name}>
                  <td style={{ fontWeight: 600 }}>{s.display_name || s.name}</td>
                  <td style={{ color: "var(--text-dim)" }}>{s.description || "-"}</td>
                  <td className="mono" style={{ fontSize: "var(--fs-sm)" }}>{s.version || "-"}</td>
                  <td>
                    <span className={s.status === "ACTIVE" ? "badge badge-green" : "badge"}>{s.status || "-"}</span>
                  </td>
                  <td>
                    {granted.length ? (
                      <span style={{ display: "inline-flex", gap: "var(--sp-1-5)", flexWrap: "wrap" }}>
                        {granted.map((g) => <span key={g} className="badge badge-blue">{g}</span>)}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>未授权</span>
                    )}
                  </td>
                  <td style={{ color: "var(--text-dim)", fontSize: "var(--fs-base)" }}>{available.join(" / ") || "-"}</td>
                  <td className="mono" style={{ fontSize: "var(--fs-sm)" }}>{fmtTime(perm?.expires_at)}</td>
                </tr>
              );
            })}
            {services.length === 0 && (
              <tr><td colSpan={7} style={{ padding: "var(--sp-4)", color: "var(--text-dim)", textAlign: "center" }}>服务目录暂不可用</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </AgentShell>
  );
}
