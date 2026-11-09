"use client";
// 2026-11-05 P2 批9：内联 style 清零（9 -> 0）+ 手写 tbl 表格清零（1 -> 0）。
//   表格改走白名单 @/components/DataTable：列与表头逐条对应（时间 160 / 智能体 / 操作 / 执行方 / 详情）；
//   操作名的动态色（shared.ts 里是 CSS 变量字符串）改为 [data-tone] 属性选择器；
//   时间 / 执行方 / 详情列的原内联字号与弱化色下沉到 ApprovalHistoryTable.module.css。
//   空态文案、刷新按钮、取数（history 入参）与导出 props 形状未动。
import { actionInfo, detailOf, fmtTime } from "./shared";
import { t } from "@/i18n";
import type { AuditRow } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";
import DataTable from "@/components/DataTable";
import type { DataColumn } from "@/components/DataTable";
import styles from "./ApprovalHistoryTable.module.css";

/** shared.ts 的操作色（CSS 变量字符串）-> data-tone 档位；未知动作在 actionInfo 里已回退成 text-dim。 */
const TONE_BY_COLOR: Record<string, string> = {
  "var(--status-ok)": "ok",
  "var(--status-crit)": "crit",
  "var(--status-warn, #b45309)": "warn",
  "var(--text-dim)": "dim",
};

/** 审批记录 / 操作日志 (长期保留) */
export default function ApprovalHistoryTable({
  history,
  onRefresh,
}: {
  history: AuditRow[];
  onRefresh: () => void;
}) {
  // 列定义：与改前表头逐列对应（时间列宽 160）
  const columns: DataColumn<AuditRow>[] = [
    {
      key: "created_at", title: "时间", width: 160,
      render: (h) => <span className="nowrap">{fmtTime(h.created_at)}</span>,
    },
    {
      key: "entity_id", title: t('common.agent'),
      render: (h) => <strong className="nowrap">{h.entity_id}</strong>,
    },
    {
      key: "action", title: "操作",
      render: (h) => {
        const info = actionInfo(h.action);
        return (
          <>
            <span className={"nowrap " + styles.actionLabel} data-tone={TONE_BY_COLOR[info.color] || "dim"}>{info.label}</span>
            {h.actor_type === "backfill" && <div className={"nowrap " + styles.sub}>补录</div>}
          </>
        );
      },
    },
    {
      key: "actor", title: "执行方",
      render: (h) =>
        h.actor_type === "backfill" ? "—" : (
          <>
            <span className="nowrap">{h.actor || "—"}</span>
            <div className={"nowrap " + styles.sub}>{h.actor_type === "admin_key" ? "console 管理员" : h.actor_type === "agent_self" ? "智能体自助" : h.actor_type || ""}</div>
          </>
        ),
    },
    { key: "detail", title: "详情", render: (h) => <span className={styles.detail}>{detailOf(h)}</span> },
  ];

  return (
    <div className={"panel " + styles.panelTop}>
      <div className="panel-header">
        <span className="panel-title">审批记录 / 操作日志 (长期保留)</span>
        <button className="btn" onClick={onRefresh}>刷新</button>
      </div>
      {history.length === 0 ? (
        <div className={styles.empty}>
          暂无操作记录。
          <div className={styles.emptyHint}>智能体注册 / 审批 / 撤销 / 密钥重发都会在这里留痕，用于审计。</div>
        </div>
      ) : (
        <>
          <TableCopyButton />
          <DataTable columns={columns} rows={history} rowKey={(h) => h.id} empty={{ title: "暂无操作记录。" }} />
        </>
      )}
    </div>
  );
}
