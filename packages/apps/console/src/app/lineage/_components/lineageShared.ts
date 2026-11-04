// lineage 页 · 共享常量 (从 page.tsx 抽出, 2026-09-14 页面瘦身)
// 纯常量, 无 user-visible 变化; 供多个子控件复用, 避免各自复制。
// 实体业务说法不再本地硬编码, 统一取 src/config/artifactTypes.ts (单一事实源)。
import { ARTIFACT_TYPES, artifactLabel } from "@/config/artifactTypes";

export const TABLE_COLOR: Record<string, string> = { Memory: "var(--table-memory)", Knowledge: "var(--table-knowledge)", Practice: "var(--table-practice)", Skill: "var(--table-skill)" };
export const TABLE_LABEL: Record<string, string> = Object.fromEntries(
  ARTIFACT_TYPES.map((x) => [x, artifactLabel(x)])
);

export const VERIFY_TAG: Record<string, { color: string; label: string }> = {
  PENDING_REVIEW: { color: "warning", label: "待人工复核" },
  PROPOSAL_ACCEPTED: { color: "processing", label: "提案已接受" },
  VERIFIED: { color: "success", label: "已验证" },
  REJECTED: { color: "error", label: "已驳回" },
};
