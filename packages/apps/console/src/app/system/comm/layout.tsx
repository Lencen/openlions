import FeatureGate from "@/components/FeatureGate";

// 2026-10-27（S2 门禁）：/system/comm 属收费面 macs.collab。
//   用 layout 包子树：以后加 /system/comm/* 子页自动受保护，不必逐页记得包。
//   **不门 MACS 进程内部面**——商业化线已把 MACS 直连定性为内部/管理面，另有加固，不在 UI 门范围。
export default function CommLayout({ children }: { children: React.ReactNode }) {
  return (
    <FeatureGate feature="macs.collab" label="协作">
      {children}
    </FeatureGate>
  );
}
