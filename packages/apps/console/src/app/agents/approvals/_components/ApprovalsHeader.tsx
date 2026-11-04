"use client";
import { t } from "@/i18n";

/** 面包屑 + 页头 + 错误提示 */
// 2026-10-13 round 76-CX: 加 loading —— 数据没回来时原来显示"共 0 待处理", 那是**假计数**
//   (与"真的 0 条待审批"无法区分)。加载中显示省略号。
export default function ApprovalsHeader({ agentCount, error, loading }: { agentCount: number; error: string; loading?: boolean }) {
  return (
    <>
      <div className="breadcrumb"><span style={{ color: "var(--text-dim)" }}>{t('approvals.crumb')}</span><span className="sep">/</span><span className="current">接入审批</span></div>
      <div className="page-header">
        <div className="page-title">接入审批</div>
        <div className="page-subtitle">{t('approvals.subtitle', { n: loading ? "…" : agentCount })}</div>
      </div>
      {error && <div style={{ color: "var(--status-crit)", marginBottom: "var(--sp-3)" }}>⚠ {error}</div>}
    </>
  );
}
