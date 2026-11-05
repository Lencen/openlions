"use client";
import { t } from "@/i18n";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";
import styles from "../page.module.css";

/** 面包屑 + 页头 + 错误提示 */
// 2026-10-13 round 76-CX: 加 loading —— 数据没回来时原来显示"共 0 待处理", 那是**假计数**
//   (与"真的 0 条待审批"无法区分)。加载中显示省略号。
export default function ApprovalsHeader({ agentCount, error, loading }: { agentCount: number; error: string; loading?: boolean }) {
  return (
    <>
      <div className="breadcrumb"><span className={styles.crumbDim}>{t('approvals.crumb')}</span><span className="sep">/</span><span className="current">接入审批</span></div>
      <PageHeader>
        <PageTitle>接入审批</PageTitle>
        <div className="page-subtitle">{t('approvals.subtitle', { n: loading ? "…" : agentCount })}</div>
      </PageHeader>
      {error && <div className={styles.err}>⚠ {error}</div>}
    </>
  );
}
