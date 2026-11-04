"use client";
import { t } from "@/i18n";
import type { PendingAgent } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";

/** 待审批注册表 (含授权业务勾选 + 审批/拒绝操作) */
export default function PendingApprovalsTable({
  agents,
  loading,
  services,
  selected,
  busyId,
  onRefresh,
  onToggleSvc,
  act,
  setError,
}: {
  agents: PendingAgent[];
  loading: boolean;
  services: Array<{ name: string }>;
  selected: Record<string, Record<string, boolean>>;
  busyId: string | null;
  onRefresh: () => void;
  onToggleSvc: (agentId: string, name: string) => void;
  act: (agentId: string, action: "approve" | "reject", services?: Array<{ name: string }>) => void;
  setError: (v: string) => void;
}) {
  const selectedSvcsOf = (agent_id: string): Array<{ name: string }> => {
    const map = selected[agent_id] || {};
    return Object.entries(map).filter(([, v]) => v).map(([name]) => ({ name }));
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">待审批注册 {loading && "(刷新中...)"}</span>
        <button className="btn" onClick={onRefresh} disabled={loading}>刷新</button>
      </div>
      {agents.length === 0 && !loading ? (
        <div style={{ padding: "var(--sp-7)", textAlign: "center", color: "var(--text-muted)" }}>
          暂无待审批注册。
          <div style={{ marginTop: "var(--sp-2)", fontSize: "var(--fs-base)" }}>{t('approvals.emptyHint')}</div>
        </div>
      ) : (
        <>
        <TableCopyButton />
        <table className="tbl">
          <thead><tr><th>{t('approvals.col.agent')}</th><th>渠道</th><th>终端</th><th>注册时间</th><th>{t('field.profile')}</th><th style={{ width: 320 }}>授权业务 + 操作</th></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.agent_id}>
                <td className="nowrap"><strong>{a.agent_id}</strong><div className="uid">{a.display_name}</div></td>
                <td>{a.channel}</td>
                <td className="nowrap"><code style={{ fontSize: "var(--fs-sm)" }}>{a.host}</code></td>
                <td className="time">{a.created_at ? new Date(a.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—"}</td>
                <td style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.profile ? JSON.stringify(a.profile).slice(0, 80) : "—"}</td>
                <td style={{ maxWidth: 320 }}>
                  <div style={{ marginBottom: "var(--sp-2)", fontSize: "var(--fs-sm)" }}>
                    <div style={{ color: "var(--text-dim)", marginBottom: "var(--sp-1)" }}>审批时勾选要授权的业务:</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-1) var(--sp-2-5)", maxHeight: 64, overflowY: "auto" }}>
                      {services.map((s) => (
                        <label key={s.name} style={{ display: "flex", alignItems: "center", gap: "var(--sp-0-5)", cursor: "pointer", whiteSpace: "nowrap" }}>
                          <input
                            type="checkbox"
                            checked={!!(selected[a.agent_id] || {})[s.name]}
                            onChange={() => onToggleSvc(a.agent_id, s.name)}
                          />
                          <span style={{ fontSize: "var(--fs-sm)" }}>{s.name.replace("lions_", "").replace("_", " ")}</span>
                        </label>
                      ))}
                      {services.length === 0 && <span style={{ color: "var(--text-muted)" }}>加载中...</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "var(--sp-1-5)", flexWrap: "wrap" }}>
                    <button
                      className="btn"
                      style={{ background: "var(--status-ok)", color: "var(--on-accent)", borderColor: "transparent" }}
                      disabled={busyId === a.agent_id}
                      onClick={() => {
                        const svcs = selectedSvcsOf(a.agent_id);
                        if (svcs.length === 0) {
                          setError(`请先勾选要给 ${a.agent_id} 授权的业务 (至少 1 个)`);
                          return;
                        }
                        if (confirm(`审批通过 ${a.agent_id}, 授权 ${svcs.length} 个业务: ${svcs.map((s) => s.name).join(", ")}?`)) {
                          act(a.agent_id, "approve", svcs);
                        }
                      }}
                    >
                      {busyId === a.agent_id ? "处理中..." : "✅ 审批通过"}
                    </button>
                    <button
                      className="btn"
                      style={{ color: "var(--status-crit)" }}
                      disabled={busyId === a.agent_id}
                      onClick={() => { if (confirm(`拒绝 ${a.agent_id} 的注册?`)) act(a.agent_id, "reject"); }}
                    >
                      拒绝
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </>
      )}
    </div>
  );
}
