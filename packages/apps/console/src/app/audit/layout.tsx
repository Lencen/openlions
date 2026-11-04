import FeatureGate from "@/components/FeatureGate";

// 2026-10-27（S2 门禁）：/audit 与 /audit/* 属 security.audit。
//   用 layout 包住整棵子树 —— 比逐页包一层不易漏（新增审计子页自动受门保护）。
//   **不包 /system/access-log**（另一条安全面，按商业化线要求本轮不动）。
export default function AuditLayout({ children }: { children: React.ReactNode }) {
  return (
    <FeatureGate feature="security.audit" label="审计">
      {children}
    </FeatureGate>
  );
}
