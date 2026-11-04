"use client";
import { actionInfo, detailOf, fmtTime } from "./shared";
import { t } from "@/i18n";
import type { AuditRow } from "./shared";
import TableCopyButton from "@/components/TableCopyButton";

/** 审批记录 / 操作日志 (长期保留) */
export default function ApprovalHistoryTable({
  history,
  onRefresh,
}: {
  history: AuditRow[];
  onRefresh: () => void;
}) {
  return (
    <div className="panel" style={{ marginTop: "var(--sp-4)" }}>
      <div className="panel-header">
        <span className="panel-title">审批记录 / 操作日志 (长期保留)</span>
        <button className="btn" onClick={onRefresh}>刷新</button>
      </div>
      {history.length === 0 ? (
        <div style={{ padding: "var(--sp-7)", textAlign: "center", color: "var(--text-muted)" }}>
          暂无操作记录。
          <div style={{ marginTop: "var(--sp-2)", fontSize: "var(--fs-base)" }}>智能体注册 / 审批 / 撤销 / 密钥重发都会在这里留痕，用于审计。</div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <TableCopyButton />
          <table className="tbl">
            <thead><tr><th style={{ width: 160 }}>时间</th><th>{t('common.agent')}</th><th>操作</th><th>执行方</th><th>详情</th></tr></thead>
            <tbody>
              {history.map((h) => {
                const info = actionInfo(h.action);
                return (
                  <tr key={h.id}>
                    <td className="time nowrap">{fmtTime(h.created_at)}</td>
                    <td className="nowrap"><strong>{h.entity_id}</strong></td>
                    <td className="nowrap">
                      <span style={{ color: info.color, fontWeight: 600 }}>{info.label}</span>
                      {h.actor_type === "backfill" && <div className="uid" style={{ fontSize: "var(--fs-sm)" }}>补录</div>}
                    </td>
                    <td className="nowrap">
                      {h.actor_type === "backfill" ? "—" : <><span>{h.actor || "—"}</span><div className="uid" style={{ fontSize: "var(--fs-sm)" }}>{h.actor_type === "admin_key" ? "console 管理员" : h.actor_type === "agent_self" ? "智能体自助" : h.actor_type || ""}</div></>}
                    </td>
                    <td style={{ fontSize: "var(--fs-base)", color: "var(--text-dim)" }}>{detailOf(h)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
