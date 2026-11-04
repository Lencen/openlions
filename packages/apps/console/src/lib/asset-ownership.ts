// 2026-10-26 R4/R5：资产归属展示的唯一判据（记忆 / 知识 / 技能 / 实践共用）
// 契约：docs/practices/2026-10-25-admin-ui-redesign-plan.md §9（已冻结）
//   ① 响应里没有 ownerAgentId / visibility 键 → 「未启用」：不显示假列；
//   ② 有键但 ownerAgentId = null → 归属「未归属」，可见性「公共（存量）」
//      —— L1 规则「ownerAgentId IS NULL 一律可读，与 visibility 无关」，
//      照 visibility='private' 显示成「私有」会让 10 万存量行看起来被私有化（契约明确禁止）；
//   ③ 有键有值 → 归属 agent 名，可见性 私有/共享/全局。
//   颜色为零：归属与可见性都是事实，不是状态。
const VIS_LABEL: Record<string, string> = { private: "私有", shared: "共享", global: "全局" };

/** 该行是否带有归属字段（能力探测，不做版本号比对） */
export function hasOwnership(row: any): boolean {
  if (!row) return false;
  return Object.prototype.hasOwnProperty.call(row, "ownerAgentId")
    || Object.prototype.hasOwnProperty.call(row, "visibility")
    || Object.prototype.hasOwnProperty.call(row, "memoryScope");
}

/** 归属列文案 */
export function ownerLabel(row: any): string {
  if (!hasOwnership(row)) return "未启用";
  return row.ownerAgentId ? String(row.ownerAgentId) : "未归属";
}

/** 可见性列文案（含 L1：无主一律公共） */
export function visibilityLabel(row: any): string {
  if (!hasOwnership(row)) return "—";
  if (!row.ownerAgentId) return "公共（存量）";
  const v = String(row.visibility ?? row.memoryScope ?? "").toLowerCase();
  return VIS_LABEL[v] || (v ? v : "—");
}

/**
 * 资产可见性提示条（契约 2026-10-26 更新：meta 现在是 { scope, enforced, filtered, admin, actor }，
 * `scope` 仅作兼容保留，判断顺序 **admin → enforced → filtered → scope**）。
 * 原则：fail-open，不隐藏数据，只把"这次为什么看到这些行"讲清楚。
 */
export function scopeOffNotice(meta: any): string | null {
  if (!meta) return null;
  if (meta.admin === true) return "管理员全量视图：不做归属过滤，可见全部资产";
  if (meta.enforced === false) return "归属过滤未启用（灰度关闭）：当前按全量展示，不代表权限";
  if (meta.filtered === true) return "已按资产可见性策略过滤：仅显示当前身份可见的资产";
  if (String(meta.scope || "").toLowerCase() === "off") return "资产归属未启用（scope=off）：当前按全量展示";
  return null;
}
