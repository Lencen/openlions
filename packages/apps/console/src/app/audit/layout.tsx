import FeatureGate from "@/components/FeatureGate";
import { PageHeader, PageTitle } from "@/components/ui/PageHeader";

// 2026-10-27（S2 门禁）：/audit 与 /audit/* 属 security.audit。
//   用 layout 包住整棵子树 —— 比逐页包一层不易漏（新增审计子页自动受门保护）。
//   **不包 /system/access-log**（另一条安全面，按商业化线要求本轮不动）。
//
// 2026-11-06 D-03：门禁在 loading 时返回骨架，导致整棵 /audit 的 SSR 首屏**连页头都没有**
//   （实测 0.4.30 的 /audit/daily-summary HTML：无 main、无 page-header，只有 ui-skel）。
//   这里给门禁传一个"放行前页头"：面包屑 + 标题「审计」；放行后由各页自己的页头接管（不会重复）。
//   为什么不用各页自己的页头：layout 拿不到子页标题，而把标题下沉到 layout 会与各页页头打架。
function AuditGateHeader() {
  return (
    <>
      <div className="breadcrumb">
        <span>服务</span>
        <span className="sep">/</span>
        <span className="current">审计</span>
      </div>
      <PageHeader>
        <PageTitle>审计</PageTitle>
        <div className="page-subtitle">操作与变更审计</div>
      </PageHeader>
    </>
  );
}

export default function AuditLayout({ children }: { children: React.ReactNode }) {
  return (
    <FeatureGate feature="security.audit" label="审计" header={<AuditGateHeader />}>
      {children}
    </FeatureGate>
  );
}
