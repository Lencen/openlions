"use client";
// 2026-09-14 页面瘦身: 接入审批页共享类型 / 展示小工具。
import { statusLabel } from "@/config/systemLabels";
import { t } from "@/i18n";

export interface PendingAgent {
  agent_id: string; display_name: string; channel: string; host: string;
  profile: any; created_at: string; has_key: boolean;
}

export interface AuditRow {
  id: string; entity_type: string; entity_id: string; action: string;
  actor: string | null; actor_type: string | null;
  before: any; after: any; metadata: any; created_at: string;
}

export const ACTION_LABEL: Record<string, { label: string; color: string }> = {
  REGISTER_REQUEST: { label: "自助注册请求", color: "var(--text-dim)" },
  REGISTER_ACTIVE: { label: "注册激活", color: "var(--status-ok)" },
  APPROVE: { label: "审批通过", color: "var(--status-ok)" },
  REJECT: { label: "审批拒绝", color: "var(--status-crit)" },
  REVOKE: { label: "撤销接入", color: "var(--status-crit)" },
  GRANT_API_KEY: { label: "重发密钥", color: "var(--status-warn, #b45309)" },
  GRANT_SERVICE: { label: "授权业务", color: "var(--status-ok)" },
  REVOKE_SERVICE: { label: "取消业务授权", color: "var(--status-crit)" },
};
export function actionInfo(a: string) {
  return ACTION_LABEL[a] || { label: a, color: "var(--text-dim)" };
}
export function fmtTime(t?: string) {
  if (!t) return "—";
  const d = new Date(t);
  return isNaN(d.getTime()) ? t : d.toLocaleString("zh-CN");
}
export function detailOf(r: AuditRow): string {
  if (r.action === "APPROVE") {
    const svcs = r.after?.services_granted;
    return svcs && Array.isArray(svcs) ? `发密钥 ${svcs.length} 个服务: ${svcs.join(", ")}` : "发密钥 (全部服务)";
  }
  if (r.action === "REGISTER_REQUEST") return `${r.after?.channel || ""} @ ${r.after?.host || "?"} 待审批`;
  if (r.action === "REGISTER_ACTIVE") {
    const svcs = r.after?.services;
    return svcs && Array.isArray(svcs) ? `注册 ${svcs.length} 个服务` : "注册成功";
  }
  if (r.action === "REJECT") return "注册被拒绝";
  if (r.action === "REVOKE") return `撤销 ${r.after?.perms_revoked ?? "?"} 个服务凭证`;
  if (r.action === "GRANT_API_KEY") return `${r.after?.service_name || ""} (重发)`;
  if (r.action === "GRANT_SERVICE") return `授权 ${r.after?.service_name || ""} (${statusLabel(r.after?.status) || t('status.active')})`;
  if (r.action === "REVOKE_SERVICE") return `取消 ${r.before?.service_name || ""} → ${statusLabel(r.after?.status) || t('status.revoked')}`;
  return r.metadata ? JSON.stringify(r.metadata).slice(0, 80) : "";
}
