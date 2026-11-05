"use client";
// 2026-11-05 P2 呈现层（批 4/5）：内联 style 清零 + 手写 .tbl 表 → 白名单 DataTable。
//   列与表头不变（智能体 / 渠道 / 终端 / 注册时间 / 档案 / 授权业务 + 操作，末列 320）；
//   审批、拒绝、勾选授权的逻辑与 confirm 文案一字未改；空态仍保留「暂无待审批注册。」+ 提示。
import { t } from "@/i18n";
import type { PendingAgent } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "../page.module.css";

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

  // 列定义：与改前 <thead> 逐列对应（末列「授权业务 + 操作」保持 320 宽）
  const columns: DataColumn<PendingAgent>[] = [
    {
      key: "agent_id", title: t('approvals.col.agent'),
      render: (a) => (
        <span className="nowrap">
          <strong>{a.agent_id}</strong>
          <div className={styles.patSub}>{a.display_name}</div>
        </span>
      ),
    },
    { key: "channel", title: "渠道", render: (a) => a.channel },
    { key: "host", title: "终端", render: (a) => <span className="nowrap"><code className={styles.patSm}>{a.host}</code></span> },
    {
      key: "created_at", title: "注册时间",
      render: (a) => <span className="mono">{a.created_at ? new Date(a.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—"}</span>,
    },
    {
      key: "profile", title: t('field.profile'),
      render: (a) => <span className={styles.patProfile}>{a.profile ? JSON.stringify(a.profile).slice(0, 80) : "—"}</span>,
    },
    {
      key: "auth", title: "授权业务 + 操作", width: 320,
      render: (a) => (
        <div className={styles.patAuthCell}>
          <div className={styles.patAuthBlock}>
            <div className={styles.patAuthHint}>审批时勾选要授权的业务:</div>
            <div className={styles.patSvcList}>
              {services.map((s) => (
                <label key={s.name} className={styles.patSvcItem}>
                  <input
                    type="checkbox"
                    checked={!!(selected[a.agent_id] || {})[s.name]}
                    onChange={() => onToggleSvc(a.agent_id, s.name)}
                  />
                  <span className={styles.patSm}>{s.name.replace("lions_", "").replace("_", " ")}</span>
                </label>
              ))}
              {services.length === 0 && <span className={styles.patMuted}>加载中...</span>}
            </div>
          </div>
          <div className={styles.patActRow}>
            <button
              className={"btn " + styles.patApprove}
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
              className={"btn " + styles.patReject}
              disabled={busyId === a.agent_id}
              onClick={() => { if (confirm(`拒绝 ${a.agent_id} 的注册?`)) act(a.agent_id, "reject"); }}
            >
              拒绝
            </button>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">待审批注册 {loading && "(刷新中...)"}</span>
        <button className="btn" onClick={onRefresh} disabled={loading}>刷新</button>
      </div>
      {agents.length === 0 && !loading ? (
        <div className={styles.patEmpty}>
          暂无待审批注册。
          <div className={styles.patEmptyHint}>{t('approvals.emptyHint')}</div>
        </div>
      ) : (
        <>
        <TableCopyButton />
        <DataTable
          columns={columns}
          rows={agents}
          rowKey={(a) => a.agent_id}
          loading={loading && agents.length === 0}
          empty={{ title: "暂无待审批注册。" }}
        />
        </>
      )}
    </div>
  );
}
