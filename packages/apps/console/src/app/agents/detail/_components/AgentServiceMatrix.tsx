"use client"
import TableCopyButton from "@/components/TableCopyButton";
import { DetailSection } from "@/components/detail";
// agents/detail 页 · 业务授权矩阵面板 (从 page.tsx 抽出)
export default function AgentServiceMatrix({
  loading,
  services,
  permMap,
  parseList,
  draftOf,
  togglePerm,
  savePerms,
  actSvc,
  busySvc,
  permBusy,
  opMsg,
  me,
  agentId,
}: {
  /** 2026-10-13 round 76-DY: 区分「还没加载」与「确实没有可用业务」。 */
  loading?: boolean;
  services: any[];
  permMap: Record<string, any>;
  parseList: (v: any) => string[];
  draftOf: (name: string, current: string[]) => string[];
  togglePerm: (name: string, current: string[], p: string) => void;
  savePerms: (name: string, current: string[]) => void;
  actSvc: (service_name: string, action: "grant" | "revoke") => void;
  busySvc: string | null;
  permBusy: string | null;
  opMsg: string;
  me: any;
  agentId: string;
}) {
  return (
    <DetailSection title="业务授权矩阵">
      {opMsg && <div style={{ fontSize: "var(--fs-base)", marginBottom: "var(--sp-2)", color: opMsg.startsWith("✅") ? "var(--status-ok)" : "var(--status-crit)" }}>{opMsg}</div>}
      <TableCopyButton />
      <table className="tbl"><thead><tr><th>业务服务</th><th>状态</th><th>权限</th><th style={{ width: 130 }}>操作</th></tr></thead><tbody>
        {services.map((s: any) => {
          const p = permMap[s.name];
          const active = !!p && p.status === "ACTIVE";
          const revoked = !!p && p.status === "REVOKED";
          return (
            <tr key={s.name}>
              <td className="nowrap">{s.name}</td>
              <td className="nowrap">
                {active ? <span className="badge badge-green">已授权</span>
                  : revoked ? <span className="badge badge-red">已取消</span>
                  : <span className="badge">未授权</span>}
              </td>
              <td style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", maxWidth: 300 }}>
                {active ? (() => {
                  const avail = parseList(s.available_perms);
                  const cur = parseList(p.permissions);
                  const shown = avail.length ? avail : cur;
                  const draftCur = draftOf(s.name, cur);
                  const dirty = draftCur.slice().sort().join(",") !== cur.slice().sort().join(",");
                  return (
                    <div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
                        {shown.map((perm: string) => (
                          <label key={perm} style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-0-5)", cursor: "pointer" }}>
                            <input type="checkbox" checked={draftCur.includes(perm)} disabled={permBusy === s.name}
                              onChange={() => togglePerm(s.name, cur, perm)} />
                            <span className="mono">{perm}</span>
                          </label>
                        ))}
                      </div>
                      {dirty && (
                        <div style={{ marginTop: "var(--sp-1)" }}>
                          <button className="btn" style={{ fontSize: "var(--fs-sm)", padding: "var(--sp-0-5) var(--sp-2)" }} disabled={permBusy === s.name}
                            onClick={() => savePerms(s.name, cur)}>
                            {permBusy === s.name ? "保存中..." : "保存权限(不换 key)"}
                          </button>
                          <span style={{ marginLeft: "var(--sp-1-5)", color: "var(--status-warn, #d48806)" }}>未保存</span>
                        </div>
                      )}
                    </div>
                  );
                })() : (s.available_perms || "-")}
              </td>
              <td className="nowrap">
                {active ? (
                  <button className="btn" style={{ color: "var(--status-crit)", fontSize: "var(--fs-sm)", padding: "var(--sp-0-5) var(--sp-2)" }} disabled={busySvc === s.name}
                    onClick={() => { if (confirm(`取消 ${me.agent_id || agentId} 对 ${s.name} 的授权？该智能体将立即失去访问密钥`)) actSvc(s.name, "revoke"); }}>
                    {busySvc === s.name ? "..." : "取消授权"}
                  </button>
                ) : (
                  <button className="btn" style={{ fontSize: "var(--fs-sm)", padding: "var(--sp-0-5) var(--sp-2)" }} disabled={busySvc === s.name}
                    onClick={() => { if (confirm(`给 ${me.agent_id || agentId} 补发 ${s.name} 业务密钥?`)) actSvc(s.name, "grant"); }}>
                    {busySvc === s.name ? "..." : "补发授权"}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
        {/* 2026-10-13 round 76-DY: 加载中 services 还是空数组 -> 显示「暂无可用业务服务」(实测就绪后有数据) -> 假空态。 */}
        {loading ? <tr><td colSpan={4} style={{ color: "var(--text-muted)" }}>…</td></tr> : services.length === 0 && <tr><td colSpan={4} style={{ color: "var(--text-muted)" }}>暂无可用业务服务</td></tr>}
      </tbody></table>
      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-dim)", marginTop: "var(--sp-1-5)" }}>
        取消授权 = 该智能体立即失去此业务的访问密钥（保留审计记录）；补发授权 = 重新签发。<br />
        调整权限 = 勾选后点「保存权限」: <b>只改权限集合, 不换发密钥</b>, 在跑的客户端无需重启。
      </div>
    </DetailSection>
  );
}
