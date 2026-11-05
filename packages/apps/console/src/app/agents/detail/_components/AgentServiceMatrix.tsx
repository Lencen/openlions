"use client"
// 2026-11-05 P2 呈现层改造（批 4/5）：内联 style 清零 + 手写 .tbl 表 → 白名单 DataTable。
//   列仍为：业务服务 / 状态 / 权限 / 操作（含 130px 操作列）；勾选、保存、补发/取消授权等动作
//   与 confirm 文案一字未改；opMsg 的成功/失败配色改由 data-tone + 属性选择器承载。
import TableCopyButton from "@/components/TableCopyButton";
import { DetailSection } from "@/components/detail";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "../page.module.css";
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
  const columns: DataColumn<any>[] = [
    { key: "name", title: "业务服务", render: (s) => <span className="nowrap">{s.name}</span> },
    {
      key: "status",
      title: "状态",
      render: (s) => {
        const p = permMap[s.name];
        const active = !!p && p.status === "ACTIVE";
        const revoked = !!p && p.status === "REVOKED";
        return (
          <span className="nowrap">
            {active ? <span className="badge badge-green">已授权</span>
              : revoked ? <span className="badge badge-red">已取消</span>
              : <span className="badge">未授权</span>}
          </span>
        );
      },
    },
    {
      key: "perms",
      title: "权限",
      render: (s) => {
        const p = permMap[s.name];
        const active = !!p && p.status === "ACTIVE";
        if (!active) return <span className={styles.asmPermCell}>{s.available_perms || "-"}</span>;
        const avail = parseList(s.available_perms);
        const cur = parseList(p.permissions);
        const shown = avail.length ? avail : cur;
        const draftCur = draftOf(s.name, cur);
        const dirty = draftCur.slice().sort().join(",") !== cur.slice().sort().join(",");
        return (
          <div className={styles.asmPermCell}>
            <div className={styles.asmPerms}>
              {shown.map((perm: string) => (
                <label key={perm} className={styles.asmPermLabel}>
                  <input type="checkbox" checked={draftCur.includes(perm)} disabled={permBusy === s.name}
                    onChange={() => togglePerm(s.name, cur, perm)} />
                  <span className="mono">{perm}</span>
                </label>
              ))}
            </div>
            {dirty && (
              <div className={styles.asmSaveRow}>
                <button className={"btn " + styles.asmBtnSm} disabled={permBusy === s.name}
                  onClick={() => savePerms(s.name, cur)}>
                  {permBusy === s.name ? "保存中..." : "保存权限(不换 key)"}
                </button>
                <span className={styles.asmUnsaved}>未保存</span>
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "op",
      title: "操作",
      width: 130,
      render: (s) => {
        const p = permMap[s.name];
        const active = !!p && p.status === "ACTIVE";
        return (
          <span className="nowrap">
            {active ? (
              <button className={"btn " + styles.asmBtnSm + " " + styles.asmBtnDanger} disabled={busySvc === s.name}
                onClick={() => { if (confirm(`取消 ${me.agent_id || agentId} 对 ${s.name} 的授权？该智能体将立即失去访问密钥`)) actSvc(s.name, "revoke"); }}>
                {busySvc === s.name ? "..." : "取消授权"}
              </button>
            ) : (
              <button className={"btn " + styles.asmBtnSm} disabled={busySvc === s.name}
                onClick={() => { if (confirm(`给 ${me.agent_id || agentId} 补发 ${s.name} 业务密钥?`)) actSvc(s.name, "grant"); }}>
                {busySvc === s.name ? "..." : "补发授权"}
              </button>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <DetailSection title="业务授权矩阵">
      {opMsg && <div className={styles.asmOpMsg} data-tone={opMsg.startsWith("✅") ? "ok" : "crit"}>{opMsg}</div>}
      <TableCopyButton />
      {/* 2026-10-13 round 76-DY: 加载中 services 还是空数组 -> 原来会显示「暂无可用业务服务」(实测就绪后有数据) -> 假空态。
          换 DataTable 后由 loading 承担：加载中出骨架行，只有真的为空才出空态。 */}
      <DataTable
        columns={columns}
        rows={services}
        rowKey={(s) => s.name}
        loading={loading}
        empty={{ title: "暂无可用业务服务" }}
      />
      <div className={styles.asmLegend}>
        取消授权 = 该智能体立即失去此业务的访问密钥（保留审计记录）；补发授权 = 重新签发。<br />
        调整权限 = 勾选后点「保存权限」: <b>只改权限集合, 不换发密钥</b>, 在跑的客户端无需重启。
      </div>
    </DetailSection>
  );
}
