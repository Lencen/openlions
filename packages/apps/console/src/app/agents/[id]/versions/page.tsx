// [UI-S6 / 屏06 智能体详情 · 版本]
// 服务端渲染: 名册/画像/授权的时间线 (注册、最近更新、能力分级、配额、密钥到期) + 画像字段快照。
import type { ReactNode } from "react";
import AgentShell from "../_components/AgentShell";
import AgentMissing from "../_components/AgentMissing";
import AgentSourceError from "../_components/AgentSourceError";
import { TIER_LABELS, fmtTime, loadAgent, loadLive, parseJson } from "../_data";
import { Alert } from "@/components/primitives";
import TableCopyButton from "@/components/TableCopyButton";

export const dynamic = "force-dynamic";

interface ChangeRow {
  at: string | number | null;
  topic: string;
  detail: ReactNode;
}

function ts(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : 0;
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "-";
    }
  }
  return String(v);
}

export default async function AgentVersionsPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id || "");
  const [agentLoad, liveS] = await Promise.all([loadAgent(id), loadLive(id)]);
  if (!agentLoad.ok) return <AgentSourceError id={id} />;
  const agent = agentLoad.agent;
  const live = liveS.data;
  const degraded: string[] = [];
  if (!liveS.ok) degraded.push("实时状态 /api/agents-live");
  if (!agent && !live) return <AgentMissing id={id} />;

  const profile = parseJson(agent?.profile);
  const quota = parseJson(profile.quota);
  const tier = typeof profile.capabilityTier === "number" ? profile.capabilityTier : null;

  const changes: ChangeRow[] = [];
  const push = (at: unknown, topic: string, detail: ReactNode) => {
    if (at == null || at === "") return;
    changes.push({ at: at as string | number, topic, detail });
  };
  push(agent?.created_at, "登记注册", "智能体首次进入名册");
  push(profile.capabilitySetAt, "能力分级设置", `${tier != null ? TIER_LABELS[tier] : "-"}（${profile.capabilitySetBy || "未知来源"}）`);
  push(quota.setAt, "配额设置", `每日上限 ${quota.dailyLimit ?? "-"} · ${quota.mode || "-"}`);
  push(agent?.updated_at, "最近更新", "名册记录最近一次变更");
  push(agent?.last_seen_at, "最近露面", "最近一次心跳/上报时间");
  for (const p of agent?.permissions ?? []) {
    push(p.expires_at, "服务密钥到期", `${p.service_name} 的授权密钥到期`);
  }
  changes.sort((a, b) => ts(b.at) - ts(a.at));

  const profileKeys = Object.keys(profile);

  return (
    <AgentShell id={id} active="versions" agent={agent} live={live}>
      {degraded.length ? <Alert type="warning" showIcon style={{ marginBottom: "var(--sp-4)" }} title="部分数据源降级" description={degraded.join("；")} /> : null}
      <div className="panel" style={{ marginBottom: "var(--sp-4)" }}>
        <div className="panel-header"><span className="panel-title">变更时间线（{changes.length} 项）</span></div>
        <TableCopyButton />
        <table className="tbl">
          <thead><tr><th style={{ width: 160 }}>时间</th><th style={{ width: 160 }}>事项</th><th>说明</th></tr></thead>
          <tbody>
            {changes.map((c, i) => (
              <tr key={i}>
                <td className="mono" style={{ fontSize: "var(--fs-sm)" }}>{fmtTime(c.at)}</td>
                <td style={{ fontWeight: 600 }}>{c.topic}</td>
                <td style={{ color: "var(--text-dim)" }}>{c.detail}</td>
              </tr>
            ))}
            {changes.length === 0 && (
              <tr><td colSpan={3} style={{ padding: "var(--sp-4)", color: "var(--text-dim)", textAlign: "center" }}>暂无可展示的变更记录</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-header"><span className="panel-title">画像字段快照（{profileKeys.length} 项）</span></div>
        <TableCopyButton />
        <table className="tbl">
          <thead><tr><th style={{ width: 220 }}>字段</th><th>取值</th></tr></thead>
          <tbody>
            {profileKeys.map((k) => (
              <tr key={k}>
                <td className="mono" style={{ fontSize: "var(--fs-sm)" }}>{k}</td>
                <td className="mono" style={{ fontSize: "var(--fs-sm)", wordBreak: "break-all" }}>{renderValue(profile[k])}</td>
              </tr>
            ))}
            {profileKeys.length === 0 && (
              <tr><td colSpan={2} style={{ padding: "var(--sp-4)", color: "var(--text-dim)", textAlign: "center" }}>该智能体没有登记画像</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </AgentShell>
  );
}
